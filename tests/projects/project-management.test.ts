import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { attachmentReference, emptyAttachmentCatalog, parseAttachmentReference } from "../../src/attachments/record.js";
import type { AttachmentInfo, AttachmentTarget } from "../../src/attachments/record.js";
import { AttachmentTransactions, atomicJson } from "../../src/attachments/transaction.js";
import { newBoundTask } from "../../src/automation/tasks.js";
import { HarnessError } from "../../src/errors.js";
import type { ProjectSessionMove } from "../../src/project/management.js";
import type { ProjectRecord } from "../../src/project/record.js";
import { ProjectStore } from "../../src/project/store.js";
import { encodeSessionRecord, projectIdOf, workspaceKey } from "../../src/session/record.js";
import type { SessionRecord } from "../../src/session/record.js";
import { SessionStore } from "../../src/session/store.js";
import { temporaryWorkspace } from "../support/workspace.js";

const code = (expected: string) => (error: unknown) => error instanceof HarnessError && error.code === expected;

function draft(workspace: string, project?: ProjectRecord): SessionRecord {
	const now = new Date().toISOString();
	return { version: 2, id: randomUUID(), workspace: project?.workspace ?? workspace, name: null, title: "New session",
		createdAt: now, updatedAt: now, revision: 0, forkedFrom: null, history: [], attempt: null,
		...(project ? { location: { kind: "project", projectId: project.id }, projectRevision: project.revision } : {}) };
}

function target(record: SessionRecord): AttachmentTarget {
	const projectId = projectIdOf(record);
	return { sessionId: record.id, locationRevision: record.locationRevision ?? 0, ...(projectId ? { projectId } : {}) };
}

async function upload(store: SessionStore, record: SessionRecord, text = "Evidence"): Promise<AttachmentInfo> {
	async function* body() { yield Buffer.from(text); }
	const staged = await store.attachments.stageUpload(target(record), { uploadId: randomUUID(), name: "notes.md" }, body());
	return (await store.attachments.completeUpload(staged.uploadId, undefined, staged.stageToken)).attachment;
}

function ref(info: AttachmentInfo) { return parseAttachmentReference(attachmentReference(info)); }
function snapshotPath(store: SessionStore, record: SessionRecord) { return join(store.root, workspaceKey(record.storageWorkspace ?? record.workspace), `${record.id}.json`); }

test("project rename checks revision and every member's durable run or compaction claim", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const project = await store.projects.create("Original", workspace);
	let member = await store.save(draft(workspace, project), 0);
	const before = await readFile(snapshotPath(store, member), "utf8");
	const renamed = await store.renameProject(project.id, " Updated ", project.revision);
	assert.equal(renamed.name, "Updated");
	assert.equal(renamed.revision, 2);
	assert.equal(await readFile(snapshotPath(store, member), "utf8"), before);
	assert.equal((await store.loadAny(member.id)).projectName, "Updated");
	await assert.rejects(store.renameProject(project.id, "Stale", project.revision), code("PROJECT_CONFLICT"));
	member = await store.loadAny(member.id);
	const now = new Date().toISOString();
	member = await store.save({ ...member, attempt: { prompt: "Working", messages: [], status: "running",
		ownerPid: process.pid, startedAt: now, updatedAt: now, code: null } }, member.revision);
	await assert.rejects(store.renameProject(project.id, "Busy", renamed.revision), code("SESSION_BUSY"));
	await assert.rejects(store.previewProjectDelete(project.id), code("SESSION_BUSY"));
	member = await store.save({ ...member, attempt: null }, member.revision, undefined, { attemptOwner: { ownerPid: process.pid, startedAt: now } });
	member = await store.save({ ...member, activeOperation: { kind: "compact", id: randomUUID(), ownerPid: process.pid, startedAt: now } }, member.revision);
	await assert.rejects(store.previewProjectWorkspace(project.id, workspace), code("SESSION_BUSY"));
	assert.equal((await store.projects.load(project.id)).name, "Updated");
});

