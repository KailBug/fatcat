import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { HarnessError } from "../src/errors.js";
import type { ModelTurn } from "../src/model.js";
import { SessionManager } from "../src/session/manager.js";
import { SessionStore } from "../src/session/store.js";
import { temporaryWorkspace } from "./fixtures/workspace.js";

const answer = (): ModelTurn => ({ message: { role: "assistant", content: "Saved answer" }, toolCalls: [] });

for (const persistence of [true, false]) {
  test(`deferred sessions avoid empty entries across new, restart and deletion (persistent=${persistence})`, async (t) => {
    const { workspace, base } = await temporaryWorkspace(t);
    const store = new SessionStore({ root: join(base, "sessions") });
    const options = { workspace, store, persistence, deferEmptySessions: true };
    const agent = { maxIterations: 1, model: async () => answer() };
    const manager = await SessionManager.open(agent, options);
    assert.equal(manager.current.revision, 0);
    assert.deepEqual(await manager.list(), []);
    await manager.newSession();
    await manager.reset();
    assert.deepEqual(await manager.list(), []);
    await assert.rejects(readdir(store.root), { code: "ENOENT" });

    const first = manager.current.id;
    await manager.run("First conversation");
    assert.deepEqual((await manager.list()).map((item) => item.id), [first]);
    await manager.newSession();
    assert.equal((await manager.list()).length, 1);
    const second = manager.current.id;
    await manager.run("Second conversation");
    await manager.delete(first);
    assert.equal(manager.current.id, second);
    assert.equal(manager.current.turnCount, 1);
    assert.equal((await manager.list()).length, 1);
    await assert.rejects(manager.delete(second, manager.current.revision - 1), { code: "SESSION_CONFLICT" });
    assert.equal(manager.current.id, second);
    await manager.delete(second, manager.current.revision);
    assert.equal(manager.current.revision, 0);
    assert.deepEqual(manager.history, []);
    assert.deepEqual(await manager.list(), []);

    await manager.run("After deletion");
    const saved = manager.current.id;
    await manager.newSession();
    await manager.resume(saved);
    assert.equal(manager.current.turnCount, 1);
    if (persistence) {
      const reopened = await SessionManager.open(agent, options);
      assert.equal(reopened.current.revision, 0);
      assert.deepEqual((await reopened.list()).map((item) => item.id), [saved]);
      const continued = await SessionManager.open(agent, { ...options, selection: { continue: true } });
      assert.equal(continued.current.id, saved);
      assert.equal(continued.current.turnCount, 1);
    } else await assert.rejects(readdir(store.root), { code: "ENOENT" });
  });
}

test("first draft submission is saved before the model and preserves failed attempts", async (t) => {
  const { workspace, base } = await temporaryWorkspace(t);
  const store = new SessionStore({ root: join(base, "sessions") });
  const manager = await SessionManager.open({ maxIterations: 1, model: async () => {
    const saved = await store.load(workspace, manager.current.id);
    assert.equal(saved.attempt?.prompt, "First attempt");
    assert.equal(saved.attempt.status, "running");
    throw new HarnessError("MODEL_HTTP", "Injected failure.");
  } }, { workspace, store, deferEmptySessions: true });
  await assert.rejects(manager.run(" "), { code: "INPUT" });
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(manager.run("Cancelled before start", { signal: abort.signal }), { code: "CANCELLED" });
  assert.deepEqual(await manager.list(), []);
  await assert.rejects(manager.run("First attempt"), { code: "MODEL_HTTP" });
  assert.equal((await manager.list()).length, 1);
  assert.equal(manager.current.title, "First attempt");
  assert.equal(manager.current.interrupted, true);
  assert.equal((await store.load(workspace, manager.current.id)).attempt?.status, "failed");
});

test("failed draft storage and failed deletion preserve the current session", async (t) => {
  const { workspace, base } = await temporaryWorkspace(t);
  class FailingStore extends SessionStore {
    failSave = true;
    override async save(...args: Parameters<SessionStore["save"]>) {
      if (this.failSave) throw new HarnessError("SESSION_STORAGE", "Injected save failure.");
      return super.save(...args);
    }
    override async delete(..._args: Parameters<SessionStore["delete"]>): Promise<undefined> {
      throw new HarnessError("SESSION_STORAGE", "Injected deletion failure.");
    }
  }
  const store = new FailingStore({ root: join(base, "sessions") });
  let calls = 0;
  const manager = await SessionManager.open({ maxIterations: 1, model: async () => { calls++; return answer(); } },
    { workspace, store, deferEmptySessions: true });
  const draft = manager.current;
  await assert.rejects(manager.run("Cannot save"), { code: "SESSION_STORAGE" });
  assert.equal(calls, 0);
  assert.deepEqual(manager.current, draft);
  assert.deepEqual(await manager.list(), []);
  store.failSave = false;
  await manager.run("Saved on retry");
  const saved = manager.current;
  const history = manager.history;
  await assert.rejects(manager.delete(saved.id), { code: "SESSION_STORAGE" });
  assert.deepEqual(manager.current, saved);
  assert.deepEqual(manager.history, history);
  assert.equal((await manager.list()).length, 1);
});

test("explicit naming and forking still save sessions when empty sessions are deferred", async (t) => {
  const { workspace, base } = await temporaryWorkspace(t);
  const options = { workspace, store: new SessionStore({ root: join(base, "sessions") }), deferEmptySessions: true };
  const agent = { maxIterations: 1, model: async () => answer() };
  const manager = await SessionManager.open(agent, { ...options, selection: { name: "Named at launch" } });
  assert.equal((await manager.list()).length, 1);
  await manager.newSession();
  await manager.rename("Named draft");
  assert.equal((await manager.list()).length, 2);
  await manager.newSession();
  await manager.fork("Explicit empty fork");
  assert.equal(manager.current.forkedFrom, null);
  assert.equal((await manager.list()).length, 3);
  const fork = await SessionManager.open(agent, { ...options, selection: { resume: "Named at launch", fork: true } });
  assert.equal(fork.current.forkedFrom, (await options.store.load(workspace, "Named at launch")).id);
  assert.equal((await manager.list()).length, 4);
});
