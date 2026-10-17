import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { HarnessError } from "../../src/errors.js";
import { maxMemoryContentBytes, maxMemoryRecords, maxMemoryRequestBytes, maxMemoryRevisions, memoryFingerprint, memoryScopeKey } from "../../src/memory/record.js";
import type { MemoryScope, MemorySource } from "../../src/memory/record.js";
import { maxMemoryFileBytes } from "../../src/memory/files.js";
import { MemoryStore } from "../../src/memory/store.js";
import { temporaryWorkspace } from "../support/workspace.js";

const expectCode = (code: string) => (error: unknown) => error instanceof HarnessError && error.code === code;
const source = (request = "Remember this project decision", turn = 1): MemorySource => ({ sessionId: randomUUID(), request, turn });
const scope = (kind: "session" | "project"): MemoryScope => ({ kind, id: randomUUID() });
const globalScope: MemoryScope = { kind: "global" };
const scopeFile = (store: MemoryStore, scope: MemoryScope) => join(store.root!, `${memoryScopeKey(scope)}.json`);

test("memory persists scope isolation, complete source revisions, and deletion tombstones", async (t) => {
	const { base } = await temporaryWorkspace(t);
	const root = join(base, "sessions");
	const store = new MemoryStore(root);
	const project = scope("project");
	const privateScope = scope("session");
	const anotherProject = scope("project");
	const originalSource = source();
	const created = await store.create(project, "Use pnpm", originalSource);
	const privateMemory = await store.create(privateScope, "Private decision", source());
	const globalMemory = await store.create(globalScope, "Global preference", source());
	assert.equal(created.revision, 1);
	assert.deepEqual(created.source, originalSource);
	assert.deepEqual(created.changes, [{ revision: 1, content: "Use pnpm", status: "active", source: originalSource, updatedAt: created.updatedAt }]);
	assert.deepEqual(await store.list([anotherProject]), []);
	assert.deepEqual((await store.list([project, globalScope, project])).map((record) => record.id), [created.id, globalMemory.id]);
	const reopened = new MemoryStore(root);
	assert.deepEqual(await reopened.list([privateScope]), [privateMemory]);
	const correctionSource = source("Correct the package manager decision", 2);
	const corrected = await reopened.update(project, created.id, 1, "Use the pinned pnpm version", correctionSource);
	assert.equal(corrected.revision, 2);
	assert.deepEqual(corrected.source, correctionSource);
	assert.deepEqual(corrected.changes[0]?.source, originalSource);
	const deleted = await store.update(project, created.id, 2, null, source("Delete the package manager decision", 3));
	assert.equal(deleted.status, "deleted");
	assert.equal(deleted.content, "");
	assert.equal(deleted.changes.length, 3);
	assert.equal(deleted.changes[1]?.content, "Use the pinned pnpm version");
	assert.deepEqual(await reopened.list([project]), [deleted]);
	await assert.rejects(store.update(project, created.id, 3, "Resurrect", source()), expectCode("MEMORY_CONFLICT"));
	deleted.changes[0]!.content = "External mutation";
	assert.equal((await reopened.list([project]))[0]?.changes[0]?.content, "Use pnpm");
	assert.ok((await readdir(store.root!)).every((file) => file.endsWith(".json")));
});

test("memory-only stores never share state or retain caller-owned objects", async () => {
	const store = new MemoryStore();
	const privateScope = scope("session");
	const originalScope = structuredClone(privateScope);
	const originalSource = source();
	const created = await store.create(privateScope, "Private", originalSource);
	assert.equal(store.root, undefined);
	originalSource.request = "Changed outside the store";
	if (privateScope.kind !== "global") privateScope.id = randomUUID();
	created.content = "Changed return value";
	const listed = (await store.list([originalScope]))[0]!;
	assert.equal(listed.content, "Private");
	assert.equal(listed.source.request, "Remember this project decision");
	listed.changes[0]!.content = "Changed listing";
	assert.equal((await store.list([originalScope]))[0]?.changes[0]?.content, "Private");
	assert.deepEqual(await new MemoryStore().list([originalScope]), []);
});

