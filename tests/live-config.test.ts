import assert from "node:assert/strict";
import test from "node:test";
import { loadLiveConfig } from "../scripts/fixtures/live-config.js";

test("existing live fixtures reject new providers before model construction", () => {
  const names = ["HARNESS_PROVIDER", "MOONSHOT_API_KEY", "MIMO_API_KEY", "DASHSCOPE_API_KEY", "KIMI_REGION", "QWEN_REGION"];
  const saved = names.map((name) => [name, process.env[name]] as const);
  try {
    process.env.MOONSHOT_API_KEY = "fake-live-guard-key";
    process.env.MIMO_API_KEY = "fake-live-guard-key";
    process.env.DASHSCOPE_API_KEY = "fake-live-guard-key";
    process.env.KIMI_REGION = "cn";
    process.env.QWEN_REGION = "cn";
    for (const provider of ["kimi", "mimo", "qwen"]) {
      process.env.HARNESS_PROVIDER = provider;
      assert.throws(loadLiveConfig, (error: unknown) => error instanceof Error
        && /Live verification fixtures require HARNESS_PROVIDER=deepseek/.test(error.message)
        && !error.message.includes("fake-live-guard-key"));
    }
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});
