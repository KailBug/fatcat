import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { createTurnReporter } from "../src/execution-report.js";
import type { LoopEvent } from "../src/loop.js";
import { createDeepSeekModel } from "../src/model.js";
import { parseTokenUsage } from "../src/model-usage.js";
import type { TokenUsage } from "../src/model-usage.js";
import { Session } from "../src/session/session.js";
import { createTuiTelemetry } from "../tui/telemetry.js";
import type { TuiTelemetry } from "../tui/telemetry.js";
import type { WriteRecord } from "../src/tools/write.js";

const counts = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 };
const basic: TokenUsage = { promptTokens: 100, completionTokens: 20, totalTokens: 120 };

function request(telemetry: TuiTelemetry, iteration: number, usage: TokenUsage | null, childId?: string): void {
  for (const event of [{ type: "model_request", iteration }, { type: "model_usage", iteration, usage }] as LoopEvent[]) {
    telemetry.observe(childId ? { type: "subagent_event", callId: childId, event } : event);
  }
}

test("cache parsing supports both documented formats without inventing missing counters", () => {
  assert.deepEqual(parseTokenUsage(counts), basic);
  assert.deepEqual(parseTokenUsage({ ...counts, prompt_tokens_details: { cached_tokens: 30 } }), { ...basic, cachedPromptTokens: 30 });
  assert.deepEqual(parseTokenUsage({ ...counts, prompt_cache_hit_tokens: 40, prompt_cache_miss_tokens: 60 }), { ...basic, cachedPromptTokens: 40 });
  assert.deepEqual(parseTokenUsage({ ...counts, prompt_cache_hit_tokens: 0 }), { ...basic, cachedPromptTokens: 0 });
  assert.deepEqual(parseTokenUsage({ ...counts, prompt_cache_miss_tokens: 100 }), basic);
  assert.deepEqual(parseTokenUsage({ ...counts, prompt_cache_hit_tokens: 50,
    prompt_cache_miss_tokens: 50, prompt_tokens_details: { cached_tokens: 50 } }), { ...basic, cachedPromptTokens: 50 });
});

test("invalid or contradictory cache metadata leaves valid basic usage intact", () => {
  for (const cached of [-1, 101, 1.5, NaN, Infinity, null, "50", Number.MAX_SAFE_INTEGER + 1]) {
    assert.deepEqual(parseTokenUsage({ ...counts, prompt_cache_hit_tokens: cached }), basic);
    assert.deepEqual(parseTokenUsage({ ...counts, prompt_tokens_details: { cached_tokens: cached } }), basic);
  }
  for (const extra of [
    { prompt_cache_hit_tokens: 50, prompt_cache_miss_tokens: 49 },
    { prompt_cache_hit_tokens: 50, prompt_cache_miss_tokens: -1 },
    { prompt_cache_hit_tokens: 50, prompt_cache_miss_tokens: "50" },
    { prompt_cache_hit_tokens: 50, prompt_tokens_details: { cached_tokens: 40 } },
    { prompt_cache_hit_tokens: 50, prompt_tokens_details: { cached_tokens: null } },
  ]) assert.deepEqual(parseTokenUsage({ ...counts, ...extra }), basic);
  assert.equal(parseTokenUsage({ ...counts, total_tokens: 121, prompt_cache_hit_tokens: 50 }), null);
});

test("actual SDK response cache metadata reaches telemetry while legacy report totals stay consistent", async () => {
  const telemetry = createTuiTelemetry();
  const onEvent = createTurnReporter(telemetry.observe);
  const model = createDeepSeekModel(loadConfig({ DEEPSEEK_API_KEY: "offline-tui-only" }), async () => Response.json({
    usage: { ...counts, prompt_cache_hit_tokens: 80, prompt_cache_miss_tokens: 20 },
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Ready" } }],
  }));
  const session = new Session({ model, maxIterations: 1 });
  for (let turn = 0; turn < 2; turn++) {
    telemetry.beginTurn();
    assert.equal(await session.run("Check", { onEvent: createTurnReporter(telemetry.observe) }), "Ready");
    telemetry.finishTurn("answered");
    assert.deepEqual(telemetry.snapshot().lastReport!.tokenUsage.parent.totals, basic);
  }
  assert.equal(telemetry.snapshot().session.tokenUsage.total.cache.hitRate, 0.8);
  assert.equal(telemetry.snapshot().session.tokenUsage.total.totals!.totalTokens, 240);
  // Aggregating a second usage must have the same schema as the first report total.
  telemetry.beginTurn();
  onEvent({ type: "model_request", iteration: 1 });
  onEvent({ type: "model_usage", iteration: 1, usage: { ...basic, cachedPromptTokens: 50 } });
  onEvent({ type: "model_request", iteration: 2 });
  onEvent({ type: "model_usage", iteration: 2, usage: basic });
  onEvent({ type: "completed", iterations: 2 });
  assert.deepEqual(telemetry.snapshot().lastReport!.tokenUsage.parent.totals,
    { promptTokens: 200, completionTokens: 40, totalTokens: 240 });
});

