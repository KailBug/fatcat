import assert from "node:assert/strict";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { HarnessError } from "../../src/errors.js";
import type { ModelTurn } from "../../src/model.js";
import { SessionManager } from "../../src/session/manager.js";
import { SessionStore } from "../../src/session/store.js";
import { temporaryWorkspace } from "../support/workspace.js";

const agent = { maxIterations: 4, model: async (): Promise<ModelTurn> => ({
	message: { role: "assistant", content: "Done" }, toolCalls: [],
}) };
const code = (expected: string) => (error: unknown) => error instanceof HarnessError && error.code === expected;

function pausedBody() {
	let start!: () => void;
	let release!: () => void;
	const started = new Promise<void>((resolve) => { start = resolve; });
	const pending = new Promise<void>((resolve) => { release = resolve; });
	async function* bytes() { start(); await pending; yield Buffer.from("Original"); }
	return { started, release, bytes: bytes() };
}

for (const persistent of [true, false]) {
for (const operation of ["join", "workspace", "delete"] as const) {
	if (!persistent && operation === "join") continue;
	test(`a ${persistent ? "persistent" : "temporary"} draft upload rejects ${operation} changes even after switching the UI session`, async (t) => {
		const { base, workspace, outside } = await temporaryWorkspace(t);
		const store = new SessionStore({ root: join(base, "sessions") });
		const manager = await SessionManager.open(agent, { workspace, store, persistence: persistent, deferEmptySessions: true });
		const original = manager.current;
		const target = await manager.beginAttachmentUpload(original.id, "notes.md", 8);
		const body = pausedBody();
		t.after(body.release);
		const upload = manager.uploadAttachment(target, body.bytes);
		await body.started;
		if (operation === "join") {
			const project = await manager.createProject("Shared", outside);
			await manager.joinProject(await manager.previewProjectJoin(project.id));
			assert.equal(manager.current.revision, 0);
			assert.equal(manager.current.projectId, project.id);
		} else if (operation === "workspace") {
			await manager.setWorkspace(outside);
			assert.equal(manager.current.revision, 0);
			assert.equal(manager.current.workspace, outside);
		} else await manager.delete(original.id);
		await manager.newSession(undefined, null);
		const selected = manager.current.id;
		const rejected = assert.rejects(upload, code("ATTACHMENT_TARGET_CHANGED"));
		body.release();
		await rejected;
		assert.equal(manager.current.id, selected);
		assert.deepEqual(await manager.list(), []);
		if (persistent) {
			await assert.rejects(store.loadAny(original.id), code("SESSION_NOT_FOUND"));
			assert.deepEqual(await readdir(join(store.root, "attachments", "staging")), []);
		} else await assert.rejects(stat(store.root), { code: "ENOENT" });
	});
}
}

test("switching to a new session preserves the captured draft upload without changing the selected session", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const manager = await SessionManager.open(agent, { workspace, store, deferEmptySessions: true });
	const original = manager.current.id;
	const target = await manager.beginAttachmentUpload(original, "notes.md", 8);
	const body = pausedBody();
	t.after(body.release);
	const upload = manager.uploadAttachment(target, body.bytes);
	await body.started;
	await manager.newSession();
	const selected = manager.current.id;
	body.release();
	const attachment = await upload;
	assert.equal(manager.current.id, selected);
	assert.equal(manager.current.revision, 0);
	assert.equal((await store.loadAny(original)).workspace, workspace);
	assert.equal((await manager.listAttachments(original))[0]?.id, attachment.id);
	assert.deepEqual(await manager.listAttachments(), []);
});

test("new captures after a draft migration use its current project scope", async (t) => {
	const { base, workspace, outside } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const manager = await SessionManager.open(agent, { workspace, store, deferEmptySessions: true });
	const project = await manager.createProject("Shared", outside);
	await manager.joinProject(await manager.previewProjectJoin(project.id));
	const original = manager.current.id;
	const target = await manager.beginAttachmentUpload(original, "notes.md", 8);
	async function* bytes() { yield Buffer.from("Original"); }
	const attachment = await manager.uploadAttachment(target, bytes());
	assert.equal(manager.current.projectId, project.id);
	await manager.newSession();
	assert.equal((await manager.listAttachments())[0]?.id, attachment.id);
	assert.equal((await store.loadAny(original)).workspace, outside);
});
