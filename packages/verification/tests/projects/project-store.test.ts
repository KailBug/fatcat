import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { HarnessError } from "@fatcat/runtime/errors";
import { ProjectStore } from "@fatcat/runtime/internal/project/store";
import { decodeSessionRecord, projectIdOf, workspaceKey } from "@fatcat/runtime/session/record";
import type { SessionRecord } from "@fatcat/runtime/session/record";
import { SessionStore } from "@fatcat/runtime/session/store";
import { systemPrompt } from "@fatcat/runtime/internal/system-prompt";
import { temporaryWorkspace } from "../support/workspace.js";

const expectCode = (code: string) => (error: unknown) => error instanceof HarnessError && error.code === code;

function draft(workspace: string): SessionRecord {
	const now = new Date().toISOString();
	return { version: 4, id: randomUUID(), workspace, name: null, title: "New session",
		createdAt: now, updatedAt: now, revision: 0, forkedFrom: null, history: [], attempt: null };
}

function sessionPath(store: SessionStore, record: SessionRecord): string {
	return join(store.root, workspaceKey(record.storageWorkspace ?? record.workspace), `${record.id}.json`);
}

test("projects persist distinct identities even when they share a canonical directory", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const root = join(base, "sessions");
	const store = new ProjectStore({ root });
	assert.deepEqual(await store.list(), []);
	const first = await store.create(" First ", join(workspace, "."));
	const second = await store.create("Second", workspace);
	assert.equal(first.name, "First");
	assert.equal(first.workspace, workspace);
	assert.notEqual(first.id, second.id);
	const reopened = new ProjectStore({ root });
	assert.deepEqual(await reopened.load(first.id), first);
	assert.equal((await reopened.list()).length, 2);
	assert.deepEqual(await new SessionStore({ root }).listAll(), []);
	await assert.rejects(store.create("Bad", join(base, "missing")), expectCode("PROJECT_WORKSPACE"));
	await assert.rejects(store.create("\n", workspace), expectCode("PROJECT_NAME"));
	assert.equal((await store.list()).length, 2);
});

test("project snapshots persist only their association and resolve their workspace from the project", async (t) => {
	const { base, workspace, outside } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const project = await store.projects.create("Shared project", outside);
	const original = await store.save(draft(workspace), 0);
	const joined = await store.save({ ...original, workspace: outside, projectRevision: project.revision,
		location: { kind: "project", projectId: project.id }, locationRevision: 1 }, original.revision);
	const disk = JSON.parse(await readFile(sessionPath(store, joined), "utf8"));
	assert.equal(disk.workspace, undefined);
	assert.equal(disk.projectName, undefined);
	assert.equal(disk.projectRevision, undefined);
	assert.equal(disk.storageWorkspace, workspace);
	assert.deepEqual(disk.location, { kind: "project", projectId: project.id });
	const reopened = await new SessionStore({ root: store.root }).loadAny(joined.id);
	assert.equal(reopened.workspace, outside);
	assert.equal(reopened.projectName, project.name);
	assert.equal(reopened.projectRevision, project.revision);
	assert.equal((await store.list(outside))[0]?.projectId, project.id);
	await assert.rejects(store.save({ ...joined, workspace }, joined.revision), expectCode("PROJECT_CONFLICT"));
	await assert.rejects(store.save({ ...joined, projectRevision: 99 }, joined.revision), expectCode("PROJECT_CONFLICT"));
	await assert.rejects(store.save({ ...joined, location: { kind: "standalone", workspace: outside } }, joined.revision),
		expectCode("PROJECT_LOCATION"));
	const invalid = { ...disk, location: { ...disk.location, workspace: outside } };
	assert.throws(() => decodeSessionRecord(invalid, workspace, joined.id), expectCode("SESSION_CORRUPT"));
});

test("missing or corrupt projects retain session listings and history without a fallback directory", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const project = await store.projects.create("Unavailable", workspace);
	const saved = await store.save({ ...draft(workspace), projectRevision: project.revision,
		location: { kind: "project", projectId: project.id },
		history: [{ role: "system", content: systemPrompt }, { role: "user", content: "Remember this" },
			{ role: "assistant", content: "Saved" }] }, 0);
	const projectPath = join(store.projects.root, `${project.id}.json`);
	const projectBytes = await readFile(projectPath, "utf8");
	for (const corrupt of [false, true]) {
		if (corrupt) await writeFile(projectPath, "{invalid");
		else await unlink(projectPath);
		const unavailable = await store.loadAny(saved.id);
		assert.equal(unavailable.workspace, "");
		assert.equal(unavailable.history[1]?.content, "Remember this");
		assert.match(unavailable.projectError ?? "", corrupt ? /PROJECT_CORRUPT/ : /PROJECT_NOT_FOUND/);
		assert.equal((await store.listAll())[0]?.projectId, project.id);
		await assert.rejects(store.save(unavailable, unavailable.revision), expectCode("PROJECT_CONFLICT"));
		await writeFile(projectPath, projectBytes);
	}
	await rename(workspace, join(base, "renamed-workspace"));
	const unavailable = await store.loadAny(saved.id);
	assert.equal(unavailable.workspace, "");
	assert.match(unavailable.projectError ?? "", /SESSION_WORKSPACE/);
});