test("cache hit rate weights only reported prompts and usage coverage includes child and missing requests", () => {
  const telemetry = createTuiTelemetry();
  telemetry.beginTurn();
  request(telemetry, 1, { ...basic, cachedPromptTokens: 80 });
  request(telemetry, 2, basic);
  request(telemetry, 1, { promptTokens: 300, completionTokens: 10, totalTokens: 310, cachedPromptTokens: 60 }, "child");
  request(telemetry, 3, null);
  const state = telemetry.snapshot();
  assert.deepEqual(state.turn.modelRequests, { parent: 3, children: 1 });
  assert.equal(state.turn.tokenUsage.total.coverage, "partial");
  assert.equal(state.turn.tokenUsage.parent.coverage, "partial");
  assert.equal(state.turn.tokenUsage.children.coverage, "complete");
  assert.deepEqual(state.turn.tokenUsage.total.totals, { promptTokens: 500, completionTokens: 50, totalTokens: 550 });
  assert.deepEqual(state.turn.tokenUsage.total.cache,
    { reportedRequests: 2, promptTokens: 400, cachedPromptTokens: 140, hitRate: 0.35 });
  assert.equal(state.turn.tokenUsage.total.reportedRequests, 3);
  assert.equal(state.turn.tokenUsage.total.attemptedRequests, 4);
});

test("zero usage and zero cache hits remain distinct from unknown or undefined ratios", () => {
  const telemetry = createTuiTelemetry();
  assert.equal(telemetry.snapshot().session.tokenUsage.total.totals, null);
  assert.equal(telemetry.snapshot().session.tokenUsage.total.cache.hitRate, null);
  telemetry.beginTurn();
  request(telemetry, 1, { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0 });
  let state = telemetry.snapshot();
  assert.equal(state.turn.tokenUsage.total.coverage, "complete");
  assert.equal(state.turn.tokenUsage.total.totals!.totalTokens, 0);
  assert.equal(state.turn.tokenUsage.total.cache.reportedRequests, 1);
  assert.equal(state.turn.tokenUsage.total.cache.hitRate, null);
  request(telemetry, 2, { ...basic, cachedPromptTokens: 0 });
  state = telemetry.snapshot();
  assert.equal(state.turn.tokenUsage.total.cache.hitRate, 0);
});

test("parent context measurements never inherit child tokens or stale request observations", () => {
  const telemetry = createTuiTelemetry();
  telemetry.beginTurn();
  request(telemetry, 1, basic);
  telemetry.observe({ type: "model_input", iteration: 1, bytes: 2000, limitBytes: 10000, accepted: true });
  request(telemetry, 1, { promptTokens: 5, completionTokens: 5, totalTokens: 10 }, "child");
  telemetry.observe({ type: "subagent_event", callId: "child",
    event: { type: "model_input", iteration: 1, bytes: 20, limitBytes: 10000, accepted: true } });
  let state = telemetry.snapshot();
  assert.equal(state.parentPromptTokens, 100);
  assert.equal(state.parentRequest!.bytes, 2000);
  telemetry.observe({ type: "model_request", iteration: 2 });
  state = telemetry.snapshot();
  assert.equal(state.parentPromptTokens, null);
  assert.equal(state.parentRequest, null);
  telemetry.observe({ type: "model_input", iteration: 2, bytes: 10001, limitBytes: 10000, accepted: false });
  telemetry.observe({ type: "stopped", code: "MODEL_CONTEXT_LIMIT" });
  telemetry.finishTurn("stopped");
  state = telemetry.snapshot();
  assert.equal(state.parentRequest!.accepted, false);
  assert.equal(state.parentPromptTokens, null);
  assert.equal(state.turn.tokenUsage.parent.coverage, "partial");
  assert.equal(state.turn.stopCode, "MODEL_CONTEXT_LIMIT");
});

