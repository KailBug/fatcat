import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createAgent } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import { createTurnReporter } from "../src/execution-report.js";
import type { ExecutionReport, ReportEvent } from "../src/execution-report.js";
import { runAgent } from "../src/loop.js";
import { createDeepSeekModel } from "../src/model.js";
import type { Message, ModelObservation } from "../src/model.js";
import { Session } from "../src/session.js";
import { createTools } from "../src/tools.js";
import type { Tools } from "../src/tools.js";
import { temporaryWorkspace } from "./fixtures/workspace.js";

const config = loadConfig({ DEEPSEEK_API_KEY: "offline-budget-only" });
const usage = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 };
function response(content = "Ready", counts: unknown = usage) {
  return { usage: counts, choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] };
}
function call(name: string, args: unknown, id = name) {
  return { usage, choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null,
    tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] };
}
function recorder() {
  const events: ReportEvent[] = [];
  const onEvent = createTurnReporter((event) => events.push(event));
  return { events, onEvent, report(): ExecutionReport {
    const reports = events.filter((event) => event.type === "execution_report");
    assert.equal(reports.length, 1);
    return reports[0]!.report;
  } };
}

// Check actual SDK serialization, not a second copy of the request builder.
test("the budget counts UTF-8, JSON escaping and tools, accepts the exact boundary and blocks before transport", async () => {
  const messages: Message[] = [{ role: "user", content: "\u4e2d\u6587 \"\\\n \u{1f408}" }];
  let bytes = 0;
  let sent = 0;
  const transport: typeof fetch = async (input, init) => {
    const payload = await new Request(input, init).text();
    bytes = Buffer.byteLength(payload);
    assert.ok(bytes > Buffer.byteLength(JSON.stringify(messages)));
    sent++;
    return Response.json(response());
  };
  await createDeepSeekModel(config, transport)(messages);
  const limit = bytes;
  const events: ModelObservation[] = [];
  await createDeepSeekModel({ ...config, maxRequestBytes: limit }, transport)(messages, undefined, (event) => events.push(event));
  assert.deepEqual(events[0], { type: "model_input", bytes: limit, limitBytes: limit, accepted: true });
  const blocked: ModelObservation[] = [];
  await assert.rejects(createDeepSeekModel({ ...config, maxRequestBytes: limit - 1 }, transport)(messages, undefined,
    (event) => blocked.push(event)), { code: "MODEL_CONTEXT_LIMIT" });
  assert.equal(sent, 2);
  assert.deepEqual(blocked, [{ type: "model_input", bytes: limit, limitBytes: limit - 1, accepted: false }]);
  assert.ok(!JSON.stringify(blocked).includes("offline-budget-only"));
});

test("programmatic models cannot disable the request budget with invalid numbers", () => {
  for (const maxRequestBytes of [0, -1, NaN, Infinity, 1.5, 16777217]) {
    assert.throws(() => createDeepSeekModel({ ...config, maxRequestBytes }), { code: "CONFIG" });
  }
});