test("session compare-and-save prevents stale migration and requires the active turn's ownership", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const project = await store.projects.create("Target", workspace);
	const saved = await store.save(draft(workspace), 0);
	const now = new Date().toISOString();
	const running = await store.save({ ...saved, attempt: { prompt: "Run", status: "running", code: null,
		ownerPid: process.pid, startedAt: now, updatedAt: now, messages: [] } }, saved.revision);
	const migrate = { ...running, location: { kind: "project" as const, projectId: project.id }, projectRevision: project.revision };
	await assert.rejects(store.save(migrate, saved.revision), expectCode("SESSION_CONFLICT"));
	await assert.rejects(store.save(migrate, running.revision), expectCode("SESSION_BUSY"));
	await assert.rejects(store.save({ ...running, attempt: null }, running.revision, undefined,
		{ attemptOwner: { ownerPid: process.pid, startedAt: "wrong" } }), expectCode("SESSION_BUSY"));
	const completed = await store.save({ ...running, attempt: null }, running.revision, undefined,
		{ attemptOwner: { ownerPid: process.pid, startedAt: now } });
	const joined = await store.save({ ...completed, location: migrate.location, projectRevision: project.revision }, completed.revision);
	assert.equal(projectIdOf(joined), project.id);
});

test("compact claims prevent rename, fork and deletion until their own durable release", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const saved = await store.save(draft(workspace), 0);
	const claim = { kind: "compact" as const, id: randomUUID(), ownerPid: process.pid, startedAt: new Date().toISOString() };
	const claimed = await store.save({ ...saved, activeOperation: claim }, saved.revision);
	await assert.rejects(store.save({ ...claimed, name: "Rename" }, claimed.revision), expectCode("SESSION_BUSY"));
	await assert.rejects(store.save({ ...draft(workspace), forkedFrom: claimed.id }, 0, claimed), expectCode("SESSION_BUSY"));
	await assert.rejects(store.delete(workspace, claimed.id, claimed.revision), expectCode("SESSION_BUSY"));
	const { activeOperation: _, ...released } = claimed;
	await assert.rejects(store.save(released, claimed.revision, undefined, { operationId: randomUUID() }), expectCode("SESSION_BUSY"));
	const finished = await store.save(released, claimed.revision, undefined, { operationId: claim.id });
	assert.equal(finished.activeOperation, undefined);
	await store.delete(workspace, finished.id, finished.revision);
	assert.deepEqual(await store.listAll(), []);
});

test("project and session lock conflicts leave the previous snapshot intact", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const project = await store.projects.create("Locked", workspace);
	const saved = await store.save(draft(workspace), 0);
	const bytes = await readFile(sessionPath(store, saved), "utf8");
	const projectLock = join(store.projects.root, "store.lock");
	await writeFile(projectLock, JSON.stringify({ pid: process.pid }));
	await assert.rejects(store.save({ ...saved, location: { kind: "project", projectId: project.id },
		projectRevision: project.revision }, saved.revision), expectCode("PROJECT_BUSY"));
	await unlink(projectLock);
	const lock = join(store.root, workspaceKey(workspace), "store.lock");
	await writeFile(lock, JSON.stringify({ pid: process.pid }));
	await assert.rejects(store.save({ ...saved, title: "Failed update" }, saved.revision), expectCode("SESSION_BUSY"));
	await unlink(lock);
	assert.equal(await readFile(sessionPath(store, saved), "utf8"), bytes);
	assert.ok(!(await readdir(join(store.root, workspaceKey(workspace)))).some((name) => name.endsWith(".tmp")));
});

test("location event bounds and malformed operation owners are rejected before publishing", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const saved = await store.save(draft(workspace), 0);
	const changes = Array.from({ length: 101 }, () => ({ id: randomUUID(),
		from: { kind: "standalone" as const, workspace }, to: { kind: "standalone" as const, workspace },
		fromWorkspace: workspace, toWorkspace: workspace, changedAt: new Date().toISOString(), acknowledged: false }));
	await assert.rejects(store.save({ ...saved, locationChanges: changes }, saved.revision), expectCode("SESSION_CORRUPT"));
	await assert.rejects(store.save({ ...saved, activeOperation: { kind: "compact", id: randomUUID(), ownerPid: 0,
		startedAt: new Date().toISOString() } }, saved.revision), expectCode("SESSION_CORRUPT"));
	assert.equal((await store.loadAny(saved.id)).revision, saved.revision);
});

test("project forks and deletion preserve other histories and the project record", async (t) => {
	const { base, workspace, outside } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const project = await store.projects.create("Shared", outside);
	const original = await store.save({ ...draft(outside), storageWorkspace: workspace, projectRevision: project.revision,
		location: { kind: "project", projectId: project.id } }, 0);
	const fork = await store.save({ ...original, id: randomUUID(), revision: 0, forkedFrom: original.id }, 0, original);
	assert.equal(projectIdOf(fork), project.id);
	await assert.rejects(store.save({ ...draft(outside), storageWorkspace: workspace, forkedFrom: original.id }, 0, original),
		expectCode("PROJECT_LOCATION"));
	const replacement = { ...draft(outside), storageWorkspace: workspace, projectRevision: project.revision,
		location: { kind: "project" as const, projectId: project.id } };
	const next = await store.delete(workspace, original.id, original.revision, replacement);
	assert.equal(next?.workspace, outside);
	assert.equal(projectIdOf(next!), project.id);
	assert.deepEqual(await store.projects.load(project.id), project);
	assert.deepEqual((await store.listAll()).map((entry) => entry.id).sort(), [fork.id, replacement.id].sort());
});
