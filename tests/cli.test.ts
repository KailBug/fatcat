import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExecutionReport } from "../src/execution-report.js";
import { temporaryWorkspace } from "./fixtures/workspace.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const transport = new URL("./fixtures/chat-transport.js", import.meta.url).href;
function run(args: string[], overrides: NodeJS.ProcessEnv = {}, input?: string) {
  return spawnSync(process.execPath, [...(input === undefined ? [] : ["--import", transport]), cli, ...args], {
    encoding: "utf8",
    ...(input === undefined ? {} : { input }),
    env: { ...process.env, DEEPSEEK_API_KEY: "", DEEPSEEK_MODEL: "deepseek-flash", HARNESS_MAX_ITERATIONS: "8",
      HARNESS_REQUEST_TIMEOUT_MS: "60000", HARNESS_MAX_REQUEST_BYTES: "262144", ...overrides },
    timeout: 5000,
  });
}

test("help works without credentials", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Fatcat/);
  assert.match(result.stdout, /two child tasks/);
  assert.ok(!result.stdout.includes("--subagent"));
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


test("ordinary CLI tasks can delegate without an enabling flag", async (t) => {
  for (const args of [["--subagent"], ["--subagent", "--help"], ["--subagent", "--prompt", "delegate"]]) {
    assert.equal(run(args).status, 2);
  }
  const env = { DEEPSEEK_API_KEY: "offline-only" };
  const sum = run(["--prompt", "delegate"], env, "");
  assert.equal(sum.status, 0, sum.stderr);
  assert.equal(sum.stdout.trim(), "42");
  assert.match(sum.stderr, /"type":"subagent_event","callId":"delegated"/);
  const { workspace } = await temporaryWorkspace(t);
  await writeFile(join(workspace, "notes.txt"), "child-workspace-result");
  const chat = run(["--chat", "--workspace", workspace], env, "delegate\n/reset\ndelegate\n/exit\n");
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


test("CLI shell authorization is independent and pipes cannot silently approve commands", { skip: process.platform !== "win32" }, async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  for (const args of [["--shell-permission", "allow", "task"],
    ["--workspace", workspace, "--shell-permission", "bad", "task"],
    ["--workspace", workspace, "--permission", "read-only", "--shell-permission", "allow", "task"]]) {
    assert.equal(run(args).status, 2);
  }
  const args = ["--workspace", workspace, "--permission", "workspace-write", "--prompt", "shell fixture"];
  const denied = run(args, { DEEPSEEK_API_KEY: "offline-only" }, "yes\n");
  assert.equal(denied.status, 0);
  assert.match(denied.stdout, /PERMISSION_DENIED/);
  assert.ok(!denied.stderr.includes("shell_record"));
  const allowed = run([...args, "--shell-permission", "allow"], { DEEPSEEK_API_KEY: "offline-only" }, "");
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stdout, /CLI_COMMAND_READY/);
  assert.match(allowed.stdout, /"success":true/);
  assert.match(allowed.stderr, /shell_record/);
  assert.ok(!allowed.stderr.includes("CLI_COMMAND_READY"));
});


test("simple CLI work stays direct despite delegation being available", () => {
  const result = run(["--prompt", "add"], { DEEPSEEK_API_KEY: "offline-only" }, "");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "42");
  assert.equal((result.stderr.match(/"type":"model_request"/g) ?? []).length, 2);
  assert.ok(!result.stderr.includes("subagent_event"));
});


test("default CLI delegation inherits read-only and non-interactive approval restrictions", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await writeFile(join(workspace, "notes.txt"), "before");
  for (const flags of [[], ["--permission", "read-only"]]) {
    const result = run(["--workspace", workspace, ...flags, "--prompt", "delegate write"],
      { DEEPSEEK_API_KEY: "offline-only" }, "yes\n");
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /PERMISSION_DENIED/);
    assert.match(result.stderr, /subagent_event/);
    assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "before");
  }
});


function reports(stderr: string): (ExecutionReport & { turn: number | undefined })[] {
  return stderr.split("\n").filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as { type: string; turn?: number; report: ExecutionReport })
    .filter((event) => event.type === "execution_report").map((event) => ({ ...event.report, turn: event.turn }));
}

