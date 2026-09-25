import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { HarnessError } from "../src/errors.js";
import { createTurnReporter } from "../src/execution-report.js";
import type { ExecutionReport, ReportEvent } from "../src/execution-report.js";
import { runAgent } from "../src/loop.js";
import type { Model, ModelTurn } from "../src/model.js";
import { Session } from "../src/session.js";
import { createSubagentTools } from "../src/subagent.js";
import { createTools } from "../src/tools.js";
import type { CommandEventRecord } from "../src/tools/shell.js";
import type { WriteRecord } from "../src/tools/write.js";
import { temporaryWorkspace } from "./fixtures/workspace.js";

const answer = (content: string): ModelTurn => ({ message: { role: "assistant", content }, toolCalls: [] });
function call(id: string, name: string, args: unknown): ModelTurn {
  const toolCalls = [{ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }];
  return { message: { role: "assistant", content: null, tool_calls: toolCalls }, toolCalls };
}
function capture() {
  const events: ReportEvent[] = [];
  const onEvent = createTurnReporter((event) => events.push(event));
  return { events, onEvent, report(): ExecutionReport {
    const reports = events.filter((event) => event.type === "execution_report");
    assert.equal(reports.length, 1);
    return reports[0]!.report;
  } };
}
const command: CommandEventRecord = { id: "command-1", cwd: ".", timeoutMs: 1000, status: "completed",
  exitCode: 0, truncated: false, durationMs: 1, cleanup: "foreground-exited", outputSummaryTruncated: false };
const write: WriteRecord = { id: "write-1", path: "file.txt", operation: "create", status: "committed",
  beforeHash: null, afterHash: "fixture-hash", bytes: 3 };

test("a model claiming tests passed cannot manufacture execution evidence", async () => {
  const result = capture();
  assert.equal(await runAgent("Review", { model: async () => answer("All tests passed."), maxIterations: 1,
    onEvent: result.onEvent }), "All tests passed.");
  assert.deepEqual(result.report(), { outcome: "answered", stopCode: null, taskVerification: "not_assessed",
    modelRequests: { parent: 1, children: 0 },
    requestBytes: { parent: { checked: 0, rejected: 0, maxBytes: null }, children: { checked: 0, rejected: 0, maxBytes: null } },
    tokenUsage: { parent: { reportedRequests: 0, totals: null }, children: { reportedRequests: 0, totals: null } }, toolResults: { ok: 0, errors: 0 }, writes: [], commands: [] });
});

test("rejected tools are errors, not executed commands or writes", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const result = capture();
  let requests = 0;
  await runAgent("Try command", { maxIterations: 2, tools: await createTools(workspace), onEvent: result.onEvent,
    model: async () => ++requests === 1 ? call("denied", "shell", { command: "exit 0" }) : answer("Done") });
  assert.deepEqual(result.report().toolResults, { ok: 0, errors: 1 });
  assert.deepEqual(result.report().commands, []);
  assert.deepEqual(result.report().writes, []);
});

test("committed writes remain in failed, cancelled, and exhausted turn reports", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  for (const code of ["MODEL_HTTP", "CANCELLED", "MAX_ITERATIONS"]) {
    const result = capture();
    const tools = await createTools(workspace, "workspace-write");
    const controller = new AbortController();
    let requests = 0;
    const model: Model = async () => {
      if (++requests === 1) return call("write", "write", { path: `${code}.txt`, content: "kept" });
      if (code === "CANCELLED") controller.abort();
      if (code !== "MAX_ITERATIONS") throw new HarnessError(code, "Expected stop.");
      return call("not-executed", "write", { path: "unused.txt", content: "unused" });
    };
    await assert.rejects(runAgent("Write", { model, tools, maxIterations: 2, signal: controller.signal,
      onEvent: result.onEvent }), (error: unknown) => error instanceof HarnessError && error.code === code);
    const report = result.report();
    assert.equal(report.outcome, "stopped");
    assert.equal(report.stopCode, code);
    assert.equal(report.writes.length, 1);
    assert.equal(report.writes[0]!.status, "committed");
    assert.equal(await readFile(join(workspace, `${code}.txt`), "utf8"), "kept");
    assert.ok(!JSON.stringify(result.events).includes("kept"));
  }
});

test("child records are counted once even when its model fails after a write", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const base = await createTools(workspace, "workspace-write");
  let requests = 0;
  const child: Model = async () => {
    if (++requests === 1) return call("child-write", "write", { path: "child.txt", content: "child-only-text" });
    throw new HarnessError("MODEL_HTTP", "Child failed.");
  };
  const tools = createSubagentTools(base, child, 3);
  const result = capture();
  const model: Model = async (messages) => messages.at(-1)?.role === "user"
    ? call("delegate", "delegate_task", { task: "Write" }) : answer("Child stopped");
  await runAgent("Delegate", { tools, model, maxIterations: 2, onEvent: result.onEvent });
  assert.equal(result.report().outcome, "answered");
  assert.equal(result.report().writes.length, 1);
  assert.deepEqual(result.report().modelRequests, { parent: 2, children: 2 });
  assert.deepEqual(result.report().toolResults, { ok: 1, errors: 1 });
  assert.ok(!JSON.stringify(result.events).includes("child-only-text"));
});

