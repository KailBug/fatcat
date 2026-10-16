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
import { SessionStore } from "../../src/session/store.js";
import { temporaryWorkspace } from "../support/workspace.js";

const agent = { maxIterations: 4, model: async (): Promise<ModelTurn> => ({ message: { role: "assistant", content: "Saved history" }, toolCalls: [] }) };
const code = (expected: string) => (error: unknown) => error instanceof HarnessError && error.code === expected;

function nextMessage(child: ChildProcess, type: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const cleanup = () => { clearTimeout(timer); child.off("message", onMessage); child.off("error", onError); child.off("exit", onExit); };
		const onError = (error: Error) => { cleanup(); reject(error); };
		const onExit = (exitCode: number | null) => onError(new Error(`Child exited before ${type}: ${exitCode}`));
		const onMessage = (message: unknown) => {
			if (typeof message !== "object" || message === null || !("type" in message)) return;
			if (message.type === "failed") return onError(new Error(JSON.stringify(message)));
			if (message.type === type) { cleanup(); resolve(); }
		};
		const timer = setTimeout(() => onError(new Error(`Timed out waiting for child ${type}.`)), 10000);
		child.on("message", onMessage);
		child.once("error", onError);
		child.once("exit", onExit);
	});
}

for (const kind of ["run", "compact"] as const) {
	test(`project mutations reject a member's ${kind} in another process until its durable cancellation`, { timeout: 20000 }, async (t) => {
		let child: ChildProcess | undefined;
		let closed: Promise<unknown[]> | undefined;
		t.after(async () => {
			if (child && closed && child.exitCode === null && child.signalCode === null) { child.kill(); await closed; }
		});
		const { base, workspace, outside } = await temporaryWorkspace(t);
		const store = new SessionStore({ root: join(base, "sessions") });
		const project = await store.projects.create("Busy project", workspace);
		const manager = await SessionManager.open(agent, { workspace, store, selection: { project: project.id } });
		await manager.run("Historical material ".repeat(700));
		await manager.run("Latest history");
		const move = await store.previewProjectWorkspace(project.id, outside);
		const deletion = await store.previewProjectDelete(project.id);
		child = fork(fileURLToPath(new URL("./support/project-process.js", import.meta.url)), [workspace, store.root, manager.current.id, kind], {
			execPath: process.execPath, execArgv: [], windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"],
		});
		closed = once(child, "close");
		await nextMessage(child, "active");
		await assert.rejects(store.renameProject(project.id, "Unsafe rename", project.revision), code("SESSION_BUSY"));
		await assert.rejects(store.changeProjectWorkspace(move), code("SESSION_BUSY"));
		await assert.rejects(store.deleteProject(deletion), code("SESSION_BUSY"));
		const settled = nextMessage(child, "settled");
		child.send({ type: "cancel" });
		await settled;
		await assert.rejects(store.changeProjectWorkspace(move), code("PROJECT_CONFLICT"));
		await store.changeProjectWorkspace(await store.previewProjectWorkspace(project.id, outside));
		assert.equal((await store.loadAny(manager.current.id)).workspace, outside);
		child.send({ type: "exit" });
		await closed;
		assert.equal(child.exitCode, 0);
	});
}