test("ordinary CLI emits one independent report for direct and delegated work", () => {
  for (const prompt of ["add", "delegate"]) {
    const result = run(["--prompt", prompt], { DEEPSEEK_API_KEY: "offline-only" }, "");
    assert.equal(result.status, 0, result.stderr);
    const report = reports(result.stderr);
    assert.equal(report.length, 1);
    assert.equal(report[0]!.outcome, "answered");
    assert.equal(report[0]!.taskVerification, "not_assessed");
    assert.deepEqual(report[0]!.modelRequests, { parent: 2, children: prompt === "delegate" ? 2 : 0 });
    assert.deepEqual(report[0]!.commands, []);
    assert.equal(result.stdout.trim(), "42");
  }
});

test("chat emits per-turn reports on provider failure and reset without repeating earlier writes", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await writeFile(join(workspace, "notes.txt"), "before");
  const result = run(["--chat", "--workspace", workspace, "--permission", "workspace-write"],
    { DEEPSEEK_API_KEY: "offline-only" }, "write then fail\n/reset\nwrite records\n/exit\n");
  assert.equal(result.status, 1, result.stderr);
  const report = reports(result.stderr);
  assert.equal(report.length, 2);
  assert.equal(report[0]!.turn, 1);
  assert.equal(report[0]!.outcome, "stopped");
  assert.equal(report[0]!.stopCode, "MODEL_HTTP");
  assert.equal(report[0]!.writes[0]!.status, "committed");
  assert.equal(report[1]!.turn, 2);
  assert.equal(report[1]!.outcome, "answered");
  assert.equal(report[1]!.writes.length, 0);
});


test("read-only CLI follows recursive search pages without logging source content", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await mkdir(join(workspace, "src"));
  const source = "before\nSEARCH_TOKEN private-text\n";
  await writeFile(join(workspace, "src", "a.ts"), source);
  await writeFile(join(workspace, "src", "b.ts"), "SEARCH_TOKEN final-match");
  const result = run(["--workspace", workspace, "--permission", "read-only", "--prompt", "workspace search"],
    { DEEPSEEK_API_KEY: "offline-only" }, "");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [
    { path: "src/a.ts", line: 2, text: "SEARCH_TOKEN private-text" },
    { path: "src/b.ts", line: 1, text: "SEARCH_TOKEN final-match" },
  ]);
  assert.equal((result.stderr.match(/"tool":"read"/g) ?? []).length, 2);
  for (const text of ["SEARCH_TOKEN", "private-text", "final-match", workspace]) assert.ok(!result.stderr.includes(text));
  assert.equal(await readFile(join(workspace, "src", "a.ts"), "utf8"), source);
  assert.deepEqual(reports(result.stderr)[0]!.writes, []);
  assert.deepEqual(reports(result.stderr)[0]!.commands, []);
});


test("CLI rejects an oversized request locally and reports unknown usage without exposing the prompt", () => {
  const result = run(["--prompt", "private-budget-prompt"], { DEEPSEEK_API_KEY: "offline-only", HARNESS_MAX_REQUEST_BYTES: "1" }, "");
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /MODEL_CONTEXT_LIMIT/);
  assert.ok(!result.stderr.includes("private-budget-prompt"));
  assert.ok(!result.stderr.includes("offline-only"));
  const report = reports(result.stderr)[0]!;
  assert.equal(report.requestBytes.parent.rejected, 1);
  assert.deepEqual(report.tokenUsage.parent, { reportedRequests: 0, totals: null });
  const local = run(["--checkConfig"], { DEEPSEEK_API_KEY: "offline-only", HARNESS_MAX_REQUEST_BYTES: "12345" });
  assert.equal(local.status, 0);
  assert.match(local.stdout, /Maximum request body: 12345 bytes/);
});


test("CLI usage reports reset per chat turn without affecting model answers", () => {
  const result = run(["--chat"], { DEEPSEEK_API_KEY: "offline-only" }, "usage fixture\n/reset\nusage fixture\n/exit\n");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "Usage recorded.\nUsage recorded.");
  const records = reports(result.stderr);
  assert.equal(records.length, 2);
  for (const report of records) {
    assert.equal(report.requestBytes.parent.checked, 1);
    assert.equal(report.requestBytes.parent.rejected, 0);
    assert.ok(report.requestBytes.parent.maxBytes! > 0);
    assert.deepEqual(report.tokenUsage.parent, { reportedRequests: 1,
      totals: { promptTokens: 20, completionTokens: 4, totalTokens: 24 } });
    assert.deepEqual(report.tokenUsage.children, { reportedRequests: 0, totals: null });
  }
});