test("project directory changes update every member without moving histories, originals or workspace files", async (t) => {
	const { base, workspace, outside } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const project = await store.projects.create("Project", workspace);
	const first = await store.save({ ...draft(workspace, project), history: [{ role: "system", content: "System" },
		{ role: "user", content: `Original path ${workspace}` }, { role: "assistant", content: "Independent first history" }],
		automations: [newBoundTask({ prompt: "Scheduled task", trigger: { type: "interval", seconds: 60 }, maxRuns: 2 })] }, 0);
	const second = await store.save(draft(workspace, project), 0);
	const info = await upload(store, first);
	await writeFile(join(workspace, "untouched.txt"), "User workspace file");
	const preview = await store.previewProjectWorkspace(project.id, outside, project.revision);
	assert.equal(preview.sessionCount, 2);
	assert.equal(preview.automationCount, 1);
	assert.equal(preview.attachmentCount, 1);
	const changed = await store.changeProjectWorkspace(preview);
	assert.equal(changed.workspace, outside);
	for (const previous of [first, second]) {
		const current = await store.loadAny(previous.id);
		assert.equal(current.workspace, outside);
		assert.equal(current.storageWorkspace, workspace);
		assert.equal(current.locationRevision, 1);
		assert.equal(current.revision, previous.revision + 1);
		assert.deepEqual(current.history, previous.history);
		assert.equal(current.locationChanges?.[0]?.fromWorkspace, workspace);
		assert.equal(current.locationChanges?.[0]?.toWorkspace, outside);
		assert.equal(current.locationChanges?.[0]?.acknowledged, false);
		assert.ok(current.automations?.every((task) => !task.enabled));
	}
	const moved = await store.loadAny(second.id);
	assert.equal(Buffer.from((await store.attachments.read(target(moved), ref(info))).bytes).toString(), "Evidence");
	assert.equal(await readFile(join(workspace, "untouched.txt"), "utf8"), "User workspace file");
	await assert.rejects(stat(join(outside, "untouched.txt")), { code: "ENOENT" });
	await assert.rejects(store.attachments.list(target(first)), code("ATTACHMENT_TARGET_CHANGED"));
	await assert.rejects(store.save(first, first.revision), code("PROJECT_CONFLICT"));
});

test("project previews reject changed histories, new members, attachment lists and outside reference pins", async (t) => {
	const { base, workspace, outside } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const project = await store.projects.create("Project", workspace);
	let member = await store.save(draft(workspace, project), 0);
	let preview = await store.previewProjectWorkspace(project.id, outside);
	member = await store.save({ ...member, title: "Changed" }, member.revision);
	await assert.rejects(store.changeProjectWorkspace(preview), code("PROJECT_CONFLICT"));
	preview = await store.previewProjectWorkspace(project.id, outside);
	await store.save(draft(workspace, project), 0);
	await assert.rejects(store.changeProjectWorkspace(preview), code("PROJECT_CONFLICT"));
	let deletion = await store.previewProjectDelete(project.id);
	await upload(store, member);
	await assert.rejects(store.deleteProject(deletion), code("PROJECT_CONFLICT"));
	let privateSession = await store.save(draft(workspace), 0);
	const shared = await upload(store, privateSession);
	const fork = await store.save({ ...draft(workspace), forkedFrom: privateSession.id }, 0, privateSession);
	const sharing = await store.attachments.sharingState(target(privateSession));
	privateSession = await store.save({ ...privateSession, location: { kind: "project", projectId: project.id },
		projectRevision: project.revision, locationRevision: 1 }, privateSession.revision, undefined, { attachmentRevisionExpected: sharing.revision });
	deletion = await store.previewProjectDelete(project.id);
	await store.attachments.read(target(fork), ref(shared), { pin: true });
	await assert.rejects(store.deleteProject(deletion), code("PROJECT_CONFLICT"));
	assert.equal((await store.projects.load(project.id)).id, project.id);
});

