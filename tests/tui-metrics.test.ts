import assert from "node:assert/strict";
import test from "node:test";
import { metricSections, statusText } from "../src/tui/metrics.js";
import { createTuiTelemetry } from "../src/tui/telemetry.js";

const settings = {
  config: { provider: "deepseek" as const, region: "global" as const, model: "offline-model",
    maxIterations: 8, requestTimeoutMs: 60000, maxRequestBytes: 262144 },
  workspace: undefined, permission: "ask" as const, shellPermission: "deny" as const, skills: 4,
};

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
