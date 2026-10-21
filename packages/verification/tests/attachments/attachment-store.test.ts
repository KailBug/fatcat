import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { attachmentReference, emptyAttachmentCatalog, maxAttachmentBytes, parseAttachmentReference } from "@fatcat/runtime/attachments/record";
import type { AttachmentInfo, AttachmentTarget } from "@fatcat/runtime/attachments/record";
import { MetadataTransactions } from "@fatcat/runtime/internal/metadata/transaction";
import type { MetadataSessionAccess } from "@fatcat/runtime/internal/metadata/transaction";
import { HarnessError } from "@fatcat/runtime/errors";
import { encodeSessionRecord, projectIdOf, workspaceKey } from "@fatcat/runtime/session/record";
import type { SessionRecord } from "@fatcat/runtime/session/record";
import { SessionStore } from "@fatcat/runtime/session/store";
import { temporaryWorkspace } from "../support/workspace.js";

const expectCode = (code: string) => (error: unknown) => error instanceof HarnessError && error.code === code;

function draft(workspace: string): SessionRecord {
	const now = new Date().toISOString();
	return { version: 4, id: randomUUID(), workspace, name: null, title: "New session", createdAt: now,
		updatedAt: now, revision: 0, forkedFrom: null, history: [], attempt: null };
}

function target(record: SessionRecord): AttachmentTarget {
	const projectId = projectIdOf(record);
	return { sessionId: record.id, locationRevision: record.locationRevision ?? 0, ...(projectId ? { projectId } : {}) };
}

async function* bytes(text: string | Uint8Array): AsyncIterable<Uint8Array> {
	yield typeof text === "string" ? Buffer.from(text) : text;
}

async function upload(store: SessionStore, session: SessionRecord, text = "Original evidence", name = "notes.md"): Promise<AttachmentInfo> {
	const uploadId = randomUUID();
	const staged = await store.attachments.stageUpload(target(session), { uploadId, name }, bytes(text));
	return (await store.attachments.completeUpload(uploadId, session.revision === 0 ? session : undefined, staged.stageToken)).attachment;
}

function ref(info: AttachmentInfo) { return parseAttachmentReference(attachmentReference(info)); }

test("project attachments survive restart and uploader deletion while same-directory private sessions stay isolated", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const project = await store.projects.create("Shared", workspace);
	const projectDraft = () => ({ ...draft(workspace), location: { kind: "project" as const, projectId: project.id }, projectRevision: project.revision });
	const first = await store.save(projectDraft(), 0);
	const second = await store.save(projectDraft(), 0);
	const standalone = await store.save(draft(workspace), 0);
	const info = await upload(store, first);
	assert.equal((await store.attachments.list(target(second)))[0]?.id, info.id);
	assert.deepEqual(await store.attachments.list(target(standalone)), []);
	await assert.rejects(store.attachments.read(target(standalone), ref(info)), expectCode("ATTACHMENT_ACCESS"));
	await store.delete(first.storageWorkspace!, first.id, first.revision);
	const reopened = new SessionStore({ root: store.root });
	assert.equal(Buffer.from((await reopened.attachments.read(target(second), ref(info))).bytes).toString(), "Original evidence");
	assert.equal((await reopened.attachments.list(target(second)))[0]?.uploaderSessionId, first.id);
});

test("uploads bind to captured scope, accept ordinary history updates and reject migration during upload", async (t) => {
	const { base, workspace, outside } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	let session = await store.save(draft(workspace), 0);
	const id = randomUUID();
	const initial = await store.attachments.stageUpload(target(session), { uploadId: id, name: "first.md" }, bytes("first"));
	session = await store.save({ ...session, title: "Edited while uploading" }, session.revision);
	assert.equal((await store.attachments.completeUpload(id, undefined, initial.stageToken)).session.revision, session.revision);
	const next = randomUUID();
	const late = await store.attachments.stageUpload(target(session), { uploadId: next, name: "late.md" }, bytes("late"));
	const project = await store.projects.create("Shared", outside);
	const sharing = await store.attachments.sharingState(target(session));
	session = await store.save({ ...session, location: { kind: "project", projectId: project.id }, locationRevision: 1,
		workspace: outside, projectRevision: project.revision }, session.revision, undefined, { attachmentRevisionExpected: sharing.revision });
	await assert.rejects(store.attachments.completeUpload(next, undefined, late.stageToken), expectCode("ATTACHMENT_TARGET_CHANGED"));
	assert.equal((await store.attachments.list(target(session))).length, 1);
	assert.deepEqual(await readdir(join(store.root, "attachments", "staging")), []);
});