test("deleting a project removes its members and unreferenced originals but protects outside bindings and history pins", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const project = await store.projects.create("Project", workspace);
	let member = await store.save(draft(workspace), 0);
	const activeOutside = await upload(store, member, "Outside active binding");
	const disposable = await upload(store, member, "Only project retains content");
	const pinnedOutside = await upload(store, member, "Outside historical reference");
	const fork = await store.save({ ...draft(workspace), forkedFrom: member.id }, 0, member);
	await store.attachments.remove(target(fork), ref(disposable));
	await store.attachments.read(target(fork), ref(pinnedOutside), { pin: true });
	await store.attachments.remove(target(fork), ref(pinnedOutside));
	const sharing = await store.attachments.sharingState(target(member));
	member = await store.save({ ...member, location: { kind: "project", projectId: project.id },
		projectRevision: project.revision, locationRevision: 1 }, member.revision, undefined, { attachmentRevisionExpected: sharing.revision });
	await store.attachments.read(target(member), ref(disposable), { pin: true });
	const second = await store.save(draft(workspace, project), 0);
	const ownOriginal = await upload(store, second, "Project only");
	await writeFile(join(workspace, "untouched.txt"), "Never delete project workspace files");
	const preview = await store.previewProjectDelete(project.id);
	assert.equal(preview.sessionCount, 2);
	assert.equal(preview.attachmentCount, 4);
	assert.equal(preview.retainedAttachmentCount, 2);
	assert.equal(preview.deleteAttachmentCount, 2);
	await store.deleteProject(preview);
	await assert.rejects(store.projects.load(project.id), code("PROJECT_NOT_FOUND"));
	await assert.rejects(store.loadAny(member.id), code("SESSION_NOT_FOUND"));
	await assert.rejects(store.loadAny(second.id), code("SESSION_NOT_FOUND"));
	assert.equal((await store.listAll())[0]?.id, fork.id);
	assert.equal(Buffer.from((await store.attachments.read(target(fork), ref(activeOutside))).bytes).toString(), "Outside active binding");
	for (const info of [disposable, ownOriginal]) await assert.rejects(stat(join(store.root, "attachments", "blobs", info.id, info.contentVersion)), { code: "ENOENT" });
	for (const info of [activeOutside, pinnedOutside]) assert.ok((await stat(join(store.root, "attachments", "blobs", info.id, info.contentVersion))).isFile());
	assert.equal(await readFile(join(workspace, "untouched.txt"), "utf8"), "Never delete project workspace files");
	const catalog = JSON.parse(await readFile(join(store.root, "attachments", "catalog.json"), "utf8"));
	assert.ok(catalog.deletedSessions.includes(member.id));
	assert.ok(catalog.deletedSessions.includes(second.id));
	assert.ok(catalog.bindings.every((binding: { scope: { kind: string; projectId?: string } }) => binding.scope.projectId !== project.id));
	assert.ok(catalog.pins.every((pin: { sessionId: string }) => pin.sessionId === fork.id));
});

test("project management can repair or delete a project whose old workspace disappeared", async (t) => {
	const { base, workspace, outside } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const project = await store.projects.create("Repairable", workspace);
	const member = await store.save(draft(workspace, project), 0);
	await rename(workspace, join(base, "moved-workspace"));
	assert.ok((await store.loadAny(member.id)).projectError);
	const preview = await store.previewProjectWorkspace(project.id, outside);
	assert.equal(preview.fromWorkspace, workspace);
	await store.changeProjectWorkspace(preview);
	assert.equal((await store.loadAny(member.id)).workspace, outside);
	await rename(outside, join(base, "moved-again"));
	await store.deleteProject(await store.previewProjectDelete(project.id));
	assert.deepEqual(await store.listAll(), []);
});

