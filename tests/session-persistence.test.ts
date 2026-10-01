import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { open, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { HarnessError } from "../src/errors.js";
import { createTurnReporter } from "../src/execution-report.js";
import type { ReportEvent } from "../src/execution-report.js";
import type { Message, Model, ModelTurn } from "../src/model.js";
import { Session } from "../src/session/session.js";
import { SessionManager } from "../src/session/manager.js";
import { SessionStore, processAlive } from "../src/session/store.js";
import { systemPrompt } from "../src/system-prompt.js";
import { createTools } from "../src/tools.js";
import { temporaryWorkspace } from "./fixtures/workspace.js";

const answer = (content = "Ready"): ModelTurn => ({ message: { role: "assistant", content }, toolCalls: [] });
const expectCode = (code: string) => (error: unknown) => error instanceof HarnessError && error.code === code;
async function savedPath(root: string, id: string): Promise<string> {
  const directories = await readdir(root);
  return join(root, directories[0]!, `${id}.json`);
}

test("durable sessions preserve full tool history and skill text with isolated snapshots", async (t) => {
  const { base, workspace } = await temporaryWorkspace(t);
  const store = new SessionStore({ root: join(base, "sessions") });
  const tools = await createTools(workspace);
  const model: Model = async (messages) => {
    if (messages.at(-1)?.role === "tool") return answer("42");
    const toolCalls = [{ id: "reused-id", type: "function" as const,
      function: { name: "sum", arguments: '{"numbers":[17,25]}' } }];
    return { message: { role: "assistant", content: null, tool_calls: toolCalls }, toolCalls };
  };
  const first = await SessionManager.open({ model, maxIterations: 2, tools }, { workspace, store });
  await first.run("Remember amber and the skill instructions");
  const id = first.current.id;
  const file = await savedPath(store.root, id);
  const raw = JSON.parse(await readFile(file, "utf8"));
  raw.history[3].content = '{"ok":true,"result":{"kind":"skill","content":"FULL_SKILL_BODY"}}';
  raw.history[0].content = "OBSOLETE_SAVED_SYSTEM_POLICY";
  await writeFile(file, JSON.stringify(raw));
  const requests: Message[][] = [];
  const resumed = await SessionManager.open({ maxIterations: 1, model: async (messages) => {
    requests.push(structuredClone(messages)); return answer();
  } }, { workspace, store, selection: { resume: id } });
  const snapshot = resumed.history;
  snapshot.push({ role: "user", content: "MUTATED_SNAPSHOT" });
  assert.equal(resumed.current.turnCount, 1);
  await resumed.run("Continue");
  assert.equal(requests[0]?.[0]?.content, systemPrompt);
  assert.deepEqual(requests[0]?.map((message) => message.role), ["system", "user", "assistant", "tool", "assistant", "user"]);
  assert.ok(JSON.stringify(requests).includes("FULL_SKILL_BODY"));
  assert.ok(!JSON.stringify(requests).includes("MUTATED_SNAPSHOT"));
  assert.ok(!JSON.stringify(requests).includes("OBSOLETE_SAVED_SYSTEM_POLICY"));
  assert.equal(resumed.current.turnCount, 2);
});

test("new, switch, rename, fork and continue retain separate workspace histories", async (t) => {
  const { base, workspace, outside } = await temporaryWorkspace(t);
  const store = new SessionStore({ root: join(base, "sessions") });
  const agent = { model: async () => answer(), maxIterations: 1 };
  const manager = await SessionManager.open(agent, { workspace, store, selection: { name: "first" } });
  await manager.run("First prompt");
  const original = manager.current.id;
  await manager.newSession("second");
  await manager.run("Second prompt");
  const second = manager.current.id;
  await manager.resume("first");
  assert.equal(manager.current.id, original);
  await manager.rename("renamed");
  await manager.fork("alternative");
  const fork = manager.current.id;
  assert.equal(manager.current.forkedFrom, original);
  assert.equal(manager.current.turnCount, 1);
  await manager.run("Alternative direction");
  await manager.resume(original);
  assert.equal(manager.current.turnCount, 1);
  assert.ok(!JSON.stringify(manager.history).includes("Alternative direction"));
  await assert.rejects(manager.rename("second"), expectCode("SESSION_NAME"));
  assert.equal(manager.current.name, "renamed");
  await manager.resume(second);
  assert.equal(manager.history[1]?.content, "Second prompt");
  const latest = await SessionManager.open(agent, { workspace, store, selection: { continue: true } });
  assert.equal(latest.current.id, fork);
  await assert.rejects(SessionManager.open(agent, { workspace: outside, store, selection: { resume: original } }), expectCode("SESSION_NOT_FOUND"));
  assert.equal((await store.list(outside)).length, 0);
  assert.equal((await manager.list()).length, 3);
  const alias = await store.list(join(workspace, "."));
  assert.equal(alias.length, 3);
});

test("memory-only management never creates session files", async (t) => {
  const { base, workspace } = await temporaryWorkspace(t);
  const root = join(base, "must-not-exist");
  const manager = await SessionManager.open({ maxIterations: 1, model: async () => answer() },
    { workspace, store: new SessionStore({ root }), persistence: false });
  await manager.run("In memory");
  const id = manager.current.id;
  await manager.newSession("new");
  await manager.resume(id);
  await manager.fork("copy");
  assert.equal((await manager.list()).length, 3);
  assert.equal(manager.current.turnCount, 1);
  const fork = manager.current.id;
  await manager.delete(id);
  assert.equal(manager.current.id, fork);
  await manager.delete(fork);
  assert.notEqual(manager.current.id, fork);
  assert.equal(manager.current.turnCount, 0);
  assert.equal((await manager.list()).length, 2);
  await assert.rejects(readdir(root), { code: "ENOENT" });
});

test("selected session rename, fork and deletion retain independent active history", async (t) => {
  const { base, workspace } = await temporaryWorkspace(t);
  const store = new SessionStore({ root: join(base, "sessions") });
  let calls = 0;
  const manager = await SessionManager.open({ maxIterations: 1, model: async () => { calls++; return answer(); } }, { workspace, store });
  await manager.run("Source history");
  const source = manager.current.id;
  await manager.newSession("Active session");
  await manager.run("Active history");
  const active = manager.current.id;
  const history = manager.history;
  await manager.rename("Renamed source", source);
  assert.equal(manager.current.id, active);
  assert.deepEqual(manager.history, history);
  assert.equal((await store.load(workspace, source)).name, "Renamed source");
  await manager.fork("Source branch", source);
  const fork = manager.current.id;
  assert.equal(manager.current.forkedFrom, source);
  assert.equal(manager.history[1]?.content, "Source history");
  assert.ok(!JSON.stringify(manager.history).includes("Active history"));
  await manager.delete(fork, manager.current.revision);
  const fresh = manager.current.id;
  assert.notEqual(fresh, fork);
  assert.equal(manager.current.turnCount, 0);
  assert.equal(manager.current.interrupted, false);
  assert.equal(manager.current.forkedFrom, null);
  assert.deepEqual(manager.history, []);
  await assert.rejects(store.load(workspace, fork), expectCode("SESSION_NOT_FOUND"));
  await manager.delete(source);
  assert.equal(manager.current.id, fresh);
  assert.deepEqual((await manager.list()).map((item) => item.id).sort(), [active, fresh].sort());
  await assert.rejects(manager.delete(source), expectCode("SESSION_NOT_FOUND"));
  assert.equal(calls, 2);
});

test("session deletion checks workspace, revision and active owners before removing data", async (t) => {
  const { base, workspace, outside } = await temporaryWorkspace(t);
  const store = new SessionStore({ root: join(base, "sessions") });
  const agent = { maxIterations: 1, model: async () => answer() };
  const manager = await SessionManager.open(agent, { workspace, store });
  const id = manager.current.id;
  const foreign = await SessionManager.open(agent, { workspace: outside, store });
  await assert.rejects(manager.delete(foreign.current.id), expectCode("SESSION_NOT_FOUND"));
  await assert.rejects(store.delete(outside, id, manager.current.revision), expectCode("SESSION_NOT_FOUND"));
  await assert.rejects(store.delete(workspace, "../outside", manager.current.revision), expectCode("SESSION_NOT_FOUND"));
  const stale = await SessionManager.open(agent, { workspace, store, selection: { resume: id } });
  await manager.rename("Updated elsewhere");
  await assert.rejects(stale.delete(id), expectCode("SESSION_CONFLICT"));
  await assert.rejects(stale.fork(), expectCode("SESSION_CONFLICT"));
  assert.equal(stale.current.id, id);
  assert.equal((await store.list(workspace)).length, 1);
  await assert.rejects(manager.delete(id, manager.current.revision - 1), expectCode("SESSION_CONFLICT"));
  const record = await store.load(workspace, id);
  const running = await store.save({ ...record, attempt: { prompt: "Pending operation", startedAt: record.updatedAt,
    updatedAt: record.updatedAt, ownerPid: process.pid, status: "running", code: null, messages: [] } }, record.revision);
  await assert.rejects(store.delete(workspace, id, running.revision), expectCode("SESSION_BUSY"));
  const reader = await SessionManager.open(agent, { workspace, store });
  await assert.rejects(reader.delete(id), expectCode("SESSION_BUSY"));
  await assert.rejects(reader.rename("Busy rename", id), expectCode("SESSION_BUSY"));
  await assert.rejects(reader.fork("Busy fork", id), expectCode("SESSION_BUSY"));
  await assert.rejects(foreign.delete(id), expectCode("SESSION_NOT_FOUND"));
  assert.equal((await store.load(workspace, id)).attempt?.status, "running");
  assert.equal((await store.list(outside)).length, 1);
});

test("failed and cancelled partial attempts keep prior success and provide recovery data", async (t) => {
  const { base, workspace } = await temporaryWorkspace(t);
  const store = new SessionStore({ root: join(base, "sessions") });
  const manager = await SessionManager.open({ maxIterations: 1, model: async (messages) => {
    if (messages.at(-1)?.content === "Fail") throw new HarnessError("MODEL_HTTP", "Expected safe failure.");
    return answer();
  } }, { workspace, store });
  await manager.run("Keep");
  await assert.rejects(manager.run("Fail"), expectCode("MODEL_HTTP"));
  assert.equal(manager.current.turnCount, 1);
  assert.equal(manager.current.interrupted, true);
  const saved = await store.load(workspace, manager.current.id);
  assert.equal(saved.attempt?.messages.at(-1)?.content, "Fail");
  const requests: Message[][] = [];
  const abort = new AbortController();
  const resumed = await SessionManager.open({ maxIterations: 1, model: async (messages) => {
    requests.push(structuredClone(messages));
    if (messages.at(-1)?.content === "Cancelled") abort.abort();
    return answer();
  } }, { workspace, store, selection: { resume: saved.id } });
  await assert.rejects(resumed.run("Cancelled", { signal: abort.signal }), expectCode("CANCELLED"));
  assert.equal((await store.load(workspace, saved.id)).attempt?.status, "cancelled");
  await resumed.run("Continue");
  assert.ok(String(requests[0]?.[1]?.content).includes("Do not automatically replay"));
  assert.ok(!JSON.stringify(resumed.history).includes("Harness session recovery notice"));
  assert.equal(resumed.current.turnCount, 2);
  assert.equal(resumed.current.interrupted, false);
});

test("busy lifecycle and stale revisions reject work before contacting the model", async (t) => {
  const { base, workspace } = await temporaryWorkspace(t);
  const store = new SessionStore({ root: join(base, "sessions") });
  const first = await SessionManager.open({ maxIterations: 1, model: async () => answer() }, { workspace, store });
  let calls = 0;
  const stale = await SessionManager.open({ maxIterations: 1, model: async () => { calls++; return answer(); } },
    { workspace, store, selection: { resume: first.current.id } });
  await first.rename("changed");
  await assert.rejects(stale.run("Should not execute"), expectCode("SESSION_CONFLICT"));
  assert.equal(calls, 0);
  await stale.resume(first.current.id);
  let finish!: (turn: ModelTurn) => void;
  let ready!: () => void;
  const entered = new Promise<void>((resolve) => { ready = resolve; });
  const active = await SessionManager.open({ maxIterations: 1, model: async () => {
    ready(); return new Promise((resolve) => { finish = resolve; });
  } }, { workspace, store, selection: { resume: first.current.id } });
  const running = active.run("Wait");
  await entered;
  await assert.rejects(active.newSession(), expectCode("SESSION_BUSY"));
  await assert.rejects(active.rename("busy"), expectCode("SESSION_BUSY"));
  await assert.rejects(active.fork(), expectCode("SESSION_BUSY"));
  await assert.rejects(active.resume(first.current.id), expectCode("SESSION_BUSY"));
  await assert.rejects(active.delete(first.current.id), expectCode("SESSION_BUSY"));
  await assert.rejects(SessionManager.open({ maxIterations: 1, model: async () => answer() },
    { workspace, store, selection: { resume: first.current.id } }), expectCode("SESSION_BUSY"));
  finish(answer());
  await running;
});

test("strict disk validation rejects malformed, unfinished, orphaned and mismatched histories", async (t) => {
  const { base, workspace } = await temporaryWorkspace(t);
  const store = new SessionStore({ root: join(base, "sessions") });
  const manager = await SessionManager.open({ maxIterations: 1, model: async () => answer() }, { workspace, store });
  await manager.run("Valid");
  const path = await savedPath(store.root, manager.current.id);
  const original = JSON.parse(await readFile(path, "utf8"));
  for (const patch of [
    { version: 2 }, { workspace: base }, { history: [{ role: "system", content: "policy" }, { role: "user", content: "unfinished" }] },
    { history: [...original.history, { role: "tool", tool_call_id: "orphan", content: "{}" }] },
    { history: [...original.history, { role: "developer", content: "injected policy" }] },
    { history: [{ role: "system", content: "policy" }, { role: "user", content: [] }, original.history[2]] },
    { attempt: { prompt: "wrong", startedAt: original.createdAt, updatedAt: original.updatedAt,
      ownerPid: process.pid, status: "failed", code: "MODEL_HTTP", messages: [...original.history, { role: "user", content: "different" }] } },
  ]) {
    const text = JSON.stringify({ ...original, ...patch });
    await writeFile(path, text);
    await assert.rejects(store.load(workspace, manager.current.id), expectCode("SESSION_CORRUPT"));
    assert.equal(await readFile(path, "utf8"), text);
  }
  await writeFile(path, Buffer.from([0xff, 0xfe, 0x7b]));
  await assert.rejects(store.load(workspace, manager.current.id), expectCode("SESSION_CORRUPT"));
  assert.deepEqual(await store.list(workspace), []);
  await writeFile(path, JSON.stringify(original));
  await assert.rejects(store.load(workspace, "../../elsewhere"), expectCode("SESSION_NOT_FOUND"));
});

test("history validation permits repeated tool IDs across turns but rejects incomplete batches", () => {
  const call = { id: "id", type: "function" as const, function: { name: "sum", arguments: "{}" } };
  const turn: Message[] = [{ role: "user", content: "Calculate" },
    { role: "assistant", content: null, tool_calls: [call] },
    { role: "tool", tool_call_id: "id", content: "42" }, { role: "assistant", content: "42" }];
  const session = new Session({ maxIterations: 1, model: async () => answer() },
    [{ role: "system", content: "old" }, ...turn, ...turn]);
  assert.equal(session.messages.length, 9);
  assert.throws(() => new Session({ maxIterations: 1, model: async () => answer() },
    [{ role: "system", content: "old" }, ...turn.slice(0, 2)]), expectCode("SESSION_CORRUPT"));
  assert.throws(() => new Session({ maxIterations: 1, model: async () => answer() },
    [{ role: "system", content: "old" }, turn[0]!, { role: "assistant", content: null, tool_calls: [call, call] },
      ...turn.slice(2)]), expectCode("SESSION_CORRUPT"));
});

test("failed publication or checkpoint cannot report a saved answer or lose previous history", async (t) => {
  const { base, workspace } = await temporaryWorkspace(t);
  class FailingStore extends SessionStore {
    mode: "none" | "publish" | "checkpoint" = "none";
    override async save(record: Parameters<SessionStore["save"]>[0], revision: number) {
      if ((this.mode === "publish" && record.attempt === null && record.history.length > 3)
        || (this.mode === "checkpoint" && record.attempt?.messages.at(-1)?.role === "assistant")) {
        throw new HarnessError("SESSION_STORAGE", "Injected disk failure.");
      }
      return super.save(record, revision);
    }
  }
  for (const mode of ["publish", "checkpoint"] as const) {
    const store = new FailingStore({ root: join(base, mode) });
    const manager = await SessionManager.open({ maxIterations: 1, model: async () => answer() }, { workspace, store });
    await manager.run("Keep this successful turn");
    store.mode = mode;
    const events: ReportEvent[] = [];
    await assert.rejects(manager.run("Cannot save this answer", { onEvent: createTurnReporter((event) => events.push(event)) }), expectCode("SESSION_STORAGE"));
    const reports = events.filter((event) => event.type === "execution_report");
    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.report.outcome, "stopped");
    assert.equal(reports[0]?.report.stopCode, "SESSION_STORAGE");
    assert.equal(manager.current.turnCount, 1);
    assert.equal(manager.current.interrupted, true);
    assert.equal((await store.load(workspace, manager.current.id)).history.length, 3);
    assert.equal((await store.load(workspace, manager.current.id)).attempt?.status, "failed");
  }
});

