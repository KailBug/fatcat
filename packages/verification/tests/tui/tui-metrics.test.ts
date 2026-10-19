import assert from "node:assert/strict";
import test from "node:test";
import { metricSections, statusText } from "@fatcat/tui/internal/metrics";
import { createTuiTelemetry } from "@fatcat/tui/internal/telemetry";

const settings = {
  config: { provider: "deepseek" as const, region: "global" as const, model: "offline-model",
    maxIterations: 8, requestTimeoutMs: 60000, maxRequestBytes: 262144 },
  workspace: undefined, permission: "ask" as const, shellPermission: "deny" as const, skills: 4,
};

test("status preserves a Qwen workspace endpoint and reports the effective reasoning setting", () => {
  const snapshot = createTuiTelemetry().snapshot();
  const qwen = statusText(snapshot, { ...settings, config: { ...settings.config,
    provider: "qwen", region: "eu", model: "qwen3.8-max", workspaceId: "offline-workspace" } });
  assert.match(qwen, /Endpoint: https:\/\/offline-workspace\.eu-central-1\.maas\.aliyuncs\.com/);
  assert.match(qwen, /Output token limit: 16384/);
  assert.match(qwen, /Thinking: medium; streaming: disabled/);
  const kimi = statusText(snapshot, { ...settings, config: { ...settings.config,
    provider: "kimi", region: "cn", model: "kimi-k3" } });
  assert.match(kimi, /Thinking: max; streaming: disabled/);
  assert.match(statusText(snapshot, { ...settings, config: { ...settings.config,
    model: "deepseek-flash", thinking: "medium" } }), /Thinking: medium; streaming: disabled/);
  assert.doesNotMatch(kimi, /Thinking: disabled/);
});

test("compact metric values carry coverage even when secondary rows are hidden", () => {
  const telemetry = createTuiTelemetry();
  telemetry.beginTurn();
  telemetry.observe({ type: "model_request", iteration: 1 });
  telemetry.observe({ type: "model_usage", iteration: 1, usage: {
    promptTokens: 20, completionTokens: 4, totalTokens: 24, cachedPromptTokens: 5,
  } });
  telemetry.observe({ type: "model_request", iteration: 2 });
  telemetry.observe({ type: "model_usage", iteration: 2, usage: null });
  const sections = metricSections(telemetry.snapshot(), settings);
  assert.equal(sections[0]?.rows[0]?.value, "24 [1/2]");
  assert.equal(sections[1]?.rows[0]?.value, "25.0% [1/2]");
  assert.match(statusText(telemetry.snapshot(), settings), /Working directory: Disabled/);
  assert.match(statusText(telemetry.snapshot(), settings), /Write permission: disabled/);
  assert.match(statusText(telemetry.snapshot(), { ...settings, webPermission: "allow" }), /Web permission: allow/);
  assert.match(statusText(telemetry.snapshot(), { ...settings, webPermission: "deny" }), /Web permission: deny/);
});

test("local budget rejection remains visible independently of unknown model context capacity", () => {
  const telemetry = createTuiTelemetry();
  telemetry.beginTurn();
  telemetry.observe({ type: "model_request", iteration: 1 });
  telemetry.observe({ type: "model_input", iteration: 1, bytes: 300000, limitBytes: 262144, accepted: false });
  const status = statusText(telemetry.snapshot(), settings);
  assert.match(status, /Budget check: Rejected/);
  assert.match(status, /Model limit: N\/A/);
  assert.match(status, /Parent input: N\/A tokens/);
  assert.match(status, /Coverage: 0\/1 reported/);
});
