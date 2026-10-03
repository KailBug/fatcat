import assert from "node:assert/strict";
import { rename, unlink, writeFile, symlink, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { parseCron } from "../src/automation/cron.js";
import { parseAutomationConfig, loadAutomationConfig } from "../src/automation/config.js";
import { FileChanges } from "../src/automation/files.js";
import { acquireAutomationLock } from "../src/automation/lock.js";
import { executeActivation, runAutomations } from "../src/automation/runner.js";
import { Scheduler } from "../src/automation/scheduler.js";
import { HarnessError } from "../src/errors.js";
import type { Message, ModelTurn } from "../src/model.js";
import { SessionStore } from "../src/session/store.js";
import { createTools } from "../src/tools.js";
import { temporaryWorkspace } from "./fixtures/workspace.js";

const start = Date.parse("2026-10-02T00:00:00Z");
const answer = (): ModelTurn => ({ message: { role: "assistant", content: "Checked" }, toolCalls: [] });
const interval = { type: "interval", seconds: 60 };
const makeConfig = (trigger: unknown = interval, overrides: Record<string, unknown> = {}) => parseAutomationConfig({
  version: 1, tasks: [{ id: "check", prompt: "Inspect current state", trigger }], ...overrides,
});

test("cron handles numeric ranges, steps, Sunday aliases and day OR semantics", () => {
  const matches = (expression: string, time: string) => parseCron(expression, "UTC").matches(Date.parse(time));
  assert.equal(matches("*/15 9-17 * * 1-5", "2026-10-02T09:30:00Z"), true);
  assert.equal(matches("*/15 9-17 * * 1-5", "2026-10-03T09:30:00Z"), false);
  assert.equal(matches("0 9 1 * 1", "2026-10-01T09:00:00Z"), true);
  assert.equal(matches("0 9 1 * 1", "2026-10-05T09:00:00Z"), true);
  assert.equal(matches("0 9 1 * 1", "2026-10-06T09:00:00Z"), false);
  assert.equal(matches("0 9 * * 7", "2026-10-04T09:00:00Z"), true);
  assert.equal(matches("5/20 * * * *", "2026-10-02T00:45:00Z"), true);
  assert.equal(matches("0 0 29 2 *", "2028-02-29T00:00:00Z"), true);
  for (const expression of ["* * * *", "60 * * * *", "*/0 * * * *", "* * * * MON", "* * 1-32 * *", "* * * * ?", "* * * * 5-1"]) {
    assert.throws(() => parseCron(expression), /cron fields/);
  }
  const local = new Date(2026, 9, 2, 9, 30);
  assert.ok(parseCron("30 9 2 10 *", "local").matches(local.getTime()));
});

test("configuration rejects unbounded, unknown, duplicate and malformed inputs", () => {
  for (const value of [null, {}, { version: 2, tasks: [] }, { ...makeConfig(), permission: "allow" },
    { ...makeConfig(), maxRuns: 0 }, { ...makeConfig(), maxRuns: null }, { ...makeConfig(), maxRuntimeSeconds: 604801 },
    { ...makeConfig(), tasks: [...makeConfig().tasks, ...makeConfig().tasks] }]) {
    assert.throws(() => parseAutomationConfig(value), HarnessError);
  }
  for (const trigger of [{ type: "interval", seconds: 1 }, { type: "interval" },
    { type: "at", time: "2026-10-02T09:30:00" }, { type: "at", time: "2026-02-30T09:30:00Z" },
    { type: "cron", expression: "* * * * *", timezone: "Mars" },
    { type: "file_changed", paths: ["a.txt", "a.txt"] }, { type: "file_changed", paths: [] }, { type: "shell", command: "bad" }]) {
    assert.throws(() => makeConfig(trigger), HarnessError);
  }
  assert.equal(makeConfig().maxRuns, 20);
  assert.equal(makeConfig().maxRuntimeSeconds, 86400);
});

test("scheduler serializes, coalesces missed intervals and counts attempts against budgets", () => {
  const config = makeConfig(interval, { maxRuns: 3, tasks: [
    { id: "a", prompt: "A", trigger: interval, maxRuns: 1 },
    { id: "b", prompt: "B", trigger: interval },
  ] });
  const scheduler = new Scheduler(config, start);
  scheduler.advance(start + 59000);
  assert.equal(scheduler.take(start + 59000), undefined);
  scheduler.advance(start + 60000);
  assert.equal(scheduler.take(start + 60000)?.task.id, "a");
  scheduler.advance(start + 600000);
  assert.equal(scheduler.take(start + 600000), undefined);
  scheduler.finish();
  const second = scheduler.take(start + 600000)!;
  assert.equal(second.task.id, "b");
  assert.equal(second.scheduledAt, start + 600000);
  scheduler.finish();
  assert.equal(scheduler.take(start + 600000), undefined);
  scheduler.advance(start + 660000);
  assert.equal(scheduler.take(start + 660000)?.task.id, "b");
  scheduler.finish();
  assert.ok(scheduler.exhausted);
});

test("cron coalesces process pauses, does not refire a minute after clock rollback or replay offline one-shots", () => {
  const scheduler = new Scheduler(makeConfig({ type: "cron", expression: "*/5 * * * *", timezone: "UTC" }), start);
  scheduler.advance(start + 16 * 60000);
  assert.equal(scheduler.take(start + 16 * 60000)?.scheduledAt, start + 15 * 60000);
  scheduler.finish();
  scheduler.advance(start + 10 * 60000);
  scheduler.advance(start + 16 * 60000);
  assert.equal(scheduler.take(start + 16 * 60000), undefined);
  const past = new Scheduler(makeConfig({ type: "at", time: new Date(start).toISOString() }), start);
  assert.ok(past.exhausted);
  const once = new Scheduler(makeConfig({ type: "at", time: new Date(start + 1000).toISOString() }), start);
  once.advance(start + 2000);
  assert.ok(once.take(start + 2000));
  once.finish();
  assert.ok(once.exhausted);
  const expired = new Scheduler(makeConfig(interval, { maxRuntimeSeconds: 60 }), start);
  expired.advance(start + 60000);
  assert.equal(expired.take(start + 60000), undefined);
});

test("file events debounce bursts, aggregate paths and keep at most one queued activation per task", () => {
  const scheduler = new Scheduler(makeConfig({ type: "file_changed", paths: ["a.txt", "b.txt"], debounceMs: 1000 }), start);
  scheduler.filesChanged(["a.txt", "unknown.txt"], start);
  scheduler.filesChanged(["b.txt"], start + 500);
  scheduler.advance(start + 1000);
  assert.equal(scheduler.take(start + 1000), undefined);
  scheduler.advance(start + 1500);
  scheduler.filesChanged(["a.txt"], start + 2000);
  scheduler.advance(start + 3000);
  assert.deepEqual(scheduler.take(start + 3000)?.paths, ["a.txt", "b.txt"]);
  scheduler.finish();
  assert.equal(scheduler.take(start + 3000), undefined);
});

test("file monitor observes create, content changes, atomic saves and deletion within workspace guards", async (t) => {
  const { workspace, outside } = await temporaryWorkspace(t);
  const path = join(workspace, "notes.txt");
  const files = await FileChanges.open(workspace, ["notes.txt"]);
  await writeFile(path, "one");
  assert.deepEqual(await files.poll(), ["notes.txt"]);
  assert.deepEqual(await files.poll(), []);
  await writeFile(path, "two"); // Same size, different content.
  assert.deepEqual(await files.poll(), ["notes.txt"]);
  await writeFile(join(workspace, "save.txt"), "replacement");
  await rename(join(workspace, "save.txt"), path);
  assert.deepEqual(await files.poll(), ["notes.txt"]);
  await unlink(path);
  assert.deepEqual(await files.poll(), ["notes.txt"]);
  for (const forbidden of ["../outside/private.txt", ".env", "node_modules/a.txt", ".", "missing/a.txt"]) {
    await assert.rejects(FileChanges.open(workspace, [forbidden]));
  }
  await writeFile(path, "x".repeat(1048577));
  await assert.rejects(files.poll(), /1048576/);
  await unlink(path);
  await symlink(outside, join(workspace, "linked"), "junction");
  await assert.rejects(FileChanges.open(workspace, ["linked/private.txt"]), /relative path/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(files.poll(controller.signal), /cancelled/);
});

test("configuration loading uses bounded workspace reads and never loads executable code", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await writeFile(join(workspace, "automation.json"), JSON.stringify(makeConfig()));
  assert.equal((await loadAutomationConfig(workspace, "automation.json")).config.tasks.length, 1);
  await assert.rejects(loadAutomationConfig(workspace, "../outside/a.json"));
  await writeFile(join(workspace, "bad.json"), "{");
  await assert.rejects(loadAutomationConfig(workspace, "bad.json"), /valid JSON/);
});

test("automation lock prevents duplicate runners, refuses stale ownership and releases normally", async (t) => {
  const { base, workspace } = await temporaryWorkspace(t);
  const root = join(base, "sessions");
  const release = await acquireAutomationLock(root, workspace);
  await assert.rejects(acquireAutomationLock(root, workspace), /lock already exists/);
  await release();
  const again = await acquireAutomationLock(root, workspace);
  await again();
  assert.deepEqual(await readdir(join(root, "automation-locks")), []);
});

test("activations use fresh persistent sessions, normal tool permissions, reports and failure isolation", async (t) => {
  const { base, workspace } = await temporaryWorkspace(t);
  const store = new SessionStore({ root: join(base, "sessions") });
  const tools = await createTools(workspace, "read-only");
  const events: Record<string, unknown>[] = [];
  const requests: Message[][] = [];
  const task = makeConfig().tasks[0]!;
  const options = { workspace, store, signal: new AbortController().signal, emit: (event: Record<string, unknown>) => { events.push(event); } };
  const agent = { tools, maxIterations: 2, model: async (messages: Message[]) => {
    requests.push(structuredClone(messages));
    if (messages.at(-1)?.role === "tool") {
      assert.match(String(messages.at(-1)?.content), /PERMISSION_DENIED/);
      return answer();
    }
    const toolCalls = [{ id: "write", type: "function" as const, function: { name: "write", arguments: JSON.stringify({
      operation: "create", path: "denied.txt", content: "denied",
    }) } }];
    return { message: { role: "assistant" as const, content: null, tool_calls: toolCalls }, toolCalls };
  } };
  for (let i = 0; i < 2; i++) await executeActivation({ task, scheduledAt: start }, agent, options);
  assert.deepEqual(requests.filter((messages) => messages.at(-1)?.role === "user").map((messages) => messages.length), [2, 2]);
  assert.equal((await store.list(workspace)).length, 2);
  assert.ok(!(await readdir(workspace)).includes("denied.txt"));
  assert.equal(events.filter((event) => event.type === "execution_report").length, 2);
  await executeActivation({ task, scheduledAt: start }, { model: async () => { throw new HarnessError("MODEL_HTTP", "secret should not be emitted"); }, maxIterations: 1 }, options);
  assert.ok(events.some((event) => event.status === "failed" && event.code === "MODEL_HTTP"));
  assert.ok(!JSON.stringify(events).includes("secret should not"));
  const sessions = await store.list(workspace);
  assert.equal(sessions.filter((session) => session.interrupted).length, 1);
});

test("runner executes a real file trigger, suppresses its writes and stops at the process deadline", async (t) => {
  const { base, workspace } = await temporaryWorkspace(t);
  const path = join(workspace, "notes.txt");
  await writeFile(path, "initial");
  const store = new SessionStore({ root: join(base, "sessions") });
  const events: Record<string, unknown>[] = [];
  let changed!: Promise<void>;
  let calls = 0;
  const config = makeConfig({ type: "file_changed", paths: ["notes.txt"] }, { maxRuntimeSeconds: 5 });
  await runAutomations(config, { maxIterations: 1, model: async () => {
    calls++;
    await writeFile(path, "automated modification");
    return answer();
  } }, { workspace, store, signal: new AbortController().signal, emit: (event) => {
    events.push(event);
    if (event.type === "automation_ready") changed = writeFile(path, "external edit");
  } });
  await changed;
  assert.equal(calls, 1);
  assert.equal(events.at(-1)?.reason, "expired");
  assert.equal((await store.list(workspace)).length, 1);
  assert.deepEqual(await readdir(join(store.root, "automation-locks")), []);
});

test("runner cancellation propagates to an active turn, drops queued work and releases its lock", async (t) => {
  const { base, workspace } = await temporaryWorkspace(t);
  const store = new SessionStore({ root: join(base, "sessions") });
  const controller = new AbortController();
  const config = makeConfig({ type: "at", time: new Date(Date.now() + 150).toISOString() });
  const events: Record<string, unknown>[] = [];
  await assert.rejects(runAutomations(config, { maxIterations: 1, model: async (_messages, signal) => {
    controller.abort();
    assert.ok(signal?.aborted);
    return answer();
  } }, { workspace, store, signal: controller.signal, emit: (event) => { events.push(event); } }), /cancelled/);
  assert.ok(events.some((event) => event.status === "cancelled"));
  assert.equal(events.at(-1)?.reason, "cancelled");
  assert.deepEqual(await readdir(join(store.root, "automation-locks")), []);
});
