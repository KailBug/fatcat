import assert from "node:assert/strict";
import test from "node:test";
import { HarnessError } from "../src/errors.js";
import { runAgent } from "../src/loop.js";
import type { LoopEvent } from "../src/loop.js";
import type { Message, Model, ModelTurn } from "../src/model.js";
import { Session } from "../src/session.js";
import { createSubagentTools } from "../src/subagent.js";
import { defaultTools } from "../src/tools.js";

function answer(content: string): ModelTurn {
  return { message: { role: "assistant", content }, toolCalls: [] };
}
function calls(name: string, args: string, ...ids: string[]): ModelTurn {
  const toolCalls = ids.map((id) => ({ id, type: "function" as const, function: { name, arguments: args } }));
  return { message: { role: "assistant", content: null, tool_calls: toolCalls }, toolCalls };
}

test("delegation isolates child history, correlates events, and returns only the final answer", async () => {
  const childRequests: Message[][] = [];
  const child: Model = async (messages) => {
    childRequests.push(structuredClone(messages));
    return childRequests.length === 1 ? calls("sum", '{"numbers":[17,25]}', "child-sum") : answer("42");
  };
  const tools = createSubagentTools(defaultTools, child, 8);
  const events: LoopEvent[] = [];
  let parentRequests = 0;
  const parent: Model = async (messages) => {
    if (++parentRequests === 1) return calls("delegate_task", '{"task":"Add 17 and 25"}', "parent-delegate");
    assert.deepEqual(messages.at(-1), { role: "tool", tool_call_id: "parent-delegate", content: '{"ok":true,"result":{"answer":"42"}}' });
    assert.ok(!JSON.stringify(messages).includes("child-sum"));
    return answer("42");
  };
  assert.equal(await runAgent("Parent-only context", { model: parent, tools, maxIterations: 2, onEvent: (event) => events.push(event) }), "42");
  assert.equal(childRequests[0]?.length, 2);
  assert.equal(childRequests[0]?.[1]?.content, "Add 17 and 25");
  assert.ok(!JSON.stringify(childRequests).includes("Parent-only context"));
  assert.ok(events.some((event) => event.type === "subagent_event" && event.callId === "parent-delegate" && event.event.type === "tool_result"));
  assert.equal(defaultTools.definitions.some((tool) => tool.function.name === "delegate_task"), false);
});

test("invalid tasks do not start children or consume the two-task allowance", async () => {
  let requests = 0;
  const tools = createSubagentTools(defaultTools, async () => { requests++; return answer("Done"); }, 8);
  for (const args of ["{", "null", "[]", "{}", '{"task":" "}', '{"task":3}', '{"task":"ok","extra":true}', JSON.stringify({ task: "x".repeat(4001) })]) {
    const result = await tools.execute("delegate_task", args);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "INVALID_ARGUMENTS");
  }
  for (let i = 0; i < 2; i++) assert.equal((await tools.execute("delegate_task", '{"task":"Work"}')).ok, true);
  const exhausted = await tools.execute("delegate_task", '{"task":"Work"}');
  assert.equal(exhausted.ok, false);
  if (!exhausted.ok) assert.equal(exhausted.error.code, "SUBAGENT_LIMIT");
  assert.equal(requests, 2);
});

test("delegation limits reset per Session turn and do not leak across sessions", async () => {
  let children = 0;
  const tools = createSubagentTools(defaultTools, async () => { children++; return answer("Done"); }, 8);
  const model: Model = async (messages) => {
    if (messages.at(-1)?.role === "user") return calls("delegate_task", '{"task":"Work"}', "one", "two", "three");
    assert.match(String(messages.at(-1)?.content), /SUBAGENT_LIMIT/);
    return answer("Done");
  };
  const first = new Session({ model, tools, maxIterations: 2 });
  const second = new Session({ model, tools, maxIterations: 2 });
  await first.run("First");
  await first.run("Second");
  await second.run("Independent");
  first.reset();
  await first.run("Reset");
  assert.equal(children, 8);
});

test("failed children consume allowance, return safe errors, and let the parent continue", async () => {
  let attempts = 0;
  const tools = createSubagentTools(defaultTools, async () => { attempts++; throw new Error("provider-private-data"); }, 8);
  const model: Model = async (messages) => {
    if (messages.at(-1)?.role === "user") return calls("delegate_task", '{"task":"Work"}', "one", "two", "three");
    const results = messages.filter((message) => message.role === "tool").map((message) => String(message.content));
    assert.match(results[0]!, /SUBAGENT_FAILED/);
    assert.match(results[1]!, /INTERNAL/);
    assert.match(results[2]!, /SUBAGENT_LIMIT/);
    assert.ok(!JSON.stringify(results).includes("provider-private-data"));
    return answer("The child failed; I can explain the limitation.");
  };
  assert.match(await runAgent("Work", { model, tools, maxIterations: 2 }), /limitation/);
  assert.equal(attempts, 2);
});

test("children have a bounded loop and cannot execute recursive delegation", async () => {
  for (const configured of [1, 8]) {
    let requests = 0;
    const child: Model = async (messages) => {
      if (requests) assert.match(String(messages.at(-1)?.content), /UNKNOWN_TOOL/);
      return calls("delegate_task", '{"task":"Recurse"}', `recursive-${++requests}`);
    };
    const tools = createSubagentTools(defaultTools, child, configured);
    const result = await tools.execute("delegate_task", '{"task":"Try"}');
    assert.equal(result.ok, false);
    if (!result.ok) { assert.equal(result.error.code, "SUBAGENT_FAILED"); assert.match(result.error.message, /MAX_ITERATIONS/); }
    assert.equal(requests, Math.min(3, configured));
    assert.throws(() => createSubagentTools(tools, child, 8), /without delegation/);
  }
});

test("parent cancellation reaches an active child and prevents parent continuation", async () => {
  const controller = new AbortController();
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  let parentRequests = 0;
  const tools = createSubagentTools(defaultTools, async (_messages, signal) => {
    assert.equal(signal, controller.signal);
    ready();
    return new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new HarnessError("CANCELLED", "Run cancelled.")), { once: true });
    });
  }, 8);
  const events: LoopEvent[] = [];
  const pending = runAgent("Work", { tools, maxIterations: 2, signal: controller.signal,
    model: async () => { parentRequests++; return calls("delegate_task", '{"task":"Wait"}', "pending"); },
    onEvent: (event) => events.push(event),
  });
  await started;
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(parentRequests, 1);
  assert.ok(!events.some((event) => event.type === "tool_result"));
});

test("oversized child answers fail instead of returning a successful partial answer", async () => {
  const tools = createSubagentTools(defaultTools, async () => answer("a".repeat(12001)), 8);
  const result = await tools.execute("delegate_task", '{"task":"Work"}');
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "SUBAGENT_OUTPUT_LIMIT");
});
