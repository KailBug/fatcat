import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { temporaryWorkspace } from "./fixtures/workspace.js";

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


test("workspace CLI options require a task and an existing directory", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  for (const args of [["--workspace"], ["--workspace", workspace], ["--workspace", workspace, "--help"],
    ["--workspace", workspace, "--checkConfig"], ["--workspace", " ", "--chat"]]) {
    assert.equal(run(args).status, 2, JSON.stringify(args));
  }
  const missing = run(["--workspace", join(workspace, "missing"), "--chat"], { DEEPSEEK_API_KEY: "offline-only" }, "");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /Workspace must/);
});

test("single tasks and chat share workspace definitions, results, and safe error handling", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const folder = join(workspace, "text samples");
  await mkdir(folder);
  await writeFile(join(folder, "notes.txt"), "fixture-only-text");
  await writeFile(join(folder, ".env"), "fixture-secret-not-for-model");
  const env = { DEEPSEEK_API_KEY: "offline-credential-only" };
  const single = run(["--workspace", folder, "--prompt", "workspace"], env, "");
  assert.equal(single.status, 0, single.stderr);
  assert.deepEqual(JSON.parse(single.stdout), { ok: true, result: { kind: "file", path: "notes.txt", offset: 0, totalLines: 1, startLine: 1, endLine: 1, content: "fixture-only-text", truncated: false, nextOffset: null } });
  const chat = run(["--chat", "--workspace", folder], env, "workspace\n/reset\nworkspace\nworkspace blocked\n/exit\n");
  assert.equal(chat.status, 0, chat.stderr);
  const answers = chat.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(answers[0], answers[1]);
  assert.equal(answers[2].error.code, "PATH_NOT_ALLOWED");
  assert.ok(!chat.stdout.includes("fixture-secret-not-for-model"));
  assert.ok(!chat.stderr.includes("fixture-only-text"));
  assert.ok(!chat.stderr.includes(folder));
});


test("subagent mode is explicit and completes child tool work through the actual CLI", async (t) => {
  for (const args of [["--subagent"], ["--subagent", "--help"], ["--subagent", "--checkConfig"]]) {
    assert.equal(run(args).status, 2);
  }
  const env = { DEEPSEEK_API_KEY: "offline-only" };
  const sum = run(["--subagent", "--prompt", "delegate"], env, "");
  assert.equal(sum.status, 0, sum.stderr);
  assert.equal(sum.stdout.trim(), "42");
  assert.match(sum.stderr, /"type":"subagent_event","callId":"delegated"/);
  const { workspace } = await temporaryWorkspace(t);
  await writeFile(join(workspace, "notes.txt"), "child-workspace-result");
  const chat = run(["--chat", "--subagent", "--workspace", workspace], env, "delegate\n/reset\ndelegate\n/exit\n");
  assert.equal(chat.status, 0, chat.stderr);
  const answers = chat.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.deepEqual(answers[0], { ok: true, result: { kind: "file", path: "notes.txt", offset: 0, totalLines: 1, startLine: 1, endLine: 1, content: "child-workspace-result", truncated: false, nextOffset: null } });
  assert.deepEqual(answers[1], answers[0]);
  assert.ok(!chat.stderr.includes("child-workspace-result"));
});


test("the actual CLI follows read pages through the model transport", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await writeFile(join(workspace, "notes.txt"), "first\nsecond\nlast");
  const result = run(["--workspace", workspace, "--prompt", "workspace pages"], { DEEPSEEK_API_KEY: "offline-only" }, "");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "first\nsecond\nlast");
  assert.equal((result.stderr.match(/"tool":"read"/g) ?? []).length, 3);
  assert.ok(!result.stderr.includes("second"));
});


test("CLI permissions enforce read-only and authorize exact writes explicitly", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  for (const args of [["--permission", "workspace-write", "--prompt", "task"],
    ["--workspace", workspace, "--permission", "unsafe", "--prompt", "task"],
    ["--workspace", workspace, "--permission", "workspace-write", "--help"]]) assert.equal(run(args).status, 2);
  await writeFile(join(workspace, "notes.txt"), "before");
  const env = { DEEPSEEK_API_KEY: "offline-only" };
  const denied = run(["--workspace", workspace, "--prompt", "write fixture"], env, "");
  assert.equal(denied.status, 0, denied.stderr);
  assert.match(denied.stdout, /PERMISSION_DENIED/);
  assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "before");
  const allowed = run(["--workspace", workspace, "--permission", "workspace-write", "--prompt", "write fixture"], env, "");
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "after");
  assert.match(allowed.stderr, /"type":"write_record"/);
  assert.match(allowed.stderr, /"status":"committed"/);
  assert.ok(!allowed.stderr.includes(workspace));
});

test("CLI chat retains write facts after a provider failure and reset", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await writeFile(join(workspace, "notes.txt"), "before");
  const result = run(["--chat", "--workspace", workspace, "--permission", "workspace-write"],
    { DEEPSEEK_API_KEY: "offline-only" }, "write then fail\n/reset\nwrite records\n/exit\n");
  assert.equal(result.status, 1, result.stderr);
  assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "after");
  assert.match(result.stdout, /Earlier write is recorded/);
  assert.match(result.stderr, /MODEL_HTTP/);
  assert.match(result.stderr, /committed/);
});