test("valid zero usage differs from absent or invalid provider counters, without rejecting an answer", async () => {
  const invalid = [undefined, null, [], {}, "private-usage-text",
    { ...usage, prompt_tokens: -1 }, { ...usage, completion_tokens: 1.5 },
    { ...usage, total_tokens: 151 }, { ...usage, total_tokens: "150" },
    { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1, total_tokens: Number.MAX_SAFE_INTEGER + 1 }];
  for (const counts of [usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, ...invalid]) {
    const data = response();
    data.usage = counts;
    const observations: ModelObservation[] = [];
    const model = createDeepSeekModel(config, async () => Response.json(data));
    assert.equal((await model([{ role: "user", content: "safe" }], undefined, (event) => observations.push(event))).message.content, "Ready");
    const result = observations.find((event) => event.type === "model_usage")!;
    assert.deepEqual(result.usage, counts === usage ? { promptTokens: 120, completionTokens: 30, totalTokens: 150 }
      : invalid.includes(counts) ? null : { promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    assert.ok(!JSON.stringify(observations).includes("private-usage-text"));
  }
});

test("received usage survives invalid and truncated responses and cancellation after delivery", async () => {
  for (const reason of ["length", "unsupported"]) {
    const data = response();
    data.choices[0]!.finish_reason = reason;
    const capture = recorder();
    await assert.rejects(runAgent("Task", { model: createDeepSeekModel(config, async () => Response.json(data)),
      maxIterations: 1, onEvent: capture.onEvent }), { code: reason === "length" ? "MODEL_TRUNCATED" : "MODEL_RESPONSE" });
    assert.deepEqual(capture.report().tokenUsage.parent, { reportedRequests: 1,
      totals: { promptTokens: 120, completionTokens: 30, totalTokens: 150 } });
  }
  const controller = new AbortController();
  const capture = recorder();
  await assert.rejects(runAgent("Task", { model: createDeepSeekModel(config, async () => Response.json(response())),
    maxIterations: 1, signal: controller.signal, onEvent(event) {
      capture.onEvent(event);
      if (event.type === "model_usage") controller.abort();
    } }), { code: "CANCELLED" });
  assert.equal(capture.report().tokenUsage.parent.reportedRequests, 1);
});

test("parent and child usage stays separate and guidance plus delegate schema enter the budget", async () => {
  const agent = createAgent(config, await createTools(), async (input, init) => {
    const body = await new Request(input, init).json() as { messages: Message[]; tools: { function: { name: string } }[] };
    const parent = body.tools.some((tool) => tool.function.name === "delegate_task");
    if (parent && body.messages.at(-1)?.role === "user") return Response.json(call("delegate_task", { task: "Independent check" }));
    return Response.json(response("Ready", parent ? usage : { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }));
  });
  const capture = recorder();
  await runAgent("Investigate", { ...agent, onEvent: capture.onEvent });
  const report = capture.report();
  assert.deepEqual(report.modelRequests, { parent: 2, children: 1 });
  assert.deepEqual(report.tokenUsage, {
    parent: { reportedRequests: 2, totals: { promptTokens: 240, completionTokens: 60, totalTokens: 300 } },
    children: { reportedRequests: 1, totals: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } },
  });
  assert.equal(report.requestBytes.parent.checked, 2);
  assert.equal(report.requestBytes.children.checked, 1);
  assert.ok(report.requestBytes.parent.maxBytes! > report.requestBytes.children.maxBytes!);
});

test("partial provider usage is never presented as complete and earlier totals survive transport failure", async () => {
  let sent = 0;
  const model = createDeepSeekModel(config, async () => {
    if (++sent === 1) return Response.json(call("sum", { numbers: [2, 3] }));
    return Response.json({ error: { message: "private-provider-error" } }, { status: 500 });
  });
  const capture = recorder();
  await assert.rejects(runAgent("Sum", { model, maxIterations: 2, onEvent: capture.onEvent }), { code: "MODEL_HTTP" });
  assert.equal(capture.report().modelRequests.parent, 2);
  assert.equal(capture.report().tokenUsage.parent.reportedRequests, 1);
  assert.equal(capture.report().tokenUsage.parent.totals!.totalTokens, 150);
  assert.ok(!JSON.stringify(capture.events).includes("private-provider-error"));
});

test("budget failure after a committed edit keeps execution facts across reset without sending oversized history", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await writeFile(join(workspace, "code.ts"), "before");
  const base = await createTools(workspace, "workspace-write");
  // A large result represents accumulated reads while preserving the real write journal.
  const tools: Tools = { ...base, async execute(...args) {
    const result = await base.execute(...args);
    return result.ok ? { ok: true, result: "large-result-" + "x".repeat(30000) } : result;
  } };
  let sent = 0;
  const model = createDeepSeekModel({ ...config, maxRequestBytes: 18000 }, async (input, init) => {
    const body = await new Request(input, init).json() as { messages: Message[] };
    if (++sent === 1) return Response.json(call("write", { path: "code.ts", oldText: "before", newText: "after" }));
    assert.ok(JSON.stringify(body.messages).includes("Harness workspace write records"));
    assert.ok(!JSON.stringify(body.messages).includes("large-result-"));
    return Response.json(response());
  }, tools);
  const session = new Session({ model, tools, maxIterations: 3 });
  const failed = recorder();
  await assert.rejects(session.run("Edit", { onEvent: failed.onEvent }), { code: "MODEL_CONTEXT_LIMIT" });
  assert.equal(sent, 1);
  assert.equal(await readFile(join(workspace, "code.ts"), "utf8"), "after");
  assert.equal(failed.report().writes[0]!.status, "committed");
  assert.equal(failed.report().requestBytes.parent.rejected, 1);
  assert.equal(failed.report().tokenUsage.parent.reportedRequests, 1);
  assert.ok(!JSON.stringify(failed.events).includes("large-result-"));
  session.reset();
  const next = recorder();
  assert.equal(await session.run("Inspect recorded state", { onEvent: next.onEvent }), "Ready");
  assert.equal(next.report().writes.length, 0);
  assert.equal(next.report().tokenUsage.parent.reportedRequests, 1);
});