test("draft publication saves session and original together and never resurrects a deleted captured draft", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const session = draft(workspace);
	const info = await upload(store, session);
	const saved = await store.loadAny(session.id);
	assert.equal(saved.revision, 1);
	assert.equal((await store.attachments.list(target(saved)))[0]?.id, info.id);
	const cancelled = draft(workspace);
	const cancelledUpload = randomUUID();
	const cancelledStage = await store.attachments.stageUpload(target(cancelled), { uploadId: cancelledUpload, name: "cancelled.md" }, bytes("cancelled"));
	await store.attachments.discardUpload(cancelledUpload, cancelledStage.stageToken);
	await assert.rejects(store.loadAny(cancelled.id), expectCode("SESSION_NOT_FOUND"));
	const oldDraft = draft(workspace);
	const late = randomUUID();
	const lateStage = await store.attachments.stageUpload(target(oldDraft), { uploadId: late, name: "late.md" }, bytes("late"));
	const named = await store.save({ ...oldDraft, name: "Named" }, 0);
	await store.delete(named.storageWorkspace!, named.id, named.revision);
	await assert.rejects(store.attachments.completeUpload(late, oldDraft, lateStage.stageToken), expectCode("ATTACHMENT_TARGET_CHANGED"));
	await assert.rejects(store.save(oldDraft, 0), expectCode("SESSION_NOT_FOUND"));
	await assert.rejects(store.loadAny(oldDraft.id), expectCode("SESSION_NOT_FOUND"));
});

test("upload retries are idempotent only for the same captured scope, name and bytes", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const first = await store.save(draft(workspace), 0);
	const second = await store.save(draft(workspace), 0);
	const uploadId = randomUUID();
	const metadata = { uploadId, name: "notes.md" };
	let staged = await store.attachments.stageUpload(target(first), metadata, bytes("same"));
	const info = (await store.attachments.completeUpload(uploadId, undefined, staged.stageToken)).attachment;
	assert.equal((await store.attachments.completeUpload(uploadId)).attachment.id, info.id);
	staged = await store.attachments.stageUpload(target(first), metadata, bytes("same"));
	assert.equal((await store.attachments.completeUpload(uploadId, undefined, staged.stageToken)).attachment.id, info.id);
	staged = await store.attachments.stageUpload(target(second), metadata, bytes("same"));
	await assert.rejects(store.attachments.completeUpload(uploadId, undefined, staged.stageToken), expectCode("ATTACHMENT_UPLOAD_CONFLICT"));
	staged = await store.attachments.stageUpload(target(first), metadata, bytes("different"));
	await assert.rejects(store.attachments.completeUpload(uploadId, undefined, staged.stageToken), expectCode("ATTACHMENT_UPLOAD_CONFLICT"));
	assert.equal((await store.attachments.list(target(first))).length, 1);
	assert.deepEqual(await store.attachments.list(target(second)), []);
	assert.notEqual((await upload(store, first, "same")).id, info.id);
});

test("duplicate requests and stale cleanup cannot publish or discard another request's staged bytes", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const other = new SessionStore({ root: store.root });
	const session = await store.save(draft(workspace), 0);
	const metadata = { uploadId: randomUUID(), name: "same.md" };
	const first = await store.attachments.stageUpload(target(session), metadata, bytes("first"));
	await assert.rejects(other.attachments.stageUpload(target(session), metadata, bytes("duplicate")), expectCode("ATTACHMENT_UPLOAD_CONFLICT"));
	await other.attachments.discardUpload(metadata.uploadId);
	await assert.rejects(other.attachments.completeUpload(metadata.uploadId), expectCode("ATTACHMENT_UPLOAD_CONFLICT"));
	await store.attachments.discardUpload(metadata.uploadId, first.stageToken);
	const second = await other.attachments.stageUpload(target(session), metadata, bytes("second"));
	assert.notEqual(second.stageToken, first.stageToken);
	await store.attachments.discardUpload(metadata.uploadId, first.stageToken);
	await assert.rejects(store.attachments.completeUpload(metadata.uploadId, undefined, first.stageToken), expectCode("ATTACHMENT_UPLOAD_CONFLICT"));
	const info = (await other.attachments.completeUpload(metadata.uploadId, undefined, second.stageToken)).attachment;
	assert.equal(Buffer.from((await store.attachments.read(target(session), ref(info))).bytes).toString(), "second");
});

