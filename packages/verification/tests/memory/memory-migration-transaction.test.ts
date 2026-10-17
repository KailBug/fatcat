import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { emptyAttachmentCatalog } from "@fatcat/runtime/attachments/record";
import { AttachmentStore } from "@fatcat/runtime/internal/attachments/store";
import { MetadataTransactions } from "@fatcat/runtime/internal/metadata/transaction";
import type { AttachmentSessionAccess } from "@fatcat/runtime/internal/attachments/store";
import { MemoryStore } from "@fatcat/runtime/internal/memory/store";
import { joinedProjectRecord } from "@fatcat/runtime/project/operations";
import type { ProjectRecord } from "@fatcat/runtime/project/record";
import { encodeSessionRecord } from "@fatcat/runtime/session/record";
import type { SessionRecord } from "@fatcat/runtime/session/record";
import { temporaryWorkspace } from "../support/workspace.js";

function records(workspace: string, projectWorkspace: string) {
	const now = new Date().toISOString();
	const source: SessionRecord = { version: 2, id: randomUUID(), workspace, storageWorkspace: workspace,
		location: { kind: "standalone", workspace }, locationRevision: 0, name: null, title: "Original",
		createdAt: now, updatedAt: now, revision: 1, forkedFrom: null, history: [], attempt: null };
	const project: ProjectRecord = { version: 1, id: randomUUID(), name: "Project", workspace: projectWorkspace,
		createdAt: now, updatedAt: now, revision: 1 };
	const joined = { ...joinedProjectRecord(source, project), revision: 2 };
	return { source, project, joined };
}

function sessionAccess(record: SessionRecord, publish: AttachmentSessionAccess["publish"]): AttachmentSessionAccess {
	return { load: async () => record, prepareDraft: async (draft) => draft, publish, remove: async () => {} };
}

test("memory migration preflight rejects before a joined session or durable decision is published", async (t) => {
	const { base, workspace, outside } = await temporaryWorkspace(t);
	const root = join(base, "sessions");
	const { source, joined } = records(workspace, outside);
	let published = false;
	t.mock.method(MemoryStore.prototype, "previewSessionMove", async () => { throw new Error("Injected memory preflight failure"); });
	const store = new AttachmentStore({ root, sessions: sessionAccess(source, async () => { published = true; }) });
	await assert.rejects(store.withMetadata(() => store.publishSession(joined, source)), /Injected memory preflight failure/);
	assert.equal(published, false);
	await assert.rejects(stat(join(root, "attachments", "pending.json")), { code: "ENOENT" });
});

test("a durable memory migration replays before the joined session after an interrupted publication", async (t) => {
	const { base, workspace, outside } = await temporaryWorkspace(t);
	const root = join(base, "sessions");
	const { source, project, joined } = records(workspace, outside);
	const moves: Array<{ sessionId: string; projectId: string }> = [];
	t.mock.method(MemoryStore.prototype, "moveSessionToProject", async (sessionId: string, projectId: string) => {
		moves.push({ sessionId, projectId });
	});
	let attempts = 0;
	const published: SessionRecord[] = [];
	const access = sessionAccess(source, async (record) => {
		assert.equal(moves.length, attempts + 1, "Memory is moved before session publication");
		if (attempts++ === 0) throw new Error("Injected session publication failure");
		published.push(record);
	});
	const transaction = new MetadataTransactions(root, access);
	const memoryMove = { sessionId: source.id, projectId: project.id };
	await assert.rejects(transaction.withLock(() => transaction.commit({ catalog: emptyAttachmentCatalog(), writes: [joined], memoryMove })),
		{ code: "ATTACHMENT_RECOVERY_PENDING" });
	const pending = JSON.parse(await readFile(join(root, "attachments", "pending.json"), "utf8"));
	assert.equal(pending.version, 3, "Old metadata readers must reject a migration they cannot replay");
	assert.deepEqual(pending.memoryMove, memoryMove);
	assert.equal(published.length, 0);
	await new MetadataTransactions(root, access).withLock(async () => {});
	assert.deepEqual(moves, [memoryMove, memoryMove]);
	assert.equal(published.length, 1);
	assert.equal(published[0]!.location?.kind, "project");
	await assert.rejects(stat(join(root, "attachments", "pending.json")), { code: "ENOENT" });
});

test("legacy metadata journals recover without a memory migration", async (t) => {
	const { base, workspace, outside } = await temporaryWorkspace(t);
	const { source, joined } = records(workspace, outside);
	const moved = t.mock.method(MemoryStore.prototype, "moveSessionToProject", async () => {});
	for (const version of [1, 2]) {
		const root = join(base, `legacy-${version}`);
		await mkdir(join(root, "attachments"), { recursive: true });
		await writeFile(join(root, "attachments", "pending.json"), JSON.stringify({ version,
			catalog: emptyAttachmentCatalog(), writes: [encodeSessionRecord(joined)], deletes: [], purge: [] }));
		let published = false;
		await new MetadataTransactions(root, sessionAccess(source, async () => { published = true; })).withLock(async () => {});
		assert.equal(published, true);
	}
	assert.equal(moved.mock.callCount(), 0);
});

test("memory migration journals reject invalid IDs and changes unrelated to the joined snapshot", async (t) => {
	const { base, workspace, outside } = await temporaryWorkspace(t);
	const { source, project, joined } = records(workspace, outside);
	const transaction = new MetadataTransactions(join(base, "sessions"));
	for (const memoryMove of [
		{ sessionId: "invalid", projectId: project.id },
		{ sessionId: source.id, projectId: "invalid" },
		{ sessionId: randomUUID(), projectId: project.id },
		{ sessionId: source.id, projectId: randomUUID() },
	]) {
		await assert.rejects(transaction.withLock(() => transaction.commit({ catalog: emptyAttachmentCatalog(), writes: [joined], memoryMove })),
			{ code: "ATTACHMENT_CORRUPT" });
	}
	await assert.rejects(stat(join(base, "sessions", "attachments", "pending.json")), { code: "ENOENT" });
});