test("a blocked follow-up preserves successful history and reset explicitly starts a smaller request", async () => {
  let sent = 0;
  const model = createDeepSeekModel({ ...config, maxRequestBytes: 14000 }, async (input, init) => {
    const body = await new Request(input, init).json() as { messages: Message[] };
    sent++;
    const last = body.messages.at(-1)!.content;
    if (last === "history") assert.ok(JSON.stringify(body.messages).includes("remember-me"));
    if (last === "fresh") assert.ok(!JSON.stringify(body.messages).includes("remember-me"));
    return Response.json(response("Ready"));
  });
  const session = new Session({ model, maxIterations: 1 });
  await session.run("remember-me");
  await assert.rejects(session.run("private-large-prompt" + "x".repeat(15000)), { code: "MODEL_CONTEXT_LIMIT" });
  assert.equal(sent, 1);
  await session.run("history");
  session.reset();
  const capture = recorder();
  await session.run("fresh", { onEvent: capture.onEvent });
  assert.equal(capture.report().modelRequests.parent, 1);
  assert.equal(capture.report().tokenUsage.parent.reportedRequests, 1);
});

test("overflowing token aggregates stay unknown and reports own their copies", () => {
  const capture = recorder();
  const counts = { promptTokens: Number.MAX_SAFE_INTEGER, completionTokens: 0, totalTokens: Number.MAX_SAFE_INTEGER };
  capture.onEvent({ type: "model_usage", iteration: 1, usage: counts });
  counts.promptTokens = 0;
  capture.onEvent({ type: "model_usage", iteration: 2, usage: { promptTokens: 1, completionTokens: 0, totalTokens: 1 } });
  capture.onEvent({ type: "model_usage", iteration: 3, usage: { promptTokens: 1, completionTokens: 0, totalTokens: 1 } });
  capture.onEvent({ type: "completed", iterations: 3 });
  assert.deepEqual(capture.report().tokenUsage.parent, { reportedRequests: 3, totals: null });
});


test("child request overflow becomes a bounded tool failure and cannot send the oversized body", async () => {
  let sent = 0;
  const base = await createTools();
  const tools: Tools = { ...base, async execute() { return { ok: true, result: "x".repeat(30000) }; } };
  const agent = createAgent({ ...config, maxRequestBytes: 14000 }, tools, async (input, init) => {
    sent++;
    const body = await new Request(input, init).json() as { messages: Message[]; tools: { function: { name: string } }[] };
    const parent = body.tools.some((tool) => tool.function.name === "delegate_task");
    if (!parent) return Response.json(call("sum", { numbers: [2, 3] }));
    if (body.messages.at(-1)?.role === "user") return Response.json(call("delegate_task", { task: "Add two numbers" }));
    assert.match(JSON.stringify(body.messages.at(-1)), /SUBAGENT_FAILED.*MODEL_CONTEXT_LIMIT/);
    return Response.json(response("The child reached its request limit."));
  });
  const capture = recorder();
  await runAgent("Task", { ...agent, onEvent: capture.onEvent });
  assert.equal(sent, 3);
  assert.deepEqual(capture.report().modelRequests, { parent: 2, children: 2 });
  assert.equal(capture.report().requestBytes.children.rejected, 1);
  assert.equal(capture.report().tokenUsage.children.reportedRequests, 1);
  assert.equal(capture.report().toolResults.errors, 1);
});

test("reset cannot erase large command facts just to make the next request fit", async () => {
  let sent = 0;
  const base = await createTools();
  const tools: Tools = { ...base, getCommands: () => Array.from({ length: 5 }, (_, index) => ({ id: `earlier-command-${index}`, command: "x".repeat(3000), cwd: ".",
    timeoutMs: 1000, status: "completed", exitCode: 0, stdout: "", stderr: "", truncated: false,
    durationMs: 1, cleanup: "foreground-exited", outputSummaryTruncated: false })) };
  const model = createDeepSeekModel({ ...config, maxRequestBytes: 14000 }, async () => {
    sent++;
    return Response.json(response());
  }, tools);
  const session = new Session({ model, tools, maxIterations: 1 });
  for (let attempt = 0; attempt < 2; attempt++) {
    const capture = recorder();
    await assert.rejects(session.run("Task", { onEvent: capture.onEvent }), { code: "MODEL_CONTEXT_LIMIT" });
    assert.equal(capture.report().requestBytes.parent.rejected, 1);
    assert.equal(capture.report().commands.length, 0);
    assert.equal(capture.report().tokenUsage.parent.totals, null);
    session.reset();
  }
  assert.equal(sent, 0);
  assert.equal(tools.getCommands!().length, 5);
});
