import assert from "node:assert/strict";
import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { HarnessError } from "../../src/errors.js";
import type { ModelTurn } from "../../src/model.js";
import { SessionManager } from "../../src/session/manager.js";
import { SessionStore, processAlive } from "../../src/session/store.js";
import { temporaryWorkspace } from "../support/workspace.js";

const agent = { maxIterations: 4, model: async (): Promise<ModelTurn> => ({
	message: { role: "assistant", content: "Saved history" }, toolCalls: [],
}) };
const code = (expected: string) => (error: unknown) => error instanceof HarnessError && error.code === expected;

function nextMessage(child: ChildProcess, type: string): Promise<Record<string, unknown>> {
	return new Promise((resolve, reject) => {
		const cleanup = () => {
			clearTimeout(timer);
			child.off("message", onMessage);
			child.off("error", onError);
			child.off("exit", onExit);
		};
		const onError = (error: Error) => { cleanup(); reject(error); };
		const onExit = (exitCode: number | null) => onError(new Error(`Child exited before ${type}: ${exitCode}`));
		const onMessage = (message: unknown) => {
			if (typeof message !== "object" || message === null || !("type" in message)) return;
			if (message.type === "failed") return onError(new Error(JSON.stringify(message)));
			if (message.type !== type) return;
			cleanup();
			resolve(message as Record<string, unknown>);
		};
		const timer = setTimeout(() => onError(new Error(`Timed out waiting for child ${type}.`)), 10000);
		child.on("message", onMessage);
		child.once("error", onError);
		child.once("exit", onExit);
	});
}

for (const kind of ["run", "compact"] as const) {
	test(`another Node process holds its ${kind} claim until durable cancellation, blocking project migration`, { timeout: 20000 }, async (t) => {
		let child: ChildProcess | undefined;
		let closed: Promise<unknown[]> | undefined;
		t.after(async () => {
			if (!child || !closed || child.exitCode !== null || child.signalCode !== null) return;
			if (child.connected) child.send({ type: "exit" });
			const timer = setTimeout(() => child?.kill(), 2000);
			try { await closed; } finally { clearTimeout(timer); }
		});
		const { base, workspace, outside } = await temporaryWorkspace(t);
		const store = new SessionStore({ root: join(base, "sessions") });
		const parent = await SessionManager.open(agent, { workspace, store });
		await parent.run("Historical material ".repeat(700));
		await parent.run("Latest complete turn");
		const originalHistory = parent.history;
		const project = await parent.createProject("Move target", outside);
		const stalePreview = await parent.previewProjectJoin(project.id);
		const fixture = fileURLToPath(new URL("./support/project-process.js", import.meta.url));
		child = fork(fixture, [workspace, store.root, parent.current.id, kind], {
			execPath: process.execPath, execArgv: [], windowsHide: true,
			stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		closed = once(child, "close");
		let stderr = "";
		child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
		const active = await nextMessage(child, "active");
		assert.equal(active.kind, kind);
		assert.equal(active.pid, child.pid);
		assert.notEqual(active.pid, process.pid);
		assert.equal(processAlive(child.pid!), true);
		const claimed = await store.loadAny(parent.current.id);
		if (kind === "compact") assert.equal(claimed.activeOperation?.ownerPid, child.pid);
		else {
			assert.equal(claimed.attempt?.ownerPid, child.pid);
			assert.equal(claimed.attempt?.status, "running");
		}
		await assert.rejects(parent.previewProjectJoin(project.id), code("SESSION_BUSY"));
		await assert.rejects(parent.joinProject(stalePreview), code("SESSION_BUSY"));
		await assert.rejects(store.save({ ...claimed, name: "Foreign mutation" }, claimed.revision), code("SESSION_BUSY"));
		await assert.rejects(store.delete(claimed.storageWorkspace ?? workspace, claimed.id, claimed.revision), code("SESSION_BUSY"));
		assert.deepEqual((await store.loadAny(claimed.id)).history, originalHistory);
		assert.equal((await store.loadAny(claimed.id)).location?.kind, "standalone");
		const settledMessage = nextMessage(child, "settled");
		child.send({ type: "cancel" });
		const settled = await settledMessage;
		assert.equal(settled.code, "CANCELLED");
		assert.equal(processAlive(child.pid!), true);
		const released = await store.loadAny(claimed.id);
		assert.equal(released.activeOperation, undefined);
		if (kind === "run") assert.equal(released.attempt?.status, "cancelled");
		assert.deepEqual(released.history, originalHistory);
		await assert.rejects(parent.joinProject(stalePreview), code("SESSION_CONFLICT"));
		await parent.joinProject(await parent.previewProjectJoin(project.id));
		assert.equal(parent.current.projectId, project.id);
		assert.equal(parent.current.workspace, outside);
		assert.deepEqual(parent.history, originalHistory);
		assert.equal((await store.loadAny(claimed.id)).locationChanges?.length, 1);
		child.send({ type: "exit" });
		await closed;
		assert.equal(child.exitCode, 0, stderr);
		assert.equal(processAlive(child.pid!), false);
	});
}
