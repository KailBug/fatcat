import assert from "node:assert/strict";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { TestContext } from "node:test";
import { HarnessError } from "../src/errors.js";
import type { Model, ModelTurn } from "../src/model.js";
import { SessionManager } from "../src/session/manager.js";
import { SessionStore } from "../src/session/store.js";
import type { Tools } from "../src/tools.js";
import { WebContextUsage } from "../webui/context-usage.js";
import { WebUiController } from "../webui/controller.js";
import type { WebUiInfo } from "../webui/controller.js";
import { temporaryWorkspace } from "./fixtures/workspace.js";

const info: WebUiInfo = { provider: "deepseek", model: "deepseek-flash", workspace: "fixture", permission: "ask",
  shellPermission: "deny", webPermission: "deny", maxIterations: 3, maxRequestBytes: 12_345, skills: 0, warnings: [] };
const answer = (): ModelTurn => ({ message: { role: "assistant", content: "Done" }, toolCalls: [] });
const usage = (promptTokens: number) => ({ promptTokens, completionTokens: 5, totalTokens: promptTokens + 5 });

async function finished(controller: WebUiController): Promise<void> {
  const deadline = Date.now() + 5000;
  while (controller.snapshot().busy) {
    if (Date.now() > deadline) throw new Error("Fixture timed out.");
    await delay(5);
  }
}

async function controllerFor(t: TestContext, model: Model, tools?: Tools): Promise<WebUiController> {
  const { workspace } = await temporaryWorkspace(t);
  const manager = await SessionManager.open({ model, maxIterations: 3, ...(tools ? { tools } : {}) },
    { workspace, persistence: false });
  const controller = await WebUiController.create({ ...info, workspace }, manager);
  t.after(() => controller.close());
  return controller;
}

test("context usage uses exact documented model capacities and keeps unknowns distinct from zero", () => {
  const models: [string, string, number][] = [
    ["deepseek", "deepseek-flash", 1_048_576], ["deepseek", "deepseek-v4-pro", 1_048_576],
    ["kimi", "kimi-k2.6", 262_144], ["mimo", "mimo-v2.6-flash", 1_048_576],
    ["mimo", "mimo-v2.6-pro", 1_048_576], ["qwen", "qwen-plus", 1_000_000],
  ];
  for (const [provider, model, capacityTokens] of models) {
    assert.deepEqual(new WebContextUsage(provider, model).snapshot(), { promptTokens: null, capacityTokens });
  }
  for (const [provider, model] of [["deepseek", "custom"], ["other", "deepseek-flash"], ["qwen", "qwen-plus-custom"],
    ["kimi", "kimi-k2.5"], ["__proto__", "constructor"]]) {
    assert.equal(new WebContextUsage(provider!, model!).snapshot().capacityTokens, null);
  }
  const meter = new WebContextUsage("deepseek", "custom");
  meter.observe({ type: "model_usage", iteration: 1, usage: usage(150) });
  assert.deepEqual(meter.snapshot(), { promptTokens: 150, capacityTokens: null });
  meter.snapshot().promptTokens = 999;
  assert.equal(meter.snapshot().promptTokens, 150);
  meter.observe({ type: "model_usage", iteration: 2, usage: usage(290) });
  assert.equal(meter.snapshot().promptTokens, 290);
  meter.observe({ type: "model_request", iteration: 3 });
  meter.observe({ type: "model_input", iteration: 3, bytes: 100, limitBytes: 12345, accepted: false });
  assert.equal(meter.snapshot().promptTokens, null);
  meter.observe({ type: "model_usage", iteration: 3, usage: { promptTokens: 10, completionTokens: 1, totalTokens: 22 } });
  assert.equal(meter.snapshot().promptTokens, null);
  meter.observe({ type: "model_usage", iteration: 3, usage: usage(-1) });
  assert.equal(meter.snapshot().promptTokens, null);
  meter.observe({ type: "model_usage", iteration: 4, usage: usage(0) });
  assert.equal(meter.snapshot().promptTokens, 0);
  meter.observe({ type: "model_usage", iteration: 4, usage: null });
  assert.equal(meter.snapshot().promptTokens, null);
});

