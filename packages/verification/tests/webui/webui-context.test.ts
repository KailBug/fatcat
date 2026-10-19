import assert from "node:assert/strict";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { TestContext } from "node:test";
import { HarnessError } from "@fatcat/runtime/errors";
import type { Model, ModelTurn } from "@fatcat/runtime/model";
import { SessionManager } from "@fatcat/runtime/session/manager";
import { SessionStore } from "@fatcat/runtime/session/store";
import type { Tools } from "@fatcat/runtime/tools";
import { defaultModelSelection } from "@fatcat/runtime/model-catalog";
import { WebUiController } from "@fatcat/webui/internal/controller";
import type { WebUiInfo } from "@fatcat/webui/internal/types";
import { temporaryWorkspace } from "../support/workspace.js";

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
  const manager = await SessionManager.open({ model, modelSelection: defaultModelSelection("deepseek"), maxIterations: 3, ...(tools ? { tools } : {}) },
    { workspace, persistence: false });
  const controller = await WebUiController.create({ ...info, workspace }, manager);
  t.after(() => controller.close());
  return controller;
}

test("Web UI keeps reported main input, cumulative usage and current estimates separate", async (t) => {
  let controller: WebUiController;
  const tools: Tools = { definitions: [], execute: async () => ({ ok: true, result: "Unused" }),
    forTurn: (onEvent) => ({ definitions: [], execute: async () => {
      onEvent?.({ type: "subagent_event", callId: "child", event: { type: "model_request", iteration: 1 } });
      onEvent?.({ type: "subagent_event", callId: "child", event: { type: "model_usage", iteration: 1, usage: usage(222) } });
      assert.equal(controller.snapshot().contextUsage?.lastReportedInput?.inputTokens ?? null, 90);
      return { ok: true, result: "Child completed" };
    } }) };
  let requests = 0;
  const model: Model = async (_messages, _signal, observe) => {
    requests++;
    // Occupancy becomes pending; historical reported input remains a separate observation.
    assert.equal(controller.snapshot().contextUsage?.estimate.status, "pending");
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
  assert.equal(state.contextUsage?.lastReportedInput?.inputTokens, 170);
  assert.equal(state.contextUsage?.consumption.tokens?.promptTokens, 482);
  assert.equal(state.contextUsage?.estimate.status, "unknown");
  assert.equal(state.turns[0]?.report?.tokenUsage.parent.totals?.promptTokens, 260);
  assert.equal(state.turns[0]?.report?.tokenUsage.children.totals?.promptTokens, 222);
  controller.submit("Transport fails"); await finished(controller);
  assert.equal(controller.snapshot().contextUsage?.lastReportedInput?.inputTokens, 170);
  controller.submit("Missing usage"); await finished(controller);
  assert.equal(controller.snapshot().contextUsage?.lastReportedInput?.inputTokens ?? null, null);
  controller.submit("Response fails after usage"); await finished(controller);
  assert.equal(controller.snapshot().contextUsage?.lastReportedInput?.inputTokens ?? null, 75);
});

test("Web session switches restore runtime usage and new sessions or forks start fresh accounting", async (t) => {
  let requests = 0;
  const controller = await controllerFor(t, async (_messages, _signal, observe) => {
    observe?.({ type: "model_usage", usage: usage(++requests * 10) }); return answer();
  });
  const first = controller.snapshot().current.id;
  controller.submit("First"); await finished(controller);
  assert.equal(controller.snapshot().contextUsage?.lastReportedInput?.inputTokens ?? null, 10);
  await controller.newSession("Second");
  assert.equal(controller.snapshot().contextUsage?.lastReportedInput?.inputTokens ?? null, null);
  controller.submit("Second"); await finished(controller);
  const second = controller.snapshot().current.id;
  await controller.rename("Inactive renamed", first);
  assert.equal(controller.snapshot().contextUsage?.lastReportedInput?.inputTokens ?? null, 20);
  await controller.deleteSession(first);
  assert.equal(controller.snapshot().contextUsage?.lastReportedInput?.inputTokens ?? null, 20);
  await controller.rename("Active renamed", second);
  assert.equal(controller.snapshot().contextUsage?.lastReportedInput?.inputTokens ?? null, 20);
  await assert.rejects(controller.resume("missing-session"), /matching in-memory session/);
  assert.equal(controller.snapshot().contextUsage?.lastReportedInput?.inputTokens ?? null, 20);
  await controller.fork("Branch", second);
  assert.equal(controller.snapshot().contextUsage?.lastReportedInput?.inputTokens ?? null, null);
  controller.submit("Branch"); await finished(controller);
  assert.equal(controller.snapshot().contextUsage?.lastReportedInput?.inputTokens ?? null, 30);
  await controller.resume(second);
  assert.equal(controller.snapshot().contextUsage?.lastReportedInput?.inputTokens, 20);
  controller.submit("Resumed"); await finished(controller);
  assert.equal(controller.snapshot().contextUsage?.lastReportedInput?.inputTokens ?? null, 40);
  await controller.deleteSession(second);
  assert.equal(controller.snapshot().contextUsage?.lastReportedInput?.inputTokens ?? null, null);
  controller.submit("Replacement"); await finished(controller);
  await controller.reset();
  assert.equal(controller.snapshot().contextUsage?.lastReportedInput?.inputTokens ?? null, null);
});

test("restored transcripts do not fabricate context token observations", async (t) => {
  const { base, workspace } = await temporaryWorkspace(t);
  const store = new SessionStore({ root: join(base, "sessions") });
  const agent = { modelSelection: defaultModelSelection("deepseek"), maxIterations: 1, model: (async (_messages, _signal, observe) => {
    observe?.({ type: "model_usage", usage: usage(42) }); return answer();
  }) satisfies Model };
  const first = await WebUiController.create({ ...info, workspace }, await SessionManager.open(agent, { workspace, store }));
  t.after(() => first.close());
  first.submit("Saved"); await finished(first);
  assert.equal(first.snapshot().contextUsage?.lastReportedInput?.inputTokens ?? null, 42);
  const id = first.snapshot().current.id;
  await first.close();
  const restored = await WebUiController.create({ ...info, workspace }, await SessionManager.open(agent,
    { workspace, store, selection: { resume: id } }));
  t.after(() => restored.close());
  assert.equal(restored.snapshot().turns[0]?.answer, "Done");
  assert.deepEqual(restored.snapshot().contextUsage?.lastReportedInput, first.snapshot().contextUsage?.lastReportedInput);
  assert.equal(restored.snapshot().contextUsage?.estimate.status, "unknown");
});
