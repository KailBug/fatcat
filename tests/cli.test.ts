import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const transport = new URL("./fixtures/chat-transport.js", import.meta.url).href;
function run(args: string[], overrides: NodeJS.ProcessEnv = {}, input?: string) {
  return spawnSync(process.execPath, [...(input === undefined ? [] : ["--import", transport]), cli, ...args], {
    encoding: "utf8",
    ...(input === undefined ? {} : { input }),
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
  for (const args of [["--chat", "--help"], ["--chat", "--prompt", "task"], ["--chat", "task"], ["--unknown"], ["--prompt"], ["--prompt", " "], ["--help", "task"], ["--prompt", "one", "two"]]) {
    assert.equal(run(args).status, 2, JSON.stringify(args));
  }
  const missing = run(["Hello"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /DEEPSEEK_API_KEY/);
  assert.equal(missing.stdout, "");
});

test("local config checks do not contact the model or expose credentials", () => {
  const result = run(["--checkConfig"], { DEEPSEEK_API_KEY: "offline-credential-only" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /DeepSeek was not contacted/);
  assert.ok(!(result.stdout + result.stderr).includes("offline-credential-only"));
});


test("chat preserves tool history, resets locally, and stops at the exit command", () => {
  const result = run(["--chat"], { DEEPSEEK_API_KEY: "offline-credential-only" },
    "add\r\nhistory\r\n/reset\r\nhistory\r\n/exit\r\nDo not run\r\n");
  assert.equal(result.status, 0, result.stderr);
  const answers = result.stdout.trim().split("\n");
  assert.equal(answers.length, 3);
  assert.equal(answers[0], "42");
  const history = JSON.parse(answers[1]!) as { role: string; tool_call_id?: string; content?: string }[];
  assert.deepEqual(history.map((message) => message.role), ["user", "assistant", "tool", "assistant"]);
  assert.equal(history[2]?.tool_call_id, "call_1");
  assert.equal(history[2]?.content, '{"ok":true,"result":42}');
  assert.equal(answers[2], "[]");
  assert.match(result.stderr, /"turn":3,"type":"completed"/);
  assert.ok(!result.stderr.includes("offline-credential-only"));
});

test("chat continues after provider errors, preserves earlier turns, and exits nonzero at EOF", () => {
  const result = run(["--chat"], { DEEPSEEK_API_KEY: "offline-credential-only" }, "keep\nfail\nhistory");
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Error \[MODEL_HTTP\]/);
  assert.ok(!result.stderr.includes("private-provider-secret"));
  const history = JSON.parse(result.stdout.trim().split("\n")[1]!);
  assert.deepEqual(history, [{ role: "user", content: "keep" }, { role: "assistant", content: "keep" }]);
});

test("chat exits cleanly with empty input and still requires valid configuration", () => {
  assert.equal(run(["--chat"], { DEEPSEEK_API_KEY: "offline-credential-only" }, "").status, 0);
  assert.equal(run(["--chat"], {}, "/exit\n").status, 1);
});
