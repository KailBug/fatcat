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
  }), { apiKey: fakeKey, model: "custom-model", maxIterations: 3, requestTimeoutMs: 60000, maxRequestBytes: 262144 });
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