test("memory rejects malformed identities and uses UTF-8 content and source limits", async () => {
	const store = new MemoryStore();
	const project = scope("project");
	for (const invalid of [{ kind: "project", id: "../outside" }, { kind: "session", id: "A".repeat(36) },
		{ kind: "global", id: randomUUID() }, { kind: "workspace", id: randomUUID() }]) {
		await assert.rejects(store.create(invalid as MemoryScope, "Valid", source()), expectCode("INVALID_ARGUMENTS"));
	}
	await assert.rejects(store.create(project, " \n\t", source()), expectCode("INVALID_ARGUMENTS"));
	await assert.rejects(store.create(project, "Valid", { ...source(), sessionId: "../outside" }), expectCode("INVALID_ARGUMENTS"));
	await assert.rejects(store.create(project, "Valid", { ...source(), turn: -1 }), expectCode("INVALID_ARGUMENTS"));
	await assert.rejects(store.create(project, "Valid", { ...source(), request: " " }), expectCode("INVALID_ARGUMENTS"));
	await assert.rejects(store.create(project, "a".repeat(maxMemoryContentBytes + 1), source()), expectCode("MEMORY_LIMIT"));
	await assert.rejects(store.create(project, "字".repeat(Math.ceil(maxMemoryContentBytes / 3)), source()), expectCode("MEMORY_LIMIT"));
	await assert.rejects(store.create(project, "Valid", source("a".repeat(maxMemoryRequestBytes + 1))), expectCode("MEMORY_LIMIT"));
	await store.create(project, "a".repeat(maxMemoryContentBytes), source("b".repeat(maxMemoryRequestBytes), 0));
	await assert.rejects(store.update(project, "../outside", 1, "Valid", source()), expectCode("INVALID_ARGUMENTS"));
	await assert.rejects(store.update(project, randomUUID(), 1.5, "Valid", source()), expectCode("INVALID_ARGUMENTS"));
	await assert.rejects(store.update(project, randomUUID(), 1, "Valid", source()), expectCode("MEMORY_CONFLICT"));
	assert.throws(() => new MemoryStore(" "), expectCode("INVALID_ARGUMENTS"));
});

test("memory revision and record limits retain the last valid data, including tombstones", async () => {
	const store = new MemoryStore();
	const project = scope("project");
	let record = await store.create(project, "Original", source());
	for (let revision = 2; revision < maxMemoryRevisions; revision++) {
		record = await store.update(project, record.id, record.revision, `Revision ${revision}`, source(`Correction ${revision}`, revision));
	}
	await assert.rejects(store.update(project, record.id, record.revision, "Overflow", source()), expectCode("MEMORY_LIMIT"));
	assert.deepEqual((await store.list([project]))[0], record);
	const deleted = await store.update(project, record.id, record.revision, null, source("Delete at revision limit"));
	assert.equal(deleted.revision, maxMemoryRevisions);
	assert.equal(deleted.status, "deleted");
	for (let index = 1; index < maxMemoryRecords; index++) await store.create(project, `Record ${index}`, source());
	const removable = (await store.list([project]))[1]!;
	await store.update(project, removable.id, removable.revision, null, source("Delete"));
	await assert.rejects(store.create(project, "Overflow", source()), expectCode("MEMORY_LIMIT"));
	assert.equal((await store.list([project])).length, maxMemoryRecords);
});

test("concurrent memory writers preserve every create and reject one stale correction", async (t) => {
	const { base } = await temporaryWorkspace(t);
	const root = join(base, "sessions");
	const first = new MemoryStore(root);
	const second = new MemoryStore(root);
	const project = scope("project");
	const records = await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? first : second).create(project, `Decision ${index}`, source())));
	assert.equal((await first.list([project])).length, 8);
	const original = records[0]!;
	const results = await Promise.allSettled([
		first.update(project, original.id, original.revision, "First correction", source()),
		second.update(project, original.id, original.revision, "Second correction", source()),
	]);
	assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
	const rejected = results.find((result) => result.status === "rejected");
	assert.ok(rejected?.status === "rejected" && expectCode("MEMORY_CONFLICT")(rejected.reason));
	assert.equal((await second.list([project])).find((record) => record.id === original.id)?.revision, 2);
});

test("memory scope locking protects writes from separate Node processes", async (t) => {
	const { base } = await temporaryWorkspace(t);
	const root = join(base, "sessions");
	const project = scope("project");
	const moduleUrl = new URL("../../src/memory/store.js", import.meta.url).href;
	const code = `import { MemoryStore } from ${JSON.stringify(moduleUrl)};
const store = new MemoryStore(process.argv[1]);
const scope = JSON.parse(process.argv[2]);
const source = JSON.parse(process.argv[3]);
for (let index = 0; index < 4; index++) await store.create(scope, process.argv[4] + index, source);`;
	await Promise.all(["First", "Second"].map((label) => runChild(code, [root, JSON.stringify(project), JSON.stringify(source()), label])));
	const store = new MemoryStore(root);
	const records = await store.list([project]);
	assert.equal(records.length, 8);
	assert.equal(new Set(records.map((record) => record.content)).size, 8);
	assert.deepEqual((await readdir(store.root!)).sort(), [`${memoryScopeKey(project)}.json`]);
});