test("oversized sparse session files fail before parsing and incomplete locks are actionable", async (t) => {
  const { base, workspace } = await temporaryWorkspace(t);
  const store = new SessionStore({ root: join(base, "store") });
  const manager = await SessionManager.open({ maxIterations: 1, model: async () => answer() }, { workspace, store });
  const path = await savedPath(store.root, manager.current.id);
  const handle = await open(path, "r+");
  await handle.truncate(64 * 1024 * 1024 + 1);
  await handle.close();
  await assert.rejects(store.load(workspace, manager.current.id), expectCode("SESSION_CORRUPT"));
  const directory = join(store.root, (await readdir(store.root))[0]!);
  await writeFile(join(directory, "store.lock"), "");
  await assert.rejects(manager.rename("blocked"), (error: unknown) => error instanceof HarnessError
    && error.code === "SESSION_BUSY" && error.message.includes("remove store.lock"));
});

test("storage failure happens before model work and abandoned transaction lock recovers", async (t) => {
  const { base, workspace } = await temporaryWorkspace(t);
  const root = join(base, "store");
  const store = new SessionStore({ root });
  let calls = 0;
  const manager = await SessionManager.open({ maxIterations: 1, model: async () => { calls++; return answer(); } }, { workspace, store });
  const directory = join(root, (await readdir(root))[0]!);
  await writeFile(join(directory, "store.lock"), JSON.stringify({ pid: process.pid }));
  await assert.rejects(manager.run("Blocked"), expectCode("SESSION_BUSY"));
  assert.equal(calls, 0);
  const deadPid = 2_000_000_000;
  assert.equal(processAlive(deadPid), false);
  await writeFile(join(directory, "store.lock"), JSON.stringify({ pid: deadPid }));
  await manager.run("Recovered lock");
  assert.equal(calls, 1);
  assert.ok(!(await readdir(directory)).some((file) => file.endsWith(".tmp") || file.includes("lock")));
  await writeFile(join(base, "not-directory"), "occupied");
  await assert.rejects(SessionManager.open({ maxIterations: 1, model: async () => { calls++; return answer(); } },
    { workspace, store: new SessionStore({ root: join(base, "not-directory") }) }), expectCode("SESSION_STORAGE"));
  assert.equal(calls, 1);
});

