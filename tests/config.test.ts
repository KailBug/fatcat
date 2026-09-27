import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";

const fakeKey = "local-test-key-not-a-real-credential";

test("uses defaults without consulting the host environment", () => {
  const config = loadConfig({ DEEPSEEK_API_KEY: fakeKey });
  assert.equal(config.model, "deepseek-flash");
  assert.equal(config.maxIterations, 8);
  assert.equal(config.requestTimeoutMs, 60000);
});

test("accepts explicit settings and trims surrounding whitespace", () => {
  assert.deepEqual(loadConfig({
    DEEPSEEK_API_KEY: ` ${fakeKey} `,
    DEEPSEEK_MODEL: " custom-model ",
    HARNESS_MAX_ITERATIONS: " 3 ",
  }), { provider: "deepseek", region: "global", apiKey: fakeKey, model: "custom-model", maxIterations: 3, requestTimeoutMs: 60000, maxRequestBytes: 262144 });
});

test("rejects missing or blank credentials", () => {
  for (const value of [undefined, "", "   "]) {
    assert.throws(() => loadConfig({ DEEPSEEK_API_KEY: value }), /DEEPSEEK_API_KEY/);
  }
});

test("rejects an explicitly blank model instead of silently defaulting", () => {
  assert.throws(() => loadConfig({
    DEEPSEEK_API_KEY: fakeKey,
    DEEPSEEK_MODEL: "   ",
  }), /DEEPSEEK_MODEL/);
});

test("rejects invalid or imprecise iteration limits", () => {
  for (const value of ["", " ", "0", "-1", "1.5", "1e2", "0x10", "3x", "NaN", "Infinity", "9007199254740992"]) {
    assert.throws(() => loadConfig({
      DEEPSEEK_API_KEY: fakeKey,
      HARNESS_MAX_ITERATIONS: value,
    }), /HARNESS_MAX_ITERATIONS/);
  }
});

test("accepts the positive integer boundaries", () => {
  for (const value of [1, Number.MAX_SAFE_INTEGER]) {
    assert.equal(loadConfig({
      DEEPSEEK_API_KEY: fakeKey,
      HARNESS_MAX_ITERATIONS: String(value),
    }).maxIterations, value);
  }
});

test("configuration errors do not echo values or credentials", () => {
  assert.throws(() => loadConfig({
    DEEPSEEK_API_KEY: fakeKey,
    HARNESS_MAX_ITERATIONS: fakeKey,
  }), (error: unknown) => error instanceof Error && !error.message.includes(fakeKey));
});

test("request deadlines reject empty, invalid, and overflowing timer values", () => {
  for (const value of ["", "0", "-1", "1.5", "Infinity", "2147483648"]) {
    assert.throws(() => loadConfig({
      DEEPSEEK_API_KEY: fakeKey,
      HARNESS_REQUEST_TIMEOUT_MS: value,
    }), /HARNESS_REQUEST_TIMEOUT_MS/);
  }
  assert.equal(loadConfig({ DEEPSEEK_API_KEY: fakeKey, HARNESS_REQUEST_TIMEOUT_MS: "1500" }).requestTimeoutMs, 1500);
});


test("request byte budgets are positive bounded integers without leaking invalid values", () => {
  assert.equal(loadConfig({ DEEPSEEK_API_KEY: fakeKey }).maxRequestBytes, 262144);
  for (const value of ["", "0", "-1", "1.5", "1e5", "16777217", "Infinity", fakeKey]) {
    assert.throws(() => loadConfig({ DEEPSEEK_API_KEY: fakeKey, HARNESS_MAX_REQUEST_BYTES: value }),
      (error: unknown) => error instanceof Error && /HARNESS_MAX_REQUEST_BYTES/.test(error.message) && !error.message.includes(fakeKey));
  }
  for (const value of [1, 16777216]) assert.equal(loadConfig({ DEEPSEEK_API_KEY: fakeKey,
    HARNESS_MAX_REQUEST_BYTES: String(value) }).maxRequestBytes, value);
});

const providerCases = [
  { provider: "deepseek", key: "DEEPSEEK_API_KEY", modelEnv: "DEEPSEEK_MODEL", model: "deepseek-flash", region: "global" },
  { provider: "kimi", key: "MOONSHOT_API_KEY", modelEnv: "KIMI_MODEL", model: "kimi-k2.6", region: "cn" },
  { provider: "mimo", key: "MIMO_API_KEY", modelEnv: "MIMO_MODEL", model: "mimo-v2.6-flash", region: "global" },
  { provider: "qwen", key: "DASHSCOPE_API_KEY", modelEnv: "QWEN_MODEL", model: "qwen-plus", region: "cn" },
];

test("each provider selects only its own credentials, model, and defaults", () => {
  for (const item of providerCases) {
    const env = Object.fromEntries(providerCases.map((entry) => [entry.key, `fake-${entry.provider}`]));
    const config = loadConfig({ ...env, HARNESS_PROVIDER: ` ${item.provider} ` });
    assert.equal(config.provider, item.provider);
    assert.equal(config.apiKey, `fake-${item.provider}`);
    assert.equal(config.model, item.model);
    assert.equal(config.region, item.region);
    assert.equal(loadConfig({ ...env, HARNESS_PROVIDER: item.provider, [item.modelEnv]: " custom-model " }).model, "custom-model");
    assert.throws(() => loadConfig({ ...env, HARNESS_PROVIDER: item.provider, [item.modelEnv]: " " }), new RegExp(item.modelEnv));
    for (const absent of [undefined, "", " "]) {
      assert.throws(() => loadConfig({ ...env, HARNESS_PROVIDER: item.provider, [item.key]: absent,
        OPENAI_API_KEY: fakeKey }), new RegExp(item.key));
    }
  }
});

test("provider and endpoint regions are explicit and invalid values do not leak", () => {
  for (const provider of ["", " ", "openai", "__proto__", fakeKey]) {
    assert.throws(() => loadConfig({ HARNESS_PROVIDER: provider }),
      (error: unknown) => error instanceof Error && /HARNESS_PROVIDER/.test(error.message) && !error.message.includes(fakeKey));
  }
  for (const item of [{ provider: "kimi", key: "MOONSHOT_API_KEY", regionEnv: "KIMI_REGION", regions: ["cn", "global"] },
    { provider: "qwen", key: "DASHSCOPE_API_KEY", regionEnv: "QWEN_REGION", regions: ["cn", "intl"] }]) {
    for (const region of item.regions) {
      assert.equal(loadConfig({ HARNESS_PROVIDER: item.provider, [item.key]: fakeKey,
        [item.regionEnv]: ` ${region} ` }).region, region);
    }
    for (const region of ["", " ", "us", "__proto__", fakeKey, "https://untrusted.invalid"]) {
      assert.throws(() => loadConfig({ HARNESS_PROVIDER: item.provider, [item.key]: fakeKey, [item.regionEnv]: region }),
        (error: unknown) => error instanceof Error && error.message.includes(item.regionEnv) && !error.message.includes(fakeKey));
    }
  }
  // Unselected provider configuration cannot change a DeepSeek-only setup.
  assert.equal(loadConfig({ DEEPSEEK_API_KEY: fakeKey, KIMI_REGION: "invalid", QWEN_REGION: "invalid" }).provider, "deepseek");
});
