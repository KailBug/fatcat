import assert from "node:assert/strict";
import test from "node:test";
import { HarnessError } from "../src/errors.js";
import type { LoopEvent } from "../src/loop.js";
import type { Message, Model, ModelTurn } from "../src/model.js";
import { Session } from "../src/session.js";

function answer(content = "Ready"): ModelTurn {
  return { message: { role: "assistant", content }, toolCalls: [] };
}
function sum(id = "sum_call"): ModelTurn {
  const toolCalls = [{ id, type: "function" as const, function: { name: "sum", arguments: '{"numbers":[17,25]}' } }];
  return { message: { role: "assistant", content: null, tool_calls: toolCalls }, toolCalls };
}

test("a session keeps successful turns without sharing mutable model references", async () => {
  const requests: Message[][] = [];
  const session = new Session({ maxIterations: 1, model: async (messages) => {
    requests.push(messages);
    return answer();
  } });
  await session.run("Remember amber");
  requests[0]?.push({ role: "user", content: "Injected after completion" });
  await session.run("What did I ask you to remember?");
  assert.deepEqual(requests[1]?.slice(1, 4), [
    { role: "user", content: "Remember amber" },
    { role: "assistant", content: "Ready" },
    { role: "user", content: "What did I ask you to remember?" },
  ]);
  assert.ok(!JSON.stringify(requests[1]).includes("Injected"));
});

test("sessions isolate their histories and reset restores a fresh conversation", async () => {
  const requests: Message[][] = [];
  const model: Model = async (messages) => { requests.push(structuredClone(messages)); return answer(); };
  const first = new Session({ model, maxIterations: 1 });
  const second = new Session({ model, maxIterations: 1 });
  await first.run("Private to the first session");
  await second.run("Second session");
  first.reset();
  await first.run("After reset");
  assert.deepEqual(requests.map((messages) => messages.length), [2, 2, 2]);
  assert.ok(!JSON.stringify(requests.slice(1)).includes("Private"));
});

test("tool history stays complete across turns with a fresh iteration budget and ID scope", async () => {
  const requests: Message[][] = [];
  const events: LoopEvent[] = [];
  const session = new Session({ maxIterations: 2, model: async (messages) => {
    requests.push(structuredClone(messages));
    return messages.at(-1)?.role === "tool" ? answer("42") : sum();
  } });
  for (const prompt of ["Add", "Add again"]) {
    assert.equal(await session.run(prompt, { onEvent: (event) => events.push(event) }), "42");
  }
  assert.deepEqual(requests[2]?.map((message) => message.role), ["system", "user", "assistant", "tool", "assistant", "user"]);
  assert.deepEqual(requests[2]?.[3], { role: "tool", tool_call_id: "sum_call", content: '{"ok":true,"result":42}' });
  assert.deepEqual(events.filter((event) => event.type === "model_request").map((event) => event.iteration), [1, 2, 1, 2]);
});

test("failed, cancelled, and exhausted turns never replace successful history", async () => {
  for (const code of ["MODEL_HTTP", "MODEL_TIMEOUT", "MODEL_RESPONSE", "CANCELLED", "MAX_ITERATIONS"]) {
    const controller = new AbortController();
    const session = new Session({ maxIterations: 2, model: async (messages) => {
      const prompt = messages.findLast((message) => message.role === "user")?.content;
      if (prompt === "Fail this turn") {
        if (messages.at(-1)?.role === "user") return sum();
        if (code === "MAX_ITERATIONS") return sum("more");
        if (code === "CANCELLED") controller.abort();
        throw new HarnessError(code, "Expected failure.");
      }
      if (prompt === "Continue") {
        assert.deepEqual(messages.map((message) => message.role), ["system", "user", "assistant", "user"], code);
        assert.equal(messages[1]?.content, "Keep this turn", code);
        assert.ok(!JSON.stringify(messages).includes("Fail this turn"), code);
      }
      return answer();
    } });
    await session.run("Keep this turn");
    await assert.rejects(session.run("Fail this turn", { signal: controller.signal }),
      (error: unknown) => error instanceof HarnessError && error.code === code);
    assert.equal(await session.run("Continue"), "Ready");
  }
});

test("overlapping runs and reset are rejected without affecting the active turn", async () => {
  let finish!: (value: ModelTurn) => void;
  const session = new Session({ maxIterations: 1, model: async () => new Promise((resolve) => { finish = resolve; }) });
  const running = session.run("First");
  await assert.rejects(session.run("Overlap"), (error: unknown) => error instanceof HarnessError && error.code === "SESSION_BUSY");
  assert.throws(() => session.reset(), /already running/);
  const independent = new Session({ maxIterations: 1, model: async () => answer() });
  assert.equal(await independent.run("Independent"), "Ready");
  finish(answer());
  assert.equal(await running, "Ready");
  session.reset();
});

test("invalid input and cancellation at completion release the session without committing", async () => {
  const requests: Message[][] = [];
  const controller = new AbortController();
  const session = new Session({ maxIterations: 1, model: async (messages) => {
    requests.push(structuredClone(messages)); return answer();
  } });
  await assert.rejects(session.run(" "), /prompt/);
  await assert.rejects(session.run("Cancelled", {
    signal: controller.signal,
    onEvent: (event) => { if (event.type === "completed") controller.abort(); },
  }), /cancelled/);
  await session.run("New turn");
  assert.equal(requests[1]?.length, 2);
});