test("corrupt, oversized, and mismatched memory snapshots fail closed without replacement", async (t) => {
	const { base } = await temporaryWorkspace(t);
	const store = new MemoryStore(join(base, "sessions"));
	const project = scope("project");
	await store.create(project, "Original", source());
	const path = scopeFile(store, project);
	const original = await readFile(path);
	const value = JSON.parse(original.toString());
	const corruptions = [Buffer.from("{broken"), Buffer.from([0xff]), Buffer.from(JSON.stringify({ ...value, version: 2 })),
		Buffer.from(JSON.stringify({ ...value, scope: scope("project") })),
		Buffer.from(JSON.stringify({ ...value, records: [value.records[0], value.records[0]] })),
		Buffer.from(JSON.stringify({ ...value, records: [{ ...value.records[0], content: "Different from last revision" }] })),
		Buffer.from(JSON.stringify({ ...value, records: [{ ...value.records[0], revision: 2 }] }))];
	for (const corrupt of corruptions) {
		await writeFile(path, corrupt);
		await assert.rejects(store.list([project]), expectCode("MEMORY_IO"));
		await assert.rejects(store.create(project, "New", source()), expectCode("MEMORY_IO"));
		assert.deepEqual(await readFile(path), corrupt);
	}
	const handle = await open(path, "w");
	try { await handle.truncate(maxMemoryFileBytes + 1); } finally { await handle.close(); }
	await assert.rejects(store.list([project]), expectCode("MEMORY_IO"));
	await writeFile(path, original);
	assert.equal((await store.list([project]))[0]?.content, "Original");
	assert.ok((await readdir(store.root!)).every((file) => file.endsWith(".json")));
});

test("memory cancellation while waiting on a live lock does not publish or remove that lock", async (t) => {
	const { base } = await temporaryWorkspace(t);
	const store = new MemoryStore(join(base, "sessions"));
	const project = scope("project");
	const original = await store.create(project, "Original", source());
	const path = scopeFile(store, project);
	const before = await readFile(path);
	const lockPath = join(store.root!, "store.lock");
	const lock = JSON.stringify({ pid: process.pid });
	await writeFile(lockPath, lock);
	const controller = new AbortController();
	const pending = store.update(project, original.id, 1, "Cancelled", source(), controller.signal);
	const timer = setTimeout(() => controller.abort(), 60);
	try { await assert.rejects(pending, expectCode("CANCELLED")); }
	finally { clearTimeout(timer); }
	assert.deepEqual(await readFile(path), before);
	assert.equal(await readFile(lockPath, "utf8"), lock);
	await unlink(lockPath);
	await assert.rejects(store.create(project, "Cancelled", source(), AbortSignal.abort()), expectCode("CANCELLED"));
	assert.deepEqual(await store.list([project]), [original]);
});

