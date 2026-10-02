import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { HarnessError } from "../src/errors.js";
import { runAgent } from "../src/loop.js";
import { createDeepSeekModel, createModel } from "../src/model.js";
import type { Message, ModelObservation } from "../src/model.js";

const cases = [
  { provider: "deepseek", key: "DEEPSEEK_API_KEY", label: "DeepSeek", model: "deepseek-flash",
    endpoint: "https://api.deepseek.com/chat/completions" },
  { provider: "kimi", key: "MOONSHOT_API_KEY", label: "Kimi", model: "kimi-k2.6",
    endpoint: "https://api.moonshot.cn/v1/chat/completions" },
  { provider: "mimo", key: "MIMO_API_KEY", label: "MiMo", model: "mimo-v2.6-flash",
    endpoint: "https://api.xiaomimimo.com/v1/chat/completions" },
  { provider: "qwen", key: "DASHSCOPE_API_KEY", label: "Qwen", model: "qwen-plus",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions" },
];
const usage = { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 };
const toolCall = { id: "sum-call", type: "function", function: { name: "sum", arguments: '{"numbers":[17,25]}' } };
const messages: Message[] = [{ role: "user", content: "Hello \"\\\n \u4e2d\u6587 \u{1f408}" }];
function response(tool = false) {
  return { usage, choices: [{ finish_reason: tool ? "tool_calls" : "stop", message: {
    role: "assistant", content: tool ? null : "42", ...(tool ? { tool_calls: [toolCall] } : {}),
  } }] };
}

for (const item of cases) {
  const config = loadConfig({ HARNESS_PROVIDER: item.provider, [item.key]: `offline-${item.provider}` });

  test(`${item.label}: documented endpoint, auth, generation settings, tool round trip, and usage`, async () => {
    const observations: ModelObservation[] = [];
    let calls = 0;
    const model = createModel(config, async (input, init) => {
      const request = new Request(input, init);
      assert.equal(request.url, item.endpoint);
      assert.equal(request.headers.get("authorization"), `Bearer offline-${item.provider}`);
      const body = await request.json() as Record<string, unknown> & { messages: Message[] };
      assert.equal(body.model, item.model);
      assert.equal(body.stream, false);
      if (calls === 1 && item.provider === "mimo") {
        assert.ok(!("tool_choice" in body));
        assert.ok(!("tools" in body));
      } else {
        assert.equal(body.tool_choice, calls === 0 ? "auto" : "none");
        assert.equal((body.tools as unknown[]).length, 1);
      }
      if (item.provider === "qwen") {
        assert.equal(body.enable_thinking, false);
        assert.equal(body.max_tokens, 2048);
        assert.ok(!("thinking" in body));
        assert.ok(!("max_completion_tokens" in body));
      } else {
        assert.deepEqual(body.thinking, { type: "disabled" });
        assert.equal(body.max_completion_tokens, 2048);
        assert.ok(!("enable_thinking" in body));
        assert.ok(!("max_tokens" in body));
      }
      assert.ok(!("extra_body" in body));
      assert.ok(!("temperature" in body));
      if (++calls === 1) return Response.json(response(true));
      assert.deepEqual(body.messages.at(-1), { role: "tool", tool_call_id: "sum-call", content: '{"ok":true,"result":42}' });
      assert.deepEqual(body.messages.at(-2), { role: "assistant", content: null, tool_calls: [toolCall] });
      return Response.json(response());
    });
    assert.equal(await runAgent("Add 17 and 25", { model, onEvent: (event) => {
      if (event.type === "model_usage") observations.push(event);
    }, maxIterations: 2 }), "42");
    assert.equal(calls, 2);
    assert.deepEqual(observations.filter((event) => event.type === "model_usage").map(({ type, usage }) => ({ type, usage })), [
      { type: "model_usage", usage: { promptTokens: 30, completionTokens: 12, totalTokens: 42 } },
      { type: "model_usage", usage: { promptTokens: 30, completionTokens: 12, totalTokens: 42 } },
    ]);
  });

  test(`${item.label}: exact serialized budget passes and one-byte overflow sends no request`, async () => {
    let bytes = 0;
    let calls = 0;
    const transport: typeof fetch = async (input, init) => {
      bytes = Buffer.byteLength(await new Request(input, init).text());
      calls++;
      return Response.json(response());
    };
    await createModel(config, transport)(messages);
    const limit = bytes;
    const observed: ModelObservation[] = [];
    await createModel({ ...config, maxRequestBytes: limit }, transport)(messages, undefined, (event) => observed.push(event));
    assert.deepEqual(observed[0], { type: "model_input", bytes: limit, limitBytes: limit, accepted: true });
    await assert.rejects(createModel({ ...config, maxRequestBytes: limit - 1 }, transport)(messages), { code: "MODEL_CONTEXT_LIMIT" });
    assert.equal(calls, 2);
  });

  test(`${item.label}: HTTP failures never retry or disclose provider bodies and unsupported responses keep usage`, async () => {
    for (const status of [401, 429, 500]) {
      let calls = 0;
      const model = createModel(config, async () => {
        calls++;
        return Response.json({ error: { message: `private-error-${config.apiKey}` } }, { status });
      });
      await assert.rejects(model(messages), (error: unknown) => error instanceof HarnessError
        && error.code === "MODEL_HTTP" && error.message.includes(item.label) && error.message.includes(String(status))
        && !error.message.includes(config.apiKey) && !error.message.includes("private-error"));
      assert.equal(calls, 1);
    }
    for (const reason of ["length", "content_filter", "repetition_truncation"]) {
      const observed: ModelObservation[] = [];
      const data = response();
      data.choices[0]!.finish_reason = reason;
      await assert.rejects(createModel(config, async () => Response.json(data))(messages, undefined,
        (event) => observed.push(event)), { code: reason === "length" ? "MODEL_TRUNCATED" : "MODEL_RESPONSE" });
      assert.deepEqual(observed.at(-1), { type: "model_usage", usage: { promptTokens: 30, completionTokens: 12, totalTokens: 42 } });
    }
  });

  test(`${item.label}: caller cancellation stops the request and pre-cancel sends nothing`, async () => {
    const controller = new AbortController();
    let calls = 0;
    const model = createModel(config, async (_input, init) => new Promise<Response>((_resolve, reject) => {
      calls++;
      init?.signal?.addEventListener("abort", () => reject(new Error("private-abort")), { once: true });
      controller.abort();
    }));
    await assert.rejects(model(messages, controller.signal), { code: "CANCELLED" });
    await assert.rejects(model(messages, controller.signal), { code: "CANCELLED" });
    assert.equal(calls, 1);
  });

  test(`${item.label}: deadline bounds a stalled transport`, async () => {
    let calls = 0;
    const model = createModel({ ...config, requestTimeoutMs: 20 }, async (_input, init) => new Promise<Response>((resolve, reject) => {
      calls++;
      const timer = setTimeout(() => resolve(Response.json(response())), 1000);
      const abort = () => { clearTimeout(timer); reject(new Error("private-timeout")); };
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
    }));
    await assert.rejects(model(messages), (error: unknown) => error instanceof HarnessError
      && error.code === "MODEL_TIMEOUT" && error.message.includes(item.label));
    assert.equal(calls, 1);
  });
}

test("region selection changes only the approved provider endpoint", async () => {
  for (const item of [
    { provider: "kimi", key: "MOONSHOT_API_KEY", env: { KIMI_REGION: "global" }, endpoint: "https://api.moonshot.ai/v1/chat/completions" },
    { provider: "qwen", key: "DASHSCOPE_API_KEY", env: { QWEN_REGION: "intl" }, endpoint: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions" },
  ]) {
    const config = loadConfig({ HARNESS_PROVIDER: item.provider, [item.key]: "offline-region", ...item.env });
    await createModel(config, async (input, init) => {
      const request = new Request(input, init);
      assert.equal(request.url, item.endpoint);
      assert.equal(request.headers.get("authorization"), "Bearer offline-region");
      return Response.json(response());
    })(messages);
  }
});

test("ambient OpenAI settings cannot redirect credentials or add project and organization headers", async () => {
  const keys = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID"];
  const previous = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) process.env[key] = key === "OPENAI_BASE_URL" ? "https://untrusted.invalid/v1" : "private-ambient-value";
    for (const item of cases) {
      await createModel(loadConfig({ HARNESS_PROVIDER: item.provider, [item.key]: "offline-selected" }), async (input, init) => {
        const request = new Request(input, init);
        assert.equal(request.url, item.endpoint);
        assert.equal(request.headers.get("authorization"), "Bearer offline-selected");
        assert.equal(request.headers.get("openai-organization"), null);
        assert.equal(request.headers.get("openai-project"), null);
        return Response.json(response());
      })(messages);
    }
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});

test("DeepSeek compatibility wrapper rejects other providers before any transport", () => {
  for (const item of cases.filter((entry) => entry.provider !== "deepseek")) {
    assert.throws(() => createDeepSeekModel(loadConfig({ HARNESS_PROVIDER: item.provider, [item.key]: "offline-wrapper" })), { code: "CONFIG" });
  }
});