test("command outcome is independent of tool ok, with explicit stale-write and truncation metadata", () => {
  const result = capture();
  const variants: Partial<CommandEventRecord>[] = [
    {}, { exitCode: 1 }, { status: "timed_out", exitCode: null, cleanup: "tree-killed" },
    { status: "output_limit", truncated: true, cleanup: "tree-killed" },
    { status: "cancelled", exitCode: null, cleanup: "tree-killed" },
    { status: "spawn_failed", exitCode: null, cleanup: "not-started" },
    { status: "termination_failed", exitCode: null, cleanup: "unconfirmed" },
    { truncated: true }, { cleanup: "unconfirmed" }, { outputSummaryTruncated: true },
  ];
  variants.forEach((variant, index) => {
    result.onEvent({ type: "shell_record", record: { ...command, ...variant, id: String(index) } });
    result.onEvent({ type: "tool_result", iteration: 1, callId: String(index), tool: "shell", ok: true });
  });
  result.onEvent({ type: "write_record", record: { ...write, status: "uncertain" } });
  result.onEvent({ type: "shell_record", record: { ...command, id: "after-write" } });
  result.onEvent({ type: "completed", iterations: 2 });
  const report = result.report();
  assert.equal(report.toolResults.ok, variants.length);
  assert.deepEqual(report.commands.map((record) => record.succeeded), [true, false, false, false, false, false, false, false, false, true, true]);
  assert.ok(report.commands.slice(0, -1).every((record) => record.laterWriteAttempt));
  assert.equal(report.commands.at(-1)!.laterWriteAttempt, false);
  assert.equal(report.writes[0]!.status, "uncertain");
  assert.equal(report.taskVerification, "not_assessed");
});

test("duplicate parent observations cannot make a child command stale, and records are copied", () => {
  const result = capture();
  const record = { ...write, status: "started" as const };
  result.onEvent({ type: "subagent_event", callId: "child", event: { type: "write_record", record } });
  result.onEvent({ type: "subagent_event", callId: "child", event: { type: "write_record", record: write } });
  result.onEvent({ type: "subagent_event", callId: "child", event: { type: "shell_record", record: command } });
  result.onEvent({ type: "subagent_event", callId: "child", event: { type: "completed", iterations: 3 } });
  assert.ok(!result.events.some((event) => event.type === "execution_report"));
  result.onEvent({ type: "shell_record", record: command });
  result.onEvent({ type: "write_record", record: write });
  record.path = "changed.txt";
  result.onEvent({ type: "completed", iterations: 2 });
  assert.equal(result.report().commands.length, 1);
  assert.equal(result.report().commands[0]!.laterWriteAttempt, false);
  assert.equal(result.report().writes.length, 1);
  assert.equal(result.report().writes[0]!.path, "file.txt");
  assert.equal(result.report().writes[0]!.status, "committed");
});

test("a new turn or reset cannot present prior journal records as new execution", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const tools = await createTools(workspace, "workspace-write");
  let requests = 0;
  const session = new Session({ tools, maxIterations: 2, model: async () => ++requests === 1
    ? call("write", "write", { path: "saved.txt", content: "saved" }) : answer("Done") });
  const first = capture();
  await session.run("Write", { onEvent: first.onEvent });
  assert.equal(first.report().writes.length, 1);
  for (const reset of [false, true]) {
    if (reset) session.reset();
    const next = capture();
    await session.run("Follow up", { onEvent: next.onEvent });
    assert.equal(next.report().writes.length, 0);
    assert.deepEqual(next.report().modelRequests, { parent: 1, children: 0 });
    assert.deepEqual(next.report().toolResults, { ok: 0, errors: 0 });
  }
  assert.equal(tools.getWrites!().length, 1);
});

test("native command followed by a write and another command preserves actual order", { skip: process.platform !== "win32" }, async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const tools = await createTools(workspace, "workspace-write", undefined, { permission: "allow" });
  const steps = [call("before", "shell", { command: "exit 1" }),
    call("edit", "write", { path: "new.txt", content: "not-in-logs" }),
    call("after", "shell", { command: "'private-output'; exit 0" }), answer("Done")];
  const result = capture();
  await runAgent("Edit and check", { tools, maxIterations: 4, model: async () => steps.shift()!, onEvent: result.onEvent });
  const report = result.report();
  assert.deepEqual(report.commands.map(({ succeeded, laterWriteAttempt }) => ({ succeeded, laterWriteAttempt })),
    [{ succeeded: false, laterWriteAttempt: true }, { succeeded: true, laterWriteAttempt: false }]);
  assert.deepEqual(report.toolResults, { ok: 3, errors: 0 });
  assert.ok(!JSON.stringify(result.events).includes("private-output"));
  assert.ok(!JSON.stringify(result.events).includes("not-in-logs"));
  assert.ok(!JSON.stringify(result.events).includes("exit 1"));
});
