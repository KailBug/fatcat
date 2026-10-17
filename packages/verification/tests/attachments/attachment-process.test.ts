import assert from "node:assert/strict";
import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { attachmentReference, parseAttachmentReference } from "@fatcat/runtime/attachments/record";
import { HarnessError } from "@fatcat/runtime/errors";
import { projectIdOf, workspaceKey } from "@fatcat/runtime/session/record";
import { SessionStore } from "@fatcat/runtime/session/store";
import { temporaryWorkspace } from "../support/workspace.js";

function nextMessage(child: ChildProcess, type: string): Promise<void> {
	return new Promise((resolve, reject) => {
		const cleanup = () => { clearTimeout(timer); child.off("message", message); child.off("exit", exit); child.off("error", failed); };
		const failed = (error: Error) => { cleanup(); reject(error); };
		const exit = (code: number | null) => failed(new Error(`Child exited before ${type}: ${code}`));
		const message = (value: unknown) => {
			if (typeof value !== "object" || value === null || !("type" in value)) return;
			if (value.type === "failed") return failed(new Error(JSON.stringify(value)));
			if (value.type === type) { cleanup(); resolve(); }
		};
		const timer = setTimeout(() => failed(new Error(`Timed out waiting for child ${type}.`)), 10000);
		child.on("message", message);
		child.once("exit", exit);
		child.once("error", failed);
	});
}

test("another process cannot expose half-published sharing, and readers recover its committed migration after exit", { timeout: 20000 }, async (t) => {
	let child: ChildProcess | undefined;
	let closed: Promise<unknown[]> | undefined;
	t.after(async () => {
		if (child && closed && child.exitCode === null && child.signalCode === null) { child.kill(); await closed; }
	});
	const { base, workspace, outside } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const now = new Date().toISOString();
	const session = await store.save({ version: 2, id: randomUUID(), workspace, name: null, title: "Original",
		createdAt: now, updatedAt: now, revision: 0, forkedFrom: null, history: [], attempt: null }, 0);
	const project = await store.projects.create("Shared", outside);
	const uploadId = randomUUID();
	async function* body() { yield Buffer.from("Evidence surviving a process crash"); }
	const staged = await store.attachments.stageUpload({ sessionId: session.id, locationRevision: 0 }, { uploadId, name: "notes.md" }, body());
	const attachment = (await store.attachments.completeUpload(uploadId, undefined, staged.stageToken)).attachment;
	const fixture = fileURLToPath(new URL("./support/attachment-process.js", import.meta.url));
	child = fork(fixture, [store.root, session.id, project.id], {
		execPath: process.execPath, execArgv: [], windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	closed = once(child, "close");
	await nextMessage(child, "locked");
	const busy = (error: unknown) => error instanceof HarnessError && error.code === "SESSION_BUSY";
	await assert.rejects(store.loadAny(session.id), busy);
	const partial = nextMessage(child, "partially-published");
	child.send({ type: "commit" });
	await partial;
	const raw = JSON.parse(await readFile(join(store.root, workspaceKey(workspace), `${session.id}.json`), "utf8"));
	assert.equal(raw.location.projectId, project.id);
	const before = JSON.parse(await readFile(join(store.root, "attachments", "catalog.json"), "utf8"));
	assert.equal(before.bindings[0].scope.kind, "session");
	await assert.rejects(store.listAll(), busy);
	child.send({ type: "crash" });
	await closed;
	assert.equal(child.exitCode, 0);
	const recovered = await store.loadAny(session.id);
	assert.equal(projectIdOf(recovered), project.id);
	const content = await store.attachments.read({ sessionId: session.id, locationRevision: 1, projectId: project.id },
		parseAttachmentReference(attachmentReference(attachment)));
	assert.equal(Buffer.from(content.bytes).toString(), "Evidence surviving a process crash");
	assert.equal(JSON.parse(await readFile(join(store.root, "attachments", "catalog.json"), "utf8")).bindings[0].scope.kind, "project");
	await assert.rejects(stat(join(store.root, "attachments", "pending.json")), { code: "ENOENT" });
	await assert.rejects(stat(join(store.root, "metadata.lock")), { code: "ENOENT" });
});

test("cross-process upload ownership prevents duplicate staging and old cleanup from deleting a retry", { timeout: 20000 }, async (t) => {
	let child: ChildProcess | undefined;
	let closed: Promise<unknown[]> | undefined;
	t.after(async () => {
		if (child && closed && child.exitCode === null && child.signalCode === null) { child.kill(); await closed; }
	});
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const now = new Date().toISOString();
	const session = await store.save({ version: 2, id: randomUUID(), workspace, name: null, title: "Original",
		createdAt: now, updatedAt: now, revision: 0, forkedFrom: null, history: [], attempt: null }, 0);
	const uploadId = randomUUID();
	const fixture = fileURLToPath(new URL("./support/attachment-upload-process.js", import.meta.url));
	child = fork(fixture, [store.root, session.id, uploadId], {
		execPath: process.execPath, execArgv: [], windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"],
	});
	closed = once(child, "close");
	await nextMessage(child, "staged");
	async function* body() { yield Buffer.from("Same bytes"); }
	const target = { sessionId: session.id, locationRevision: 0 };
	const metadata = { uploadId, name: "same.md" };
	await assert.rejects(store.attachments.stageUpload(target, metadata, body()), (error: unknown) => error instanceof HarnessError && error.code === "ATTACHMENT_UPLOAD_CONFLICT");
	await store.attachments.discardUpload(uploadId);
	const completed = nextMessage(child, "completed");
	child.send({ type: "complete" });
	await completed;
	const retry = await store.attachments.stageUpload(target, metadata, body());
	const cleaned = nextMessage(child, "cleaned");
	child.send({ type: "cleanup" });
	await cleaned;
	await closed;
	assert.equal(child.exitCode, 0);
	const result = await store.attachments.completeUpload(uploadId, undefined, retry.stageToken);
	assert.equal(Buffer.from((await store.attachments.read(target, parseAttachmentReference(attachmentReference(result.attachment)))).bytes).toString(), "Same bytes");
	assert.equal((await store.attachments.list(target)).length, 1);
});
