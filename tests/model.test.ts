import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { HarnessError } from "../src/errors.js";
import { runAgent } from "../src/loop.js";
import { createDeepSeekModel } from "../src/model.js";

const config = loadConfig({ DEEPSEEK_API_KEY: "test-key-not-real" });
const messages = [{ role: "user" as const, content: "Hello" }];
function completion(content: string | null, toolCalls?: unknown[]) {
  return { choices: [{
    finish_reason: toolCalls?.length ? "tool_calls" : "stop",
    message: { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) },
  }] };
}
const tool = { id: "call_1", type: "function", function: { name: "sum", arguments: '{"numbers":[17,25]}' } };

test("SDK requests use only the DeepSeek endpoint and the configured non-streaming protocol", async () => {
  const model = createDeepSeekModel(config, async (input, init) => {
    const request = new Request(input, init);
    assert.equal(request.url, "https://api.deepseek.com/chat/completions");
    assert.equal(request.headers.get("authorization"), "Bearer test-key-not-real");
    const body = await request.json() as Record<string, unknown>;
    assert.equal(body.model, "deepseek-flash");
    assert.equal(body.stream, false);
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.equal(body.tool_choice, "auto");
    assert.equal((body.tools as unknown[]).length, 1);
    assert.deepEqual(body.messages, messages);
    return Response.json(completion("Hello!"));
  });
  assert.equal((await model(messages)).message.content, "Hello!");
});

test("SDK, loop, tool execution, and history form a complete offline round trip", async () => {
  let requests = 0;
  const model = createDeepSeekModel(config, async (input, init) => {
    const body = await new Request(input, init).json() as { messages: unknown[] };
    if (++requests === 1) return Response.json(completion(null, [tool]));
    assert.deepEqual(body.messages.at(-1), { role: "tool", tool_call_id: "call_1", content: '{"ok":true,"result":42}' });
    return Response.json(completion("The result is 42."));
  });
  assert.equal(await runAgent("Add 17 and 25", { model, maxIterations: 2 }), "The result is 42.");
  assert.equal(requests, 2);
});

test("HTTP errors are not retried and never echo provider error bodies", async () => {
  for (const status of [401, 429, 500]) {
    let requests = 0;
    const model = createDeepSeekModel(config, async () => {
      requests++;
      return Response.json({ error: { message: "test-key-not-real provider-secret" } }, { status });
    });
    await assert.rejects(model(messages), (error: unknown) =>
      error instanceof HarnessError && error.code === "MODEL_HTTP"
      && error.message.includes(String(status)) && !error.message.includes("secret") && !error.message.includes("test-key"));
    assert.equal(requests, 1);
  }
});

test("invalid, empty, inconsistent, duplicate, and truncated responses fail safely", async () => {
  const invalidResponses = [
    {}, { choices: [] }, completion(""), completion(null),
    { choices: [{ finish_reason: "length", message: { role: "assistant", content: "Partial" } }] },
    { choices: [{ finish_reason: "stop", message: { role: "user", content: "Wrong role" } }] },
    completion(null, [{ ...tool, id: "" }]),
    completion(null, [tool, tool]),
    completion(null, [{ ...tool, type: "custom" }]),
    completion(null, [{ ...tool, function: { name: "sum", arguments: {} } }]),
    { choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Incomplete", tool_calls: [tool] } }] },
  ];
  for (const response of invalidResponses) {
    const model = createDeepSeekModel(config, async () => Response.json(response));
    await assert.rejects(model(messages), (error: unknown) => error instanceof HarnessError);
  }
});

test("connection failures are reported without raw transport details", async () => {
  const model = createDeepSeekModel(config, async () => { throw new Error("private transport data"); });
  await assert.rejects(model(messages), (error: unknown) =>
    error instanceof HarnessError && error.code === "MODEL_CONNECTION" && !error.message.includes("private"));
});

test("the request deadline cancels a stalled transport", async () => {
  const model = createDeepSeekModel({ ...config, requestTimeoutMs: 20 }, async (_input, init) =>
    new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(Response.json(completion("Too late"))), 1000);
      const abort = () => { clearTimeout(timer); reject(new Error("aborted")); };
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
    }));
  await assert.rejects(model(messages), (error: unknown) => error instanceof HarnessError && error.code === "MODEL_TIMEOUT");
});

test("caller cancellation stops an SDK request without retrying", async () => {
  const controller = new AbortController();
  const model = createDeepSeekModel(config, async (_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      controller.abort();
    }));
  await assert.rejects(model(messages, controller.signal), (error: unknown) =>
    error instanceof HarnessError && error.code === "CANCELLED");
});