test("Web UI context reflects the latest parent request without child or cumulative tokens", async (t) => {
  let controller: WebUiController;
  const tools: Tools = { definitions: [], execute: async () => ({ ok: true, result: "Unused" }),
    forTurn: (onEvent) => ({ definitions: [], execute: async () => {
      onEvent?.({ type: "subagent_event", callId: "child", event: { type: "model_request", iteration: 1 } });
      onEvent?.({ type: "subagent_event", callId: "child", event: { type: "model_usage", iteration: 1, usage: usage(222) } });
      assert.equal(controller.snapshot().contextUsage.promptTokens, 90);
      return { ok: true, result: "Child completed" };
    } }) };
  let requests = 0;
  const model: Model = async (_messages, _signal, observe) => {
    requests++;
    // A new parent request clears the prior response before any transport observation.
    assert.equal(controller.snapshot().contextUsage.promptTokens, null);
    if (requests === 1) {
      observe?.({ type: "model_usage", usage: usage(90) });
      const toolCalls = [{ id: "child", type: "function" as const, function: { name: "fixture", arguments: "{}" } }];
      return { message: { role: "assistant", content: null, tool_calls: toolCalls }, toolCalls };
    }
    if (requests === 3) throw new HarnessError("MODEL_CONNECTION", "Fixture transport failed.");
    if (requests === 4) { observe?.({ type: "model_usage", usage: null }); return answer(); }
    observe?.({ type: "model_usage", usage: usage(requests === 2 ? 170 : 75) });
    if (requests === 5) throw new HarnessError("MODEL_RESPONSE", "Fixture response failed after reported usage.");
    return answer();
  };
  controller = await controllerFor(t, model, tools);
  controller.submit("Delegate"); await finished(controller);
  const state = controller.snapshot();
  assert.deepEqual(state.contextUsage, { promptTokens: 170, capacityTokens: 1_048_576 });
  assert.equal(state.turns[0]?.report?.tokenUsage.parent.totals?.promptTokens, 260);
  assert.equal(state.turns[0]?.report?.tokenUsage.children.totals?.promptTokens, 222);
  controller.submit("Transport fails"); await finished(controller);
  assert.equal(controller.snapshot().contextUsage.promptTokens, null);
  controller.submit("Missing usage"); await finished(controller);
  assert.equal(controller.snapshot().contextUsage.promptTokens, null);
  controller.submit("Response fails after usage"); await finished(controller);
  assert.equal(controller.snapshot().contextUsage.promptTokens, 75);
});

test("active session changes clear context telemetry while inactive management preserves it", async (t) => {
  let requests = 0;
  const controller = await controllerFor(t, async (_messages, _signal, observe) => {
    observe?.({ type: "model_usage", usage: usage(++requests * 10) }); return answer();
  });
  const first = controller.snapshot().current.id;
  controller.submit("First"); await finished(controller);
  assert.equal(controller.snapshot().contextUsage.promptTokens, 10);
  await controller.newSession("Second");
  assert.equal(controller.snapshot().contextUsage.promptTokens, null);
  controller.submit("Second"); await finished(controller);
  const second = controller.snapshot().current.id;
  await controller.rename("Inactive renamed", first);
  assert.equal(controller.snapshot().contextUsage.promptTokens, 20);
  await controller.deleteSession(first);
  assert.equal(controller.snapshot().contextUsage.promptTokens, 20);
  await controller.rename("Active renamed", second);
  assert.equal(controller.snapshot().contextUsage.promptTokens, 20);
  await assert.rejects(controller.resume("missing-session"), /matching in-memory session/);
  assert.equal(controller.snapshot().contextUsage.promptTokens, 20);
  await controller.fork("Branch", second);
  assert.equal(controller.snapshot().contextUsage.promptTokens, null);
  controller.submit("Branch"); await finished(controller);
  assert.equal(controller.snapshot().contextUsage.promptTokens, 30);
  await controller.resume(second);
  assert.equal(controller.snapshot().contextUsage.promptTokens, null);
  controller.submit("Resumed"); await finished(controller);
  assert.equal(controller.snapshot().contextUsage.promptTokens, 40);
  await controller.deleteSession(second);
  assert.equal(controller.snapshot().contextUsage.promptTokens, null);
  controller.submit("Replacement"); await finished(controller);
  await controller.reset();
  assert.equal(controller.snapshot().contextUsage.promptTokens, null);
});

test("restored transcripts do not fabricate context token observations", async (t) => {
  const { base, workspace } = await temporaryWorkspace(t);
  const store = new SessionStore({ root: join(base, "sessions") });
  const agent = { maxIterations: 1, model: (async (_messages, _signal, observe) => {
    observe?.({ type: "model_usage", usage: usage(42) }); return answer();
  }) satisfies Model };
  const first = await WebUiController.create({ ...info, workspace }, await SessionManager.open(agent, { workspace, store }));
  t.after(() => first.close());
  first.submit("Saved"); await finished(first);
  assert.equal(first.snapshot().contextUsage.promptTokens, 42);
  const id = first.snapshot().current.id;
  await first.close();
  const restored = await WebUiController.create({ ...info, workspace }, await SessionManager.open(agent,
    { workspace, store, selection: { resume: id } }));
  t.after(() => restored.close());
  assert.equal(restored.snapshot().turns[0]?.answer, "Done");
  assert.deepEqual(restored.snapshot().contextUsage, { promptTokens: null, capacityTokens: 1_048_576 });
});
