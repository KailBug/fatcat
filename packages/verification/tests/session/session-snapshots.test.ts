import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { HarnessError } from "@fatcat/runtime/errors";
import { encodeSessionRecord, type SessionRecord } from "@fatcat/runtime/session/record";
import { publishSessionSnapshot, readSessionSnapshot, sessionDirectory } from "@fatcat/runtime/internal/session/snapshots";
import { SessionStore } from "@fatcat/runtime/session/store";
import { temporaryWorkspace } from "../support/workspace.js";

const code = (expected: string) => (error: unknown) => error instanceof HarnessError && error.code === expected;

function draft(workspace: string): SessionRecord {
  const now = new Date().toISOString();
  return { version: 4, id: randomUUID(), workspace, name: null, title: "New session",
    createdAt: now, updatedAt: now, revision: 0, forkedFrom: null, history: [], attempt: null };
}

describe("Session snapshots and storage coordination", () => {
  it("reads stored project identity separately from fresh effective project state", async (t) => {
    const { base, workspace } = await temporaryWorkspace(t);
    const store = new SessionStore({ root: join(base, "sessions") });
    const project = await store.projects.create("Original", workspace);
    const member = await store.save({ ...draft(workspace), location: { kind: "project", projectId: project.id },
      projectRevision: project.revision }, 0);
    const directory = sessionDirectory(store.root, workspace);
    const path = join(directory, `${member.id}.json`);
    const bytes = await readFile(path);
    const stored = await readSessionSnapshot(store.root, directory, member.id);
    assert.equal(stored.workspace, "");
    assert.equal(stored.projectName, undefined);
    assert.equal(stored.projectRevision, undefined);
    assert.equal(stored.projectError, undefined);
    assert.deepEqual(stored.location, { kind: "project", projectId: project.id });

    await store.renameProject(project.id, "Renamed", project.revision);
    const current = await store.loadAny(member.id);
    assert.equal(current.workspace, workspace);
    assert.equal(current.projectName, "Renamed");
    assert.equal(current.projectRevision, project.revision + 1);
    await unlink(join(store.root, "projects", `${project.id}.json`));
    const unavailable = await store.loadAny(member.id);
    assert.equal(unavailable.workspace, "");
    assert.match(unavailable.projectError!, /^PROJECT_NOT_FOUND:/);
    assert.deepEqual(unavailable.history, member.history);
    assert.deepEqual(await readSessionSnapshot(store.root, directory, member.id), stored);
    assert.deepEqual(await readFile(path), bytes);
  });

  it("keeps missing stores absent and snapshot reads byte-for-byte unchanged", async (t) => {
    const { base, workspace } = await temporaryWorkspace(t);
    const store = new SessionStore({ root: join(base, "sessions") });
    const record = { ...draft(workspace), revision: 1 };
    assert.deepEqual(await store.listAll(), []);
    await assert.rejects(store.loadAny(record.id), code("SESSION_NOT_FOUND"));
    await assert.rejects(stat(store.root), { code: "ENOENT" });

    const directory = sessionDirectory(store.root, workspace);
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${record.id}.json`);
    const json = JSON.stringify(encodeSessionRecord(record), null, 2) + "\n";
    await writeFile(path, json);
    assert.equal((await readSessionSnapshot(store.root, directory, record.id)).version, 4);
    const loaded = await store.load(workspace, record.id);
    assert.equal(loaded.version, 4);
    assert.deepEqual(loaded.location, { kind: "standalone", workspace });
    assert.equal(await readFile(path, "utf8"), json);
    assert.deepEqual(await readdir(directory), [`${record.id}.json`]);
  });

  it("rejects snapshots in the wrong bucket without making discovery a permissive project scan", async (t) => {
    const { base, workspace, outside } = await temporaryWorkspace(t);
    const store = new SessionStore({ root: join(base, "sessions") });
    const project = await store.projects.create("Project", workspace);
    const member = await store.save({ ...draft(workspace), location: { kind: "project", projectId: project.id },
      projectRevision: project.revision }, 0);
    const directory = sessionDirectory(store.root, outside);
    await mkdir(directory);
    const bytes = await readFile(join(sessionDirectory(store.root, workspace), `${member.id}.json`));
    const path = join(directory, `${member.id}.json`);
    await writeFile(path, bytes);
    await assert.rejects(readSessionSnapshot(store.root, directory, member.id), code("SESSION_CORRUPT"));
    assert.deepEqual((await store.listAll()).map((item) => item.id), [member.id]);
    await assert.rejects(store.loadAny(member.id), code("SESSION_CORRUPT"));
    await assert.rejects(store.previewProjectDelete(project.id), code("SESSION_CORRUPT"));
    assert.deepEqual(await readFile(path), bytes);
    assert.equal((await store.projects.load(project.id)).revision, project.revision);
  });

  it("cleans failed publication and retries in the fixed storage bucket", async (t) => {
    const { base, workspace, outside } = await temporaryWorkspace(t);
    const root = join(base, "sessions");
    const record = { ...draft(outside), storageWorkspace: workspace, revision: 1 };
    const directory = sessionDirectory(root, workspace);
    const path = join(directory, `${record.id}.json`);
    await mkdir(path, { recursive: true });
    await assert.rejects(publishSessionSnapshot(root, record));
    assert.ok((await stat(path)).isDirectory());
    assert.deepEqual(await readdir(directory), [`${record.id}.json`]);
    await rmdir(path);

    await publishSessionSnapshot(root, record);
    const store = new SessionStore({ root });
    const loaded = await store.load(outside, record.id);
    assert.equal(loaded.storageWorkspace, workspace);
    assert.equal(loaded.workspace, outside);
    assert.equal(loaded.revision, 1);
    assert.deepEqual(await readdir(directory), [`${record.id}.json`]);
    await assert.rejects(stat(sessionDirectory(root, outside)), { code: "ENOENT" });
  });
});