test("staging enforces byte limits, cancellation, server media types and immutable content integrity", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const session = await store.save(draft(workspace), 0);
	await assert.rejects(store.attachments.stageUpload(target(session), { uploadId: randomUUID(), name: "large.pdf" },
		bytes(new Uint8Array(maxAttachmentBytes + 1))), expectCode("ATTACHMENT_LIMIT"));
	const controller = new AbortController();
	async function* cancelled() { yield Buffer.from("first"); controller.abort(); yield Buffer.from("last"); }
	await assert.rejects(store.attachments.stageUpload(target(session), { uploadId: randomUUID(), name: "cancel.md" },
		cancelled(), controller.signal), expectCode("CANCELLED"));
	const uploadId = randomUUID();
	const staged = await store.attachments.stageUpload(target(session), { uploadId, name: "original.pdf", mediaType: "text/plain" }, bytes("binary source"));
	assert.equal(staged.mediaType, "application/pdf");
	const info = (await store.attachments.completeUpload(uploadId, undefined, staged.stageToken)).attachment;
	await writeFile(join(store.root, "attachments", "blobs", info.id, info.contentVersion), "binary forged");
	await assert.rejects(store.attachments.read(target(session), ref(info)), expectCode("ATTACHMENT_CONTENT"));
	assert.deepEqual(await readdir(join(store.root, "attachments", "staging")), []);
});

test("removed associations retain receipts without content access; permanent deletion retains a tombstone", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const session = await store.save(draft(workspace), 0);
	const info = await upload(store, session);
	await store.attachments.remove(target(session), ref(info), info.scopeRevision);
	await assert.rejects(store.attachments.read(target(session), ref(info)), expectCode("ATTACHMENT_ACCESS"));
	assert.deepEqual(await store.attachments.list(target(session)), []);
	const receipt = (await store.attachments.list(target(session), { includeRemoved: true }))[0]!;
	assert.equal(receipt.removed, true);
	await assert.rejects(store.attachments.delete(target(session), ref(info), info.scopeRevision), expectCode("ATTACHMENT_CONFLICT"));
	await store.attachments.delete(target(session), ref(info), receipt.scopeRevision);
	const tombstone = (await store.attachments.list(target(session), { includeRemoved: true }))[0]!;
	assert.equal(tombstone.deleted, true);
	await assert.rejects(stat(join(store.root, "attachments", "blobs", info.id, info.contentVersion)), { code: "ENOENT" });
});

test("forks copy private bindings and durable read pins independently of the uploader", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const original = await store.save(draft(workspace), 0);
	const info = await upload(store, original);
	await store.attachments.read(target(original), ref(info), { pin: true });
	const fork = await store.save({ ...draft(workspace), forkedFrom: original.id }, 0, original);
	await assert.rejects(store.attachments.delete(target(original), ref(info)), expectCode("ATTACHMENT_REFERENCED"));
	await store.delete(original.storageWorkspace!, original.id, original.revision);
	assert.equal((await store.attachments.list(target(fork)))[0]?.id, info.id);
	await store.attachments.remove(target(fork), ref(info));
	await assert.rejects(store.attachments.delete(target(fork), ref(info)), expectCode("ATTACHMENT_REFERENCED"));
});

test("sharing preview revisions reject intervening uploads and removals before promoting the private set", async (t) => {
	const { base, workspace, outside } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const session = await store.save(draft(workspace), 0);
	const project = await store.projects.create("Shared", outside);
	const joined = { ...session, workspace: outside, location: { kind: "project" as const, projectId: project.id },
		projectRevision: project.revision, locationRevision: 1 };
	const before = await store.attachments.sharingState(target(session));
	const info = await upload(store, session);
	await assert.rejects(store.save(joined, session.revision, undefined, { attachmentRevisionExpected: before.revision }), expectCode("ATTACHMENT_CONFLICT"));
	const afterUpload = await store.attachments.sharingState(target(session));
	assert.equal(afterUpload.count, 1);
	assert.notEqual(before.fingerprint, afterUpload.fingerprint);
	await store.attachments.remove(target(session), ref(info));
	await assert.rejects(store.save(joined, session.revision, undefined, { attachmentRevisionExpected: afterUpload.revision }), expectCode("ATTACHMENT_CONFLICT"));
	const current = await store.attachments.sharingState(target(session));
	const saved = await store.save(joined, session.revision, undefined, { attachmentRevisionExpected: current.revision });
	assert.deepEqual(await store.attachments.list(target(saved)), []);
	assert.equal((await store.attachments.list(target(saved), { includeRemoved: true }))[0]?.removed, true);
	await assert.rejects(store.attachments.list(target(session)), expectCode("ATTACHMENT_TARGET_CHANGED"));
});

test("direct history and partial-attempt references pin only files associated with that session scope", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	let first = await store.save(draft(workspace), 0);
	const second = await store.save(draft(workspace), 0);
	const owned = await upload(store, first);
	const foreign = await upload(store, second);
	await store.attachments.remove(target(first), ref(owned));
	first = await store.save({ ...first, history: [{ role: "system", content: "Test system" }, { role: "user", content: `${attachmentReference(owned)}#L1-L2` },
		{ role: "assistant", content: attachmentReference(foreign) }] }, first.revision);
	await assert.rejects(store.attachments.delete(target(first), ref(owned)), expectCode("ATTACHMENT_REFERENCED"));
	await store.attachments.delete(target(second), ref(foreign));
	const partial = await upload(store, first, "Partial");
	const now = new Date().toISOString();
	first = await store.save({ ...first, attempt: { prompt: attachmentReference(partial), messages: [],
		startedAt: now, updatedAt: now, ownerPid: process.pid, status: "failed", code: "MODEL" } }, first.revision);
	await assert.rejects(store.attachments.delete(target(first), ref(partial)), expectCode("ATTACHMENT_REFERENCED"));
});

