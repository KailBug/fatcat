import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readAttachmentCatalog } from "@fatcat/runtime/internal/attachments/catalog";
import { decodeMetadataCommit, encodeMetadataCommit } from "@fatcat/runtime/internal/metadata/journal";
import { emptyAttachmentCatalog } from "@fatcat/runtime/attachments/record";
import { MetadataTransactions } from "@fatcat/runtime/internal/metadata/transaction";
import type { ProjectRecord } from "@fatcat/runtime/project/record";
import type { SessionRecord } from "@fatcat/runtime/session/record";
import { temporaryWorkspace } from "../support/workspace.js";

describe("metadata journal boundaries", () => {
	it("encodes session identity without transient projections and reads legacy journals", async (t) => {
		const { workspace, outside } = await temporaryWorkspace(t);
		const projectId = randomUUID();
		const now = new Date().toISOString();
		const session: SessionRecord = { version: 4, id: randomUUID(), workspace: outside, storageWorkspace: workspace,
			location: { kind: "project", projectId }, projectRevision: 7, locationRevision: 1,
			name: null, title: "Joined", createdAt: now, updatedAt: now, revision: 2, forkedFrom: null, history: [], attempt: null };
		const catalog = emptyAttachmentCatalog();
		const raw = JSON.parse(JSON.stringify(encodeMetadataCommit({ catalog, writes: [session] })));
		assert.equal(raw.version, 2);
		assert.equal(raw.writes[0].storageWorkspace, workspace);
		assert.deepEqual(raw.writes[0].location, { kind: "project", projectId });
		assert.equal("workspace" in raw.writes[0], false);
		assert.equal("projectRevision" in raw.writes[0], false);
		assert.equal("memoryMove" in raw, false);
		for (const version of [1, 2]) {
			const decoded = decodeMetadataCommit({ ...raw, version, sessionMoves: undefined });
			assert.equal(decoded.writes?.[0]?.storageWorkspace, workspace);
			assert.deepEqual(decoded.sessionMoves, []);
			assert.equal(decoded.memoryMove, undefined);
		}
		const memoryMove = { sessionId: session.id, projectId };
		const migration = JSON.parse(JSON.stringify(encodeMetadataCommit({ catalog, writes: [session], memoryMove })));
		assert.equal(migration.version, 3);
		assert.deepEqual(decodeMetadataCommit(migration).memoryMove, memoryMove);
		assert.throws(() => decodeMetadataCommit({ ...migration, version: 2 }), { code: "ATTACHMENT_CORRUPT" });
	});

	it("rejects conflicting project changes before publishing a decision or changing the catalog", async (t) => {
		const { base, workspace } = await temporaryWorkspace(t);
		const root = join(base, "sessions");
		const transactions = new MetadataTransactions(root);
		const catalog = emptyAttachmentCatalog();
		await transactions.withLock(() => transactions.commit({ catalog }));
		const catalogPath = join(root, "attachments", "catalog.json");
		const before = await readFile(catalogPath);
		const now = new Date().toISOString();
		const project: ProjectRecord = { version: 1, id: randomUUID(), name: "Project", workspace,
			createdAt: now, updatedAt: now, revision: 1 };
		await assert.rejects(transactions.withLock(() => transactions.commit({ catalog: { ...catalog, revision: 1 },
			projectWrite: project, projectDelete: project.id })), /Conflicting project changes/);
		assert.deepEqual(await readFile(catalogPath), before);
		await assert.rejects(stat(join(root, "attachments", "pending.json")), { code: "ENOENT" });
		await assert.rejects(stat(join(root, "projects", `${project.id}.json`)), { code: "ENOENT" });
		await transactions.withLock(() => transactions.commit({ catalog: { ...catalog, revision: 1 } }));
		assert.equal((await readAttachmentCatalog(join(root, "attachments"))).revision, 1);
	});

	it("blocks readers on corrupt pending decisions and preserves read versus replay errors", async (t) => {
		const { base } = await temporaryWorkspace(t);
		const root = join(base, "sessions");
		const directory = join(root, "attachments");
		const pending = join(directory, "pending.json");
		await mkdir(directory, { recursive: true });
		const transactions = new MetadataTransactions(root);
		for (const { contents, code } of [
			{ contents: "{", code: "ATTACHMENT_CORRUPT" },
			{ contents: JSON.stringify({ version: 4 }), code: "ATTACHMENT_RECOVERY_PENDING" },
		]) {
			await writeFile(pending, contents);
			let observed = false;
			await assert.rejects(transactions.withLock(async () => { observed = true; }), { code });
			assert.equal(observed, false);
			assert.equal(await readFile(pending, "utf8"), contents);
			await assert.rejects(stat(join(root, "metadata.lock")), { code: "ENOENT" });
		}
		await writeFile(pending, JSON.stringify({ version: 1, catalog: emptyAttachmentCatalog(), writes: [], deletes: [], purge: [] }));
		await transactions.withLock(async () => {
			await assert.rejects(stat(pending), { code: "ENOENT" });
			assert.equal((await readAttachmentCatalog(join(root, "attachments"))).revision, 0);
		});
	});
});
