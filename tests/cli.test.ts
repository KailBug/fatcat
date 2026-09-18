import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
function run(args: string[], overrides: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, DEEPSEEK_API_KEY: "", DEEPSEEK_MODEL: "deepseek-flash", HARNESS_MAX_ITERATIONS: "8",
      HARNESS_REQUEST_TIMEOUT_MS: "60000", ...overrides },
    timeout: 5000,
  });
}

test("help works without credentials", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Fatcat/);
  assert.equal(result.stderr, "");
});

test("usage errors and missing credentials have distinct exit codes", () => {
  for (const args of [["--unknown"], ["--prompt"], ["--prompt", " "], ["--help", "task"], ["--prompt", "one", "two"]]) {
    assert.equal(run(args).status, 2, JSON.stringify(args));
  }
  const missing = run(["Hello"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /DEEPSEEK_API_KEY/);
  assert.equal(missing.stdout, "");
});

test("local config checks do not contact the model or expose credentials", () => {
  const result = run(["--check-config"], { DEEPSEEK_API_KEY: "offline-credential-only" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /DeepSeek was not contacted/);
  assert.ok(!(result.stdout + result.stderr).includes("offline-credential-only"));
});