test("unavailable project retains session history but refuses attachment reads, lists and publication", async (t) => {
	const { base, outside } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const project = await store.projects.create("Shared", outside);
	const session = await store.save({ ...draft(outside), projectRevision: project.revision,
		location: { kind: "project", projectId: project.id } }, 0);
	const info = await upload(store, session);
	const late = randomUUID();
	const staged = await store.attachments.stageUpload(target(session), { uploadId: late, name: "late.md" }, bytes("late"));
	await rename(outside, join(base, "moved"));
	assert.ok((await store.loadAny(session.id)).projectError);
	assert.equal((await store.listAll()).length, 1);
	await assert.rejects(store.attachments.list(target(session)), expectCode("PROJECT_UNAVAILABLE"));
	await assert.rejects(store.attachments.read(target(session), ref(info)), expectCode("PROJECT_UNAVAILABLE"));
	await assert.rejects(store.attachments.completeUpload(late, undefined, staged.stageToken), expectCode("PROJECT_UNAVAILABLE"));
});

test("concurrent same-process readers and independent writers serialize without losing catalog updates", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const reopened = new SessionStore({ root: store.root });
	const first = await store.save(draft(workspace), 0);
	const second = await store.save(draft(workspace), 0);
	const uploads = await Promise.all([upload(store, first, "First"), upload(reopened, second, "Second"),
		store.listAll(), reopened.loadAny(first.id), store.save({ ...first, title: "Renamed" }, first.revision)]);
	assert.equal((await store.attachments.list(target(first)))[0]?.id, (uploads[0] as AttachmentInfo).id);
	assert.equal((await store.attachments.list(target(second)))[0]?.id, (uploads[1] as AttachmentInfo).id);
	assert.equal((await store.loadAny(first.id)).title, "Renamed");
});

test("an interrupted cross-owner commit recovers before any Session reader observes its result", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const root = join(base, "sessions");
	const session = { ...draft(workspace), revision: 1, storageWorkspace: workspace };
	const access: MetadataSessionAccess = {
		publish: async (record) => {
			await mkdir(join(root, workspaceKey(workspace)), { recursive: true });
			await writeFile(join(root, workspaceKey(workspace), `${record.id}.json`), JSON.stringify(encodeSessionRecord(record)));
			throw new Error("Simulated interruption after publishing Session but before publishing attachment metadata");
		},
		remove: async () => {},
	};
	const transactions = new MetadataTransactions(root, access);
	const catalog = emptyAttachmentCatalog();
	catalog.revision = 1;
	await assert.rejects(transactions.withLock(() => transactions.commit({ catalog, writes: [session] })), expectCode("ATTACHMENT_RECOVERY_PENDING"));
	assert.equal((JSON.parse(await readFile(join(root, "attachments", "pending.json"), "utf8")) as { version: number }).version, 2);
	await assert.rejects(stat(join(root, "attachments", "catalog.json")), { code: "ENOENT" });
	const reopened = new SessionStore({ root });
	assert.equal((await reopened.loadAny(session.id)).revision, 1);
	assert.equal(JSON.parse(await readFile(join(root, "attachments", "catalog.json"), "utf8")).revision, 1);
	await assert.rejects(stat(join(root, "attachments", "pending.json")), { code: "ENOENT" });
	assert.equal((await readdir(join(root, workspaceKey(workspace)))).length, 1);
});

test("an unsaved project session can browse shared originals without durable history or read pins", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const project = await store.projects.create("Shared", workspace);
	const projectDraft = () => ({ ...draft(workspace), location: { kind: "project" as const, projectId: project.id }, projectRevision: project.revision });
	const uploader = await store.save(projectDraft(), 0);
	const info = await upload(store, uploader);
	const browsing = projectDraft();
	assert.equal((await store.attachments.list(target(browsing), { draft: browsing }))[0]?.id, info.id);
	assert.equal(Buffer.from((await store.attachments.read(target(browsing), ref(info), { draft: browsing })).bytes).toString(), "Original evidence");
	await assert.rejects(store.attachments.read(target(browsing), ref(info), { draft: browsing, pin: true }), expectCode("SESSION_NOT_FOUND"));
	await assert.rejects(store.loadAny(browsing.id), expectCode("SESSION_NOT_FOUND"));
	await store.attachments.delete(target(uploader), ref(info));
});