test("failed turns and reset preserve process consumption and clear current conversation context", () => {
  const telemetry = createTuiTelemetry();
  telemetry.beginTurn();
  request(telemetry, 1, basic);
  telemetry.finishTurn("answered");
  telemetry.beginTurn();
  request(telemetry, 1, basic);
  telemetry.observe({ type: "stopped", code: "MODEL_TRUNCATED" });
  telemetry.finishTurn("stopped");
  assert.equal(telemetry.snapshot().conversation.completedTurns, 1);
  telemetry.resetConversation();
  const state = telemetry.snapshot();
  assert.deepEqual(state.conversation, { completedTurns: 0, resets: 1 });
  assert.equal(state.turn.status, "idle");
  assert.equal(state.turn.tokenUsage.total.totals, null);
  assert.equal(state.session.turns, 2);
  assert.equal(state.session.answered, 1);
  assert.equal(state.session.stopped, 1);
  assert.equal(state.session.tokenUsage.total.totals!.totalTokens, 240);
  assert.equal(state.parentRequest, null);
  assert.equal(state.parentPromptTokens, null);
  assert.equal(state.lastReport, null);
});

test("only Session resolution commits a successful conversation turn, including late cancellation", async () => {
  const telemetry = createTuiTelemetry();
  const controller = new AbortController();
  const session = new Session({ maxIterations: 1, model: async (_messages, _signal, observe) => {
    observe?.({ type: "model_usage", usage: basic });
    return { message: { role: "assistant", content: "Ready" }, toolCalls: [] };
  } });
  telemetry.beginTurn();
  await assert.rejects(session.run("Task", { signal: controller.signal, onEvent(event) {
    telemetry.observe(event);
    if (event.type === "completed") controller.abort();
  } }), { code: "CANCELLED" });
  telemetry.finishTurn("stopped", "CANCELLED");
  telemetry.finishTurn("stopped", "CANCELLED");
  const state = telemetry.snapshot();
  assert.equal(state.conversation.completedTurns, 0);
  assert.equal(state.session.stopped, 1);
  assert.equal(state.session.tokenUsage.total.totals!.totalTokens, 120);
});

test("child activity, reductions and shared journal observations remain independently accurate", () => {
  const telemetry = createTuiTelemetry();
  telemetry.beginTurn();
  request(telemetry, 1, basic, "child");
  assert.deepEqual(telemetry.snapshot().activeChildIds, ["child"]);
  const record: WriteRecord = { id: "write-1", path: "file.txt", operation: "create", status: "committed",
    beforeHash: null, afterHash: "fixture-hash", bytes: 3 };
  const event: LoopEvent = { type: "write_record", record };
  telemetry.observe({ type: "subagent_event", callId: "child", event });
  telemetry.observe(event);
  telemetry.observe({ type: "subagent_event", callId: "child", event: { type: "stopped", code: "MAX_ITERATIONS" } });
  telemetry.observe({ type: "context_reduction", iteration: 2, beforeBytes: 3000, afterBytes: 1000, omittedReadResults: 2 });
  telemetry.observe({ type: "tool_result", iteration: 1, callId: "child", tool: "delegate_task", ok: false });
  const state = telemetry.snapshot();
  assert.equal(state.turn.status, "running");
  assert.equal(state.turn.stopCode, null);
  assert.deepEqual(state.children, { started: 1, completed: 0, stopped: 1 });
  assert.deepEqual(state.activeChildIds, []);
  assert.equal(state.turn.writes, 1);
  assert.equal(state.session.writes, 1);
  assert.deepEqual(state.turn.contextReduction, { requests: 1, omittedReadResults: 2, bytesSaved: 2000 });
  assert.deepEqual(state.turn.toolResults, { ok: 0, errors: 1 });
});

test("unsafe aggregates stay unknown and snapshots do not expose mutable telemetry state", () => {
  const telemetry = createTuiTelemetry();
  telemetry.beginTurn();
  const maximum: TokenUsage = { promptTokens: Number.MAX_SAFE_INTEGER, completionTokens: 0,
    totalTokens: Number.MAX_SAFE_INTEGER, cachedPromptTokens: Number.MAX_SAFE_INTEGER };
  request(telemetry, 1, maximum);
  maximum.promptTokens = 0;
  assert.equal(telemetry.snapshot().session.tokenUsage.total.totals!.promptTokens, Number.MAX_SAFE_INTEGER);
  request(telemetry, 2, { ...basic, cachedPromptTokens: 50 });
  request(telemetry, 3, { ...basic, cachedPromptTokens: 50 });
  const state = telemetry.snapshot();
  assert.equal(state.session.tokenUsage.total.reportedRequests, 3);
  assert.equal(state.session.tokenUsage.total.totals, null);
  assert.equal(state.session.tokenUsage.total.cache.promptTokens, null);
  assert.equal(state.session.tokenUsage.total.cache.cachedPromptTokens, null);
  assert.equal(state.session.tokenUsage.total.cache.hitRate, null);
  state.session.turns = 900;
  state.turn.modelRequests.parent = 900;
  assert.equal(telemetry.snapshot().session.turns, 1);
  assert.equal(telemetry.snapshot().turn.modelRequests.parent, 3);
});
