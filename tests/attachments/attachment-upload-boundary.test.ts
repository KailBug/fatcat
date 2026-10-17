import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { HarnessError } from "../../src/errors.js";
import { attachmentReference, parseAttachmentReference } from "../../src/attachments/record.js";
import type { SessionRecord } from "../../src/session/record.js";
import { SessionStore } from "../../src/session/store.js";
import { temporaryWorkspace } from "../support/workspace.js";

const code = (expected: string) => (error: unknown) => error instanceof HarnessError && error.code === expected;

function draft(workspace: string): SessionRecord {
	const now = new Date().toISOString();
	return { version: 2, id: randomUUID(), workspace, name: null, title: "New session", createdAt: now,
		updatedAt: now, revision: 0, forkedFrom: null, history: [], attempt: null };
}

async function* bytes(value: string) { yield Buffer.from(value); }

describe("Attachment upload file and publication boundaries", () => {
	it("keeps the metadata gate available during streaming and protects a retry from the old writer", async (t) => {
		const { base, workspace } = await temporaryWorkspace(t);
		const store = new SessionStore({ root: join(base, "sessions") });
		const other = new SessionStore({ root: store.root });
		const session = await store.save(draft(workspace), 0);
		const target = { sessionId: session.id, locationRevision: 0 };
		const metadata = { uploadId: randomUUID(), name: "notes.md" };
		let signalReady!: () => void;
		let resume!: () => void;
		const ready = new Promise<void>((resolve) => { signalReady = resolve; });
		const resumed = new Promise<void>((resolve) => { resume = resolve; });
		async function* slowBody() { yield Buffer.from("old"); signalReady(); await resumed; yield Buffer.from(" tail"); }
		const writing = store.attachments.stageUpload(target, metadata, slowBody());
		// Observe failures immediately and always release the producer before fixture cleanup.
		const outcome = writing.then(() => undefined, (error: unknown) => error);
		let timedOut = false;
		const timer = setTimeout(() => { timedOut = true; resume(); }, 5000);
		try {
			await Promise.race([ready, writing]);
			assert.deepEqual(await other.attachments.list(target), []);
			await assert.rejects(other.attachments.completeUpload(metadata.uploadId), code("ATTACHMENT_UPLOAD"));
			const directory = join(store.root, "attachments", "staging");
			const owner = JSON.parse(await readFile(join(directory, `${metadata.uploadId}.lock`), "utf8")) as { stageToken: string };
			await other.attachments.discardUpload(metadata.uploadId, owner.stageToken);
			const replacement = await other.attachments.stageUpload(target, metadata, bytes("replacement"));
			assert.notEqual(replacement.stageToken, owner.stageToken);
			resume();
			assert.ok(code("ATTACHMENT_UPLOAD_CONFLICT")(await outcome));
			const published = await other.attachments.completeUpload(metadata.uploadId, undefined, replacement.stageToken);
			const ref = parseAttachmentReference(attachmentReference(published.attachment));
			assert.equal(Buffer.from((await store.attachments.read(target, ref)).bytes).toString(), "replacement");
			assert.equal((await store.attachments.list(target)).length, 1);
			assert.deepEqual(await readdir(directory), []);
			assert.equal(timedOut, false, "Metadata operations must finish while the upload producer is paused.");
		} finally {
			clearTimeout(timer);
			resume();
			await outcome;
		}
	});

	it("closes a failed input stream before token cleanup and permits the same upload identity to retry", async (t) => {
		const { base, workspace } = await temporaryWorkspace(t);
		const store = new SessionStore({ root: join(base, "sessions") });
		const session = await store.save(draft(workspace), 0);
		const target = { sessionId: session.id, locationRevision: 0 };
		const metadata = { uploadId: randomUUID(), name: "notes.md" };
		const failure = new Error("Injected producer failure.");
		async function* broken() { yield Buffer.from("partial"); throw failure; }
		await assert.rejects(store.attachments.stageUpload(target, metadata, broken()), (error: unknown) => error === failure);
		assert.deepEqual(await readdir(join(store.root, "attachments", "staging")), []);
		assert.deepEqual(await store.attachments.list(target), []);
		const staged = await store.attachments.stageUpload(target, metadata, bytes("complete"));
		const result = await store.attachments.completeUpload(metadata.uploadId, undefined, staged.stageToken);
		assert.equal(result.attachment.size, Buffer.byteLength("complete"));
		assert.equal((await store.attachments.list(target)).length, 1);
	});

	it("rejects changed staged bytes before making a draft or attachment visible", async (t) => {
		const { base, workspace } = await temporaryWorkspace(t);
		const store = new SessionStore({ root: join(base, "sessions") });
		const session = draft(workspace);
		const target = { sessionId: session.id, locationRevision: 0 };
		const uploadId = randomUUID();
		const staged = await store.attachments.stageUpload(target, { uploadId, name: "notes.md" }, bytes("original"));
		const path = join(store.root, "attachments", "staging", `${uploadId}.${staged.stageToken}.part`);
		await writeFile(path, "modified");
		await assert.rejects(store.attachments.completeUpload(uploadId, session, staged.stageToken), code("ATTACHMENT_CONTENT"));
		await assert.rejects(store.loadAny(session.id), code("SESSION_NOT_FOUND"));
		await store.attachments.discardUpload(uploadId, staged.stageToken);
		const retried = await store.attachments.stageUpload(target, { uploadId, name: "notes.md" }, bytes("original"));
		const published = await store.attachments.completeUpload(uploadId, session, retried.stageToken);
		assert.equal(published.session.id, session.id);
		assert.equal((await store.attachments.list(target)).length, 1);
	});
});
