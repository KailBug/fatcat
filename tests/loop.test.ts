import assert from "node:assert/strict";
import test from "node:test";
import { HarnessError } from "../src/errors.js";
import { runAgent } from "../src/loop.js";
import type { LoopEvent } from "../src/loop.js";
import type { Model, ModelTurn } from "../src/model.js";

function finalAnswer(content: string): ModelTurn {
  return { message: { role: "assistant", content }, toolCalls: [] };
}

function requestTools(...calls: { id: string; name: string; args: string }[]): ModelTurn {
  const toolCalls = calls.map(({ id, name, args }) => ({
    id, type: "function" as const, function: { name, arguments: args },
  }));
  return { message: { role: "assistant", content: null, tool_calls: toolCalls }, toolCalls };
}

test("direct answers finish after one request with fresh history per run", async () => {
  const histories: unknown[] = [];
  const model: Model = async (messages) => {
    histories.push(structuredClone(messages));
    return finalAnswer("Ready.");
  };
  assert.equal(await runAgent("First task", { model, maxIterations: 1 }), "Ready.");
  await runAgent("Second task", { model, maxIterations: 1 });
  assert.equal((histories[0] as unknown[]).length, 2);
  assert.equal((histories[1] as unknown[]).length, 2);
  assert.ok(!JSON.stringify(histories[1]).includes("First task"));
});

test("multiple tools and subsequent turns preserve call/result association", async () => {
  let requests = 0;
  const model: Model = async (messages) => {
    requests++;
    if (requests === 1) return requestTools(
      { id: "a", name: "sum", args: '{"numbers":[17,25]}' },
      { id: "b", name: "sum", args: '{"numbers":[1,2]}' },
    );
    if (requests === 2) {
      assert.equal(messages[2]?.role, "assistant");
      assert.deepEqual(messages.slice(3), [
        { role: "tool", tool_call_id: "a", content: '{"ok":true,"result":42}' },
        { role: "tool", tool_call_id: "b", content: '{"ok":true,"result":3}' },
      ]);
      return requestTools({ id: "c", name: "sum", args: '{"numbers":[42,3]}' });
    }
    assert.deepEqual(messages.at(-1), { role: "tool", tool_call_id: "c", content: '{"ok":true,"result":45}' });
    return finalAnswer("45");
  };
  assert.equal(await runAgent("Add these numbers", { model, maxIterations: 3 }), "45");
  assert.equal(requests, 3);
});

test("tool errors reach the model and allow corrected calls", async () => {
  let requests = 0;
  const model: Model = async (messages) => {
    requests++;
    if (requests === 1) return requestTools(
      { id: "bad-json", name: "sum", args: "{" },
      { id: "unknown", name: "missing", args: "{}" },
    );
    if (requests === 2) {
      assert.match(JSON.stringify(messages.at(-2)), /INVALID_ARGUMENTS/);
      assert.match(JSON.stringify(messages.at(-1)), /UNKNOWN_TOOL/);
      return requestTools({ id: "fixed", name: "sum", args: '{"numbers":[1,2]}' });
    }
    return finalAnswer("3");
  };
  assert.equal(await runAgent("Add", { model, maxIterations: 3 }), "3");
});

test("the iteration limit bounds model requests and skips unusable final tools", async () => {
  let requests = 0;
  const events: LoopEvent[] = [];
  const model: Model = async () => requestTools({ id: String(++requests), name: "sum", args: '{"numbers":[1,2]}' });
  await assert.rejects(runAgent("Keep going", {
    model, maxIterations: 3, onEvent: (event) => events.push(event),
  }), (error: unknown) => error instanceof HarnessError && error.code === "MAX_ITERATIONS");
  assert.equal(requests, 3);
  assert.equal(events.filter((event) => event.type === "tool_result").length, 2);
  assert.deepEqual(events.at(-1), { type: "stopped", code: "MAX_ITERATIONS" });
});

test("model errors terminate without another request", async () => {
  let requests = 0;
  await assert.rejects(runAgent("Hello", {
    maxIterations: 8,
    model: async () => { requests++; throw new HarnessError("MODEL_HTTP", "Failed."); },
  }), /Failed/);
  assert.equal(requests, 1);
});

test("reused tool call IDs fail before executing the duplicated turn", async () => {
  const model: Model = async () => requestTools({ id: "duplicate", name: "sum", args: '{"numbers":[1,2]}' });
  await assert.rejects(runAgent("Add", { model, maxIterations: 3 }), /reused a tool call ID/);
});

test("cancellation prevents requests and suppresses late tool execution", async () => {
  const controller = new AbortController();
  const events: LoopEvent[] = [];
  const model: Model = async () => {
    controller.abort();
    return requestTools({ id: "a", name: "sum", args: '{"numbers":[1,2]}' });
  };
  await assert.rejects(runAgent("Add", {
    model, maxIterations: 3, signal: controller.signal, onEvent: (event) => events.push(event),
  }), /cancelled/);
  assert.ok(!events.some((event) => event.type === "tool_result"));
  await assert.rejects(runAgent("Add", {
    model: async () => { assert.fail("No request should start"); }, maxIterations: 3, signal: controller.signal,
  }), /cancelled/);
});

test("blank prompts and invalid loop limits are rejected before model calls", async () => {
  const model: Model = async () => { assert.fail("No request should start"); };
  await assert.rejects(runAgent(" ", { model, maxIterations: 1 }), /prompt/);
  await assert.rejects(runAgent("Hello", { model, maxIterations: 0 }), /maxIterations/);
});