test("a forcibly ended process retains tool receipts and never replays the interrupted write", { timeout: 15000 }, async (t) => {
  const { base, workspace } = await temporaryWorkspace(t);
  const root = join(base, "store");
  const managerUrl = new URL("../src/session/manager.js", import.meta.url).href;
  const storeUrl = new URL("../src/session/store.js", import.meta.url).href;
  const toolsUrl = new URL("../src/tools.js", import.meta.url).href;
  const source = `import { SessionManager } from ${JSON.stringify(managerUrl)};
    import { SessionStore } from ${JSON.stringify(storeUrl)};
    import { createTools } from ${JSON.stringify(toolsUrl)};
    const [workspace, root] = process.argv.slice(1);
    const tools = await createTools(workspace, "workspace-write");
    const manager = await SessionManager.open({ tools, maxIterations: 3, model: async (messages) => {
      if (messages.at(-1).role === "tool") {
        process.stdout.write("CHECKPOINT_READY\\n");
        return new Promise(() => {});
      }
      const toolCalls = [{ id: "create-once", type: "function", function: { name: "write",
        arguments: JSON.stringify({ path: "receipt.txt", content: "already committed" }) } }];
      return { message: { role: "assistant", content: null, tool_calls: toolCalls }, toolCalls };
    } }, { workspace, store: new SessionStore({ root }), selection: { name: "crash-fixture" } });
    const keepAlive = setInterval(() => {}, 1000);
    await manager.run("Create the receipt"); clearInterval(keepAlive);`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", source, workspace, root], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "close");
  t.after(async () => { child.kill(); await closed; });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  await new Promise<void>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`No checkpoint received: ${stderr}`)), 10000);
    child.stdout.on("data", (chunk) => { output += String(chunk); if (output.includes("CHECKPOINT_READY")) { clearTimeout(timer); resolve(); } });
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", () => { clearTimeout(timer); reject(new Error(`Child exited before checkpoint: ${stderr}`)); });
  });
  assert.equal(await readFile(join(workspace, "receipt.txt"), "utf8"), "already committed");
  child.kill("SIGKILL");
  await closed;
  const store = new SessionStore({ root });
  const entries = await store.list(workspace);
  assert.equal(entries[0]?.interrupted, true);
  const saved = await store.load(workspace, entries[0]!.id);
  assert.equal(saved.attempt?.messages.at(-1)?.role, "tool");
  const freshTools = await createTools(workspace, "read-only");
  let modelCalls = 0;
  const resumed = await SessionManager.open({ maxIterations: 1, tools: freshTools, model: async (messages) => {
    modelCalls++;
    assert.ok(String(messages[1]?.content).includes("create-once"));
    assert.ok(String(messages[1]?.content).includes("Do not automatically replay"));
    return answer("Receipt exists; inspect before modifying.");
  } }, { workspace, store, selection: { resume: "crash-fixture" } });
  assert.equal(modelCalls, 0);
  await resumed.run("Continue safely");
  assert.equal(modelCalls, 1);
  assert.equal(freshTools.getWrites?.().length, 0);
  assert.equal(await readFile(join(workspace, "receipt.txt"), "utf8"), "already committed");
});