test("a ProjectStore reader recovers bounded directory patches without duplicating events or serializing histories", async (t) => {
	const { base, workspace, outside } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const project = await store.projects.create("Recoverable", workspace);
	const history = [{ role: "system" as const, content: "System" }, { role: "user" as const, content: "Large history ".repeat(10000) },
		{ role: "assistant" as const, content: "Saved history" }];
	const first = await store.save({ ...draft(workspace, project), history }, 0);
	const second = await store.save({ ...draft(workspace, project), history }, 0);
	const now = new Date().toISOString();
	const moves: ProjectSessionMove[] = [first, second].map((record) => ({ id: record.id, storageWorkspace: workspace,
		projectId: project.id, expectedRevision: record.revision, locationRevision: 0,
		fromWorkspace: workspace, toWorkspace: outside, changedAt: now, changeId: randomUUID() }));
	const transactions = new AttachmentTransactions(store.root, {
		load: async () => { throw new Error("Not used"); }, prepareDraft: async () => { throw new Error("Not used"); }, remove: async () => {},
		publish: async (record) => {
			await atomicJson(snapshotPath(store, record), encodeSessionRecord(record), 64 * 1024 * 1024);
			throw new Error("Injected interruption after publishing the first project member");
		},
	});
	await assert.rejects(transactions.withLock(() => transactions.commit({ catalog: emptyAttachmentCatalog(),
		projectWrite: { ...project, workspace: outside, updatedAt: now, revision: 2 }, sessionMoves: moves })), code("ATTACHMENT_RECOVERY_PENDING"));
	const journal = await readFile(join(store.root, "attachments", "pending.json"), "utf8");
	assert.ok(Buffer.byteLength(journal) < 10000);
	assert.ok(!journal.includes("Large history"));
	assert.equal((await new ProjectStore({ root: store.root }).load(project.id)).workspace, outside);
	for (const source of [first, second]) {
		const recovered = await store.loadAny(source.id);
		assert.equal(recovered.locationChanges?.length, 1);
		assert.equal(recovered.revision, 2);
		assert.deepEqual(recovered.history, source.history);
	}
	await assert.rejects(stat(join(store.root, "attachments", "pending.json")), { code: "ENOENT" });
});

test("project deletion recovery completes remaining members and project metadata after a partial removal", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const project = await store.projects.create("Delete recovery", workspace);
	const first = await store.save(draft(workspace, project), 0);
	const second = await store.save(draft(workspace, project), 0);
	const catalog = emptyAttachmentCatalog();
	catalog.deletedSessions = [first.id, second.id];
	const transactions = new AttachmentTransactions(store.root, {
		load: async () => { throw new Error("Not used"); }, prepareDraft: async () => { throw new Error("Not used"); }, publish: async () => {},
		remove: async (id, storageWorkspace) => {
			await unlink(join(store.root, workspaceKey(storageWorkspace), `${id}.json`));
			throw new Error("Injected interruption after deleting the first session");
		},
	});
	await assert.rejects(transactions.withLock(() => transactions.commit({ catalog, projectDelete: project.id,
		deletes: [first, second].map((record) => ({ id: record.id, storageWorkspace: workspace })) })), code("ATTACHMENT_RECOVERY_PENDING"));
	assert.deepEqual(await new ProjectStore({ root: store.root }).list(), []);
	assert.deepEqual(await store.listAll(), []);
	assert.ok((await stat(workspace)).isDirectory());
});

test("project management rejects a hidden corrupt member and oversized transaction batches before mutation", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const project = await store.projects.create("Bounded", workspace);
	const member = await store.save(draft(workspace, project), 0);
	const original = await readFile(snapshotPath(store, member), "utf8");
	await writeFile(snapshotPath(store, member), "{broken");
	await assert.rejects(store.previewProjectDelete(project.id), code("SESSION_CORRUPT"));
	assert.equal((await store.projects.load(project.id)).revision, 1);
	await writeFile(snapshotPath(store, member), original);
	const transactions = new AttachmentTransactions(store.root);
	const tooMany = Array.from({ length: 1001 }, () => ({ id: randomUUID(), storageWorkspace: workspace }));
	await assert.rejects(transactions.withLock(() => transactions.commit({ catalog: emptyAttachmentCatalog(), deletes: tooMany,
		projectDelete: project.id })), code("ATTACHMENT_CORRUPT"));
	assert.equal((await store.loadAny(member.id)).id, member.id);
	await assert.rejects(stat(join(store.root, "attachments", "pending.json")), { code: "ENOENT" });
});