test("dead memory lock owners are recovered while incomplete locks remain explicit conflicts", async (t) => {
	const { base } = await temporaryWorkspace(t);
	const store = new MemoryStore(join(base, "sessions"));
	const project = scope("project");
	const original = await store.create(project, "Original", source());
	const lockPath = join(store.root!, "store.lock");
	const missingPid = 2147483647;
	assert.throws(() => process.kill(missingPid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
	await writeFile(lockPath, JSON.stringify({ pid: missingPid }));
	const corrected = await store.update(project, original.id, 1, "Recovered", source());
	assert.equal(corrected.revision, 2);
	await writeFile(lockPath, "{incomplete");
	await assert.rejects(store.create(project, "Blocked", source()), expectCode("MEMORY_CONFLICT"));
	assert.equal(await readFile(lockPath, "utf8"), "{incomplete");
	await unlink(lockPath);
	assert.deepEqual(await store.list([project]), [corrected]);
});

test("memory saves report I/O failures and remove unpublished temporary files", async (t) => {
	const { base } = await temporaryWorkspace(t);
	const root = join(base, "blocked");
	await writeFile(root, "Keep this file");
	await assert.rejects(new MemoryStore(root).create(globalScope, "Decision", source()), expectCode("MEMORY_IO"));
	assert.equal(await readFile(root, "utf8"), "Keep this file");
	const store = new MemoryStore(join(base, "sessions"));
	await store.list([globalScope]);
	await mkdir(scopeFile(store, globalScope));
	await assert.rejects(store.create(globalScope, "Decision", source()), expectCode("MEMORY_IO"));
	assert.deepEqual((await readdir(store.root!)).sort(), ["global.json"]);
});

test("joining a project moves private memory and tombstones without changing identity or provenance", async (t) => {
	const { base } = await temporaryWorkspace(t);
	for (const store of [new MemoryStore(), new MemoryStore(join(base, "sessions"))]) {
		const sessionId = randomUUID();
		const projectId = randomUUID();
		const privateScope: MemoryScope = { kind: "session", id: sessionId };
		const projectScope: MemoryScope = { kind: "project", id: projectId };
		const original = await store.create(privateScope, "Private decision", source());
		const removed = await store.create(privateScope, "Outdated decision", source());
		const deleted = await store.update(privateScope, removed.id, 1, null, source("Delete outdated decision"));
		const shared = await store.create(projectScope, "Existing project decision", source());
		await store.previewSessionMove(sessionId, projectId);
		assert.deepEqual(await store.list([privateScope]), [original, deleted]);
		await store.moveSessionToProject(sessionId, projectId);
		assert.deepEqual(await store.list([privateScope]), []);
		assert.deepEqual(await store.list([projectScope]), [shared, { ...original, scope: projectScope }, { ...deleted, scope: projectScope }]);
		await store.moveSessionToProject(sessionId, projectId);
		assert.equal((await store.list([projectScope])).length, 3);
	}
});

test("memory move replay deduplicates already-published records and refuses conflicting identities", async (t) => {
	const { base } = await temporaryWorkspace(t);
	const store = new MemoryStore(join(base, "sessions"));
	const sessionId = randomUUID();
	const projectId = randomUUID();
	const privateScope: MemoryScope = { kind: "session", id: sessionId };
	const projectScope: MemoryScope = { kind: "project", id: projectId };
	const record = await store.create(privateScope, "Decision", source());
	const moved = { ...record, scope: projectScope };
	await writeFile(scopeFile(store, projectScope), JSON.stringify({ version: 1, scope: projectScope, records: [moved] }));
	await store.previewSessionMove(sessionId, projectId);
	await store.moveSessionToProject(sessionId, projectId);
	assert.deepEqual(await store.list([privateScope]), []);
	assert.deepEqual(await store.list([projectScope]), [moved]);
	await writeFile(scopeFile(store, privateScope), JSON.stringify({ version: 1, scope: privateScope, records: [record] }));
	const changed = await store.update(projectScope, record.id, 1, "Project correction", source());
	await assert.rejects(store.previewSessionMove(sessionId, projectId), expectCode("MEMORY_CONFLICT"));
	await assert.rejects(store.moveSessionToProject(sessionId, projectId), expectCode("MEMORY_CONFLICT"));
	assert.deepEqual(await store.list([privateScope]), [record]);
	assert.deepEqual(await store.list([projectScope]), [changed]);
});

test("memory move capacity is checked before either scope changes", async () => {
	const store = new MemoryStore();
	const sessionId = randomUUID();
	const projectId = randomUUID();
	const privateScope: MemoryScope = { kind: "session", id: sessionId };
	const projectScope: MemoryScope = { kind: "project", id: projectId };
	const privateMemory = await store.create(privateScope, "Private decision", source());
	for (let index = 0; index < maxMemoryRecords; index++) await store.create(projectScope, `Project decision ${index}`, source());
	await assert.rejects(store.previewSessionMove(sessionId, projectId), expectCode("MEMORY_LIMIT"));
	await assert.rejects(store.moveSessionToProject(sessionId, projectId), expectCode("MEMORY_LIMIT"));
	assert.deepEqual(await store.list([privateScope]), [privateMemory]);
	assert.equal((await store.list([projectScope])).length, maxMemoryRecords);
});

test("memory migration rechecks the reviewed fingerprint under its store lock before changing either scope", async (t) => {
	const { base } = await temporaryWorkspace(t);
	const store = new MemoryStore(join(base, "sessions"));
	const sessionId = randomUUID();
	const projectId = randomUUID();
	const privateScope: MemoryScope = { kind: "session", id: sessionId };
	const projectScope: MemoryScope = { kind: "project", id: projectId };
	const first = await store.create(privateScope, "Reviewed decision", source());
	const second = await store.create(privateScope, "Another reviewed decision", source());
	const expected = memoryFingerprint([first, second]);
	assert.equal(memoryFingerprint([second, first]), expected);
	await store.previewSessionMove(sessionId, projectId, expected);
	await store.update(privateScope, first.id, 1, "Unreviewed correction", source("Correction after review"));
	const before = await readFile(scopeFile(store, privateScope));
	await assert.rejects(store.previewSessionMove(sessionId, projectId, expected), expectCode("MEMORY_CONFLICT"));
	assert.deepEqual(await readFile(scopeFile(store, privateScope)), before);
	await assert.rejects(readFile(scopeFile(store, projectScope)), { code: "ENOENT" });
	assert.deepEqual(await store.list([projectScope]), []);
	await store.previewSessionMove(sessionId, projectId, memoryFingerprint(await store.list([privateScope])));
});

function runChild(code: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--input-type=module", "-e", code, ...args], { windowsHide: true });
		let output = "";
		child.stdout.on("data", (chunk: Buffer) => { output += chunk.toString(); });
		child.stderr.on("data", (chunk: Buffer) => { output += chunk.toString(); });
		child.once("error", reject);
		child.once("exit", (code) => { if (code === 0) resolve(); else reject(new Error(`Memory writer exited with ${code}: ${output}`)); });
	});
}
