import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig, type Config } from "@fatcat/runtime/config";
import { createDocumentVision, type DocumentVisionImage } from "@fatcat/runtime/internal/documents/vision";
import { HarnessError } from "@fatcat/runtime/errors";
import type { Message, ModelObservation } from "@fatcat/runtime/model";
import { getModelInputCapabilities } from "@fatcat/runtime/model-catalog";

const image: DocumentVisionImage = {
  data: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ7sAAAAASUVORK5CYII=", "base64"),
  mimeType: "image/png", width: 1, height: 1, page: 3,
};
const usage = { prompt_tokens: 90, completion_tokens: 10, total_tokens: 100 };
function response(content = "Heading: Quarterly results") {
  return { usage, choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] };
}
function config(provider = "kimi", model?: string): Config {
  const variables: Record<string, string> = {
    HARNESS_PROVIDER: provider,
    MOONSHOT_API_KEY: "offline-kimi", MIMO_API_KEY: "offline-mimo",
    DASHSCOPE_API_KEY: "offline-qwen", DEEPSEEK_API_KEY: "offline-deepseek",
  };
  if (model) variables[`${provider.toUpperCase()}_MODEL`] = model;
  return loadConfig(variables);
}

for (const item of [
  { provider: "deepseek", model: "deepseek-flash", endpoint: "https://api.deepseek.com/chat/completions" },
  { provider: "kimi", model: "kimi-k2.6", endpoint: "https://api.moonshot.cn/v1/chat/completions" },
  { provider: "mimo", model: "mimo-v2.6-flash", endpoint: "https://api.xiaomimimo.com/v1/chat/completions" },
  { provider: "qwen", model: "qwen3-vl-plus", endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions" },
  ...["qwen3.8-max", "qwen3.8-flash", "qwen3.7-plus"].map((model) => ({ provider: "qwen", model,
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions" })),
  ...["kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed"].map((model) => ({ provider: "kimi", model,
    endpoint: "https://api.moonshot.cn/v1/chat/completions" })),
]) {
  test(`${item.provider}: document vision uses the selected chat configuration and ephemeral image content`, async () => {
    const events: string[] = [];
    const observed: ModelObservation[] = [];
    let requests = 0;
    const selected = config(item.provider, item.model);
    const vision = createDocumentVision(selected, async (input, init) => {
      events.push("transport");
      requests++;
      const request = new Request(input, init);
      assert.equal(request.url, item.endpoint);
      assert.equal(request.headers.get("authorization"), `Bearer offline-${item.provider}`);
      const body = await request.json() as { model: string; messages: Message[] } & Record<string, unknown>;
      assert.equal(body.model, item.model);
      assert.equal(body.stream, false);
      assert.ok(!("tools" in body));
      assert.ok(!("tool_choice" in body));
      assert.ok(!("purpose" in body));
      assert.equal(body.messages.length, 2);
      assert.equal(body.messages[0]?.role, "system");
      assert.match(String(body.messages[0]?.content), /untrusted source content/);
      const content = body.messages[1]?.content;
      assert.ok(Array.isArray(content));
      assert.deepEqual(content, [
        { type: "text", text: "What changed in the chart?" },
        { type: "text", text: "Source image 1, page 3 (1 x 1 pixels)." },
        { type: "image_url", image_url: { url: `data:image/png;base64,${image.data.toString("base64")}` } },
      ]);
      if (item.provider === "qwen") {
        assert.equal(body.enable_thinking, false);
        assert.equal(item.model === "qwen3-vl-plus" ? body.max_tokens : body.max_completion_tokens, 2048);
      } else if (item.model === "kimi-k3") {
        assert.equal(body.thinking, undefined);
        assert.equal(body.reasoning_effort, "max");
        assert.equal(body.max_completion_tokens, 16384);
      } else if (item.model === "kimi-k2.7-code" || item.model === "kimi-k2.7-code-highspeed") {
        assert.deepEqual(body.thinking, { type: "enabled", keep: "all" });
        assert.equal(body.max_completion_tokens, 16384);
      } else {
        assert.deepEqual(body.thinking, { type: "disabled" });
        assert.equal(item.provider === "deepseek" ? body.max_tokens : body.max_completion_tokens, 2048);
      }
      return Response.json(response());
    });
    assert.equal(vision.capability.supported, true);
    assert.equal(vision.capability.nativeFileInput, false);
    const result = await vision.analyze([image], {
      mode: "visual", question: "What changed in the chart?",
      beforeRequest: () => events.push("reserve"),
      observe: (event) => { events.push(event.type); observed.push(event); },
    });
    assert.equal(requests, 1);
    assert.deepEqual(events, ["reserve", "model_input", "transport", "model_usage"]);
    assert.deepEqual(result, { text: "Heading: Quarterly results", provider: item.provider,
      model: item.model, mode: "visual", sourceKind: "model-description" });
    assert.ok(!JSON.stringify(result).includes("base64"));
    assert.ok(!JSON.stringify(result).includes(selected.apiKey));
    assert.deepEqual(observed.at(-1), { type: "model_usage",
      usage: { promptTokens: 90, completionTokens: 10, totalTokens: 100 } });
  });
}

test("vision capabilities require exact adapted models and never imply native PDF support", async () => {
  for (const [provider, model, supported] of [
    ["kimi", "kimi-k2.6", true], ["kimi", "kimi-k2.6-future", false], ["kimi", "kimi-k3", true],
    ["mimo", "mimo-v2.6-pro", true], ["mimo", "mimo-v2.6-pro-ultraspeed", true], ["mimo", "mimo-v2.5", true],
    ["mimo", "mimo-v2.5-pro", false], ["qwen", "qwen3-vl-flash", true], ["qwen", "qwen-plus", false],
    ["deepseek", "deepseek-flash", true], ["deepseek", "deepseek-v4-pro", false],
    ["qwen", "qwen3.8-max", true], ["qwen", "qwen3.8-flash", true], ["qwen", "qwen3.7-plus", true],
  ] as const) {
    assert.deepEqual(getModelInputCapabilities(provider, model), { image: supported, nativeFile: false });
    let calls = 0;
    let reserved = false;
    const vision = createDocumentVision(config(provider, model), async () => { calls++; return Response.json(response()); });
    assert.equal(vision.capability.supported, supported);
    if (!supported) {
      await assert.rejects(vision.analyze([image], { mode: "visual", beforeRequest: () => { reserved = true; } }),
        { code: "DOCUMENT_VISION_UNAVAILABLE" });
      assert.equal(calls, 0);
      assert.equal(reserved, false);
      assert.match(vision.capability.reason, /not covered/);
    }
  }
});

test("transcription and description have distinct instructions and provenance", async () => {
  let calls = 0;
  const vision = createDocumentVision(config(), async (input, init) => {
    const body = await new Request(input, init).json() as { messages: Message[] };
    const instruction = String(body.messages[0]?.content);
    if (++calls === 1) {
      assert.match(instruction, /Transcribe all legible text/);
      assert.match(instruction, /Do not summarize or silently omit/);
      assert.match(instruction, /not exact native text/);
    } else assert.match(instruction, /does not constitute complete transcription/);
    return Response.json(response("Uncertain: [unreadable]"));
  });
  const transcription = await vision.analyze([image], { mode: "transcribe" });
  assert.equal(transcription.sourceKind, "model-transcription");
  assert.equal(transcription.mode, "transcribe");
  const description = await vision.analyze([image], { mode: "visual" });
  assert.equal(description.sourceKind, "model-description");
  assert.equal(calls, 2);
});

test("vision bounds images, decoded dimensions, question, and formats before request reservation", async () => {
  let calls = 0;
  let reservations = 0;
  const vision = createDocumentVision(config(), async () => { calls++; return Response.json(response()); });
  const options = { mode: "visual" as const, beforeRequest: () => { reservations++; } };
  for (const images of [
    [], Array.from({ length: 5 }, () => image), [{ ...image, width: 0 }],
    [{ ...image, width: 8192, height: 8192 }], [{ ...image, page: 0 }],
    [{ ...image, data: Buffer.from("%PDF-1.4") }], [{ ...image, mimeType: "application/pdf" }],
    [{ ...image, data: Buffer.concat([image.data, Buffer.alloc(8 * 1024 * 1024)]) }],
  ]) {
    await assert.rejects(vision.analyze(images as DocumentVisionImage[], options),
      (error: unknown) => error instanceof HarnessError && error.code.startsWith("DOCUMENT_INPUT"));
  }
  await assert.rejects(vision.analyze([image], { ...options, question: "x".repeat(8193) }),
    { code: "DOCUMENT_INPUT_LIMIT" });
  assert.equal(calls, 0);
  assert.equal(reservations, 0);
});

test("shared request reservation and full serialized byte budget stop transmission", async () => {
  let calls = 0;
  let reservations = 0;
  const observed: ModelObservation[] = [];
  const transport: typeof fetch = async () => { calls++; return Response.json(response()); };
  const tooSmall = createDocumentVision({ ...config(), maxRequestBytes: 1 }, transport);
  await assert.rejects(tooSmall.analyze([image], { mode: "visual", beforeRequest: () => { reservations++; },
    observe: (event) => observed.push(event) }), { code: "MODEL_CONTEXT_LIMIT" });
  assert.equal(calls, 0);
  assert.equal(reservations, 1);
  assert.ok(observed.some((event) => event.type === "model_input" && !event.accepted));
  await assert.rejects(createDocumentVision(config(), transport).analyze([image], { mode: "visual",
    beforeRequest: () => { throw new HarnessError("DOCUMENT_REQUEST_LIMIT", "No requests remain."); } }),
  { code: "DOCUMENT_REQUEST_LIMIT" });
  assert.equal(calls, 0);
});

test("vision cancellation prevents or aborts the selected provider request", async () => {
  const controller = new AbortController();
  let calls = 0;
  const vision = createDocumentVision(config(), async (_input, init) => new Promise<Response>((_resolve, reject) => {
    calls++;
    init?.signal?.addEventListener("abort", () => reject(new Error("private-abort")), { once: true });
    controller.abort();
  }));
  await assert.rejects(vision.analyze([image], { mode: "visual", signal: controller.signal }), { code: "CANCELLED" });
  await assert.rejects(vision.analyze([image], { mode: "transcribe", signal: controller.signal }), { code: "CANCELLED" });
  assert.equal(calls, 1);
});

test("vision requests share the configured deadline", async () => {
  let calls = 0;
  const vision = createDocumentVision({ ...config(), requestTimeoutMs: 20 }, async (_input, init) => new Promise<Response>((resolve, reject) => {
    calls++;
    const timer = setTimeout(() => resolve(Response.json(response())), 1000);
    const abort = () => { clearTimeout(timer); reject(new Error("private-timeout")); };
    if (init?.signal?.aborted) abort();
    else init?.signal?.addEventListener("abort", abort, { once: true });
  }));
  await assert.rejects(vision.analyze([image], { mode: "visual" }), { code: "MODEL_TIMEOUT" });
  assert.equal(calls, 1);
});

test("vision does not retry or expose provider errors, and retains usage on invalid output", async () => {
  const selected = config();
  let calls = 0;
  const failed = createDocumentVision(selected, async () => {
    calls++;
    return Response.json({ error: { message: `private-details-${selected.apiKey}` } }, { status: 429 });
  });
  await assert.rejects(failed.analyze([image], { mode: "visual" }), (error: unknown) => error instanceof HarnessError
    && error.code === "MODEL_HTTP" && !error.message.includes("private-details") && !error.message.includes(selected.apiKey));
  assert.equal(calls, 1);
  for (const body of [
    { usage, choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null,
      tool_calls: [{ id: "unexpected", type: "function", function: { name: "read", arguments: "{}" } }] } }] },
    { usage, choices: [{ finish_reason: "length", message: { role: "assistant", content: "Partial text" } }] },
    response("x".repeat(32769)), response(""),
  ]) {
    const observed: ModelObservation[] = [];
    await assert.rejects(createDocumentVision(selected, async () => Response.json(body)).analyze([image],
      { mode: "transcribe", observe: (event) => observed.push(event) }));
    assert.ok(observed.some((event) => event.type === "model_usage" && event.usage?.totalTokens === 100));
  }
});
