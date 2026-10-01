import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ExecutionReport } from "../src/execution-report.js";
import { SessionStore } from "../src/session/store.js";
import { temporaryWorkspace } from "./fixtures/workspace.js";

const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const transport = new URL("./fixtures/chat-transport.js", import.meta.url).href;
function run(args: string[], overrides: NodeJS.ProcessEnv = {}, input?: string, cwd?: string) {
  const sessionDirectory = overrides.FATCAT_SESSION_DIR ?? mkdtempSync(join(tmpdir(), "fatcat-cli-sessions-"));
  try {
    return spawnSync(process.execPath, [...(input === undefined ? [] : ["--import", transport]), cli, ...args], {
    encoding: "utf8",
    ...(cwd === undefined ? {} : { cwd }),
    ...(input === undefined ? {} : { input }),
    env: { ...process.env, HARNESS_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "", DEEPSEEK_MODEL: "deepseek-flash", HARNESS_MAX_ITERATIONS: "8",
      USERPROFILE: fileURLToPath(new URL("./fixtures/empty-skill-home", import.meta.url)),
      HOME: fileURLToPath(new URL("./fixtures/empty-skill-home", import.meta.url)),
      FATCAT_SESSION_DIR: sessionDirectory,
      HARNESS_REQUEST_TIMEOUT_MS: "60000", HARNESS_MAX_REQUEST_BYTES: "262144", ...overrides },
    timeout: 5000,
    });
  } finally {
    if (overrides.FATCAT_SESSION_DIR === undefined) {
      const target = resolve(sessionDirectory);
      assert.equal(dirname(target), resolve(tmpdir()));
      assert.ok(basename(target).startsWith("fatcat-cli-sessions-"));
      rmSync(target, { recursive: true, force: true });
    }
  }
}

test("help works without credentials", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Fatcat/);
  assert.match(result.stdout, /--tui/);
  assert.match(result.stdout, /--webui/);
  assert.match(result.stdout, /--web-permission/);
  assert.match(result.stdout, /--continue/);
  assert.match(result.stdout, /\/skills/);
  assert.match(result.stdout, /\/sessions/);
  assert.match(result.stdout, /--no-session-persistence/);
  assert.match(result.stdout, /two child tasks/);
  assert.ok(!result.stdout.includes("--subagent"));
  assert.ok(!result.stdout.includes("--listSkills"));
  assert.ok(!result.stdout.includes("--listSessions"));
  assert.equal(result.stderr, "");
});

test("CLI persists completed tool history, resumes by name and forks without changing the source", async (t) => {
  const { base, workspace } = await temporaryWorkspace(t);
  const env = { FATCAT_SESSION_DIR: join(base, "sessions"), DEEPSEEK_API_KEY: "offline-session-only" };
  const create = run(["--chat", "-n", "original"], env, "keep\nadd\n/exit\n", workspace);
  assert.equal(create.status, 0, create.stderr);
  const listed = run(["--chat", "--resume", "original"], env, "/sessions\n/exit\n", workspace);
  assert.equal(listed.status, 0, listed.stderr);
  assert.equal(listed.stdout, "");
  assert.ok(!listed.stderr.includes('"type":"model_request"'));
  const original = (await new SessionStore({ root: env.FATCAT_SESSION_DIR }).list(workspace))[0]!;
  assert.equal(original.name, "original");
  assert.equal(original.turnCount, 2);
  assert.ok(listed.stderr.includes(original.id));
  assert.ok(!(listed.stdout + listed.stderr).includes("offline-session-only"));
  const picker = run(["--resume"], { FATCAT_SESSION_DIR: env.FATCAT_SESSION_DIR }, undefined, workspace);
  assert.equal(picker.status, 0, picker.stderr);
  assert.match(picker.stdout, new RegExp(original.id));
  assert.ok(!picker.stderr.includes("DEEPSEEK_API_KEY"));
  const fork = run(["--resume", "original", "--fork-session", "--name", "copy", "--prompt", "history"], env, "", workspace);
  assert.equal(fork.status, 0, fork.stderr);
  const restored = JSON.parse(fork.stdout);
  assert.deepEqual(restored.map((message: { role: string }) => message.role),
    ["user", "assistant", "user", "assistant", "tool", "assistant"]);
  assert.equal(restored[4].tool_call_id, "call_1");
  assert.equal(restored[4].content, '{"ok":true,"result":42}');
  const afterFork = await new SessionStore({ root: env.FATCAT_SESSION_DIR }).list(workspace);
  assert.equal(afterFork.find((session) => session.name === "original")?.turnCount, 2);
  const copy = afterFork.find((session) => session.name === "copy")!;
  assert.equal(copy.forkedFrom, original.id);
  assert.equal(copy.turnCount, 3);
  const continued = run(["-c", "--prompt", "history"], env, "", workspace);
  assert.equal(continued.status, 0, continued.stderr);
  assert.equal(JSON.parse(continued.stdout).length, 8);
  const resumed = run(["-r", original.id, "--prompt", "history"], env, "", workspace);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(JSON.parse(resumed.stdout).length, 6);
});

test("session resume is workspace scoped and uses current permission settings", async (t) => {
  const { base, workspace, outside } = await temporaryWorkspace(t);
  await writeFile(join(workspace, "notes.txt"), "before");
  const env = { FATCAT_SESSION_DIR: join(base, "sessions"), DEEPSEEK_API_KEY: "offline-session-only" };
  const initial = run(["--name", "editable", "--permission", "workspace-write", "--prompt", "keep"], env, "", workspace);
  assert.equal(initial.status, 0, initial.stderr);
  const resumed = run(["--resume", "editable", "--permission", "read-only", "--prompt", "write fixture"], env, "", workspace);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(resumed.stdout, /PERMISSION_DENIED/);
  assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "before");
  assert.deepEqual(await new SessionStore({ root: env.FATCAT_SESSION_DIR }).list(outside), []);
  assert.equal(run(["--resume", "editable", "--prompt", "history"], env, "", outside).status, 1);
  assert.equal(run(["--continue", "--prompt", "history"], env, "", outside).status, 1);
});

test("chat session commands create, rename, switch and fork locally; persistence can be disabled", async (t) => {
  const { base, workspace } = await temporaryWorkspace(t);
  const env = { FATCAT_SESSION_DIR: join(base, "sessions"), DEEPSEEK_API_KEY: "offline-session-only" };
  const result = run(["--chat", "--name", "first"], env,
    "keep\n/new second\nhistory\n/resume first\nhistory\n/rename renamed\n/fork copied\n/sessions\n/exit\n", workspace);
  assert.equal(result.status, 0, result.stderr);
  const responses = result.stdout.trim().split("\n");
  assert.equal(responses[0], "keep");
  assert.equal(responses[1], "[]");
  assert.deepEqual(JSON.parse(responses[2]!), [{ role: "user", content: "keep" }, { role: "assistant", content: "keep" }]);
  const sessions = await new SessionStore({ root: env.FATCAT_SESSION_DIR }).list(workspace);
  assert.deepEqual(sessions.map((session) => session.name).sort(), ["copied", "renamed", "second"]);
  assert.equal(sessions.find((session) => session.name === "renamed")?.turnCount, 2);
  assert.equal(sessions.find((session) => session.name === "copied")?.turnCount, 2);
  const disabled = { ...env, FATCAT_SESSION_DIR: join(base, "memory-only") };
  const memory = run(["--chat", "--no-session-persistence", "--name", "temporary"], disabled,
    "keep\n/clear\nhistory\n/resume temporary\nhistory\n/exit\n", workspace);
  assert.equal(memory.status, 0, memory.stderr);
  assert.deepEqual(JSON.parse(memory.stdout.trim().split("\n")[2]!),
    [{ role: "user", content: "keep" }, { role: "assistant", content: "keep" }]);
  assert.deepEqual(await new SessionStore({ root: disabled.FATCAT_SESSION_DIR }).list(workspace), []);
});

test("invalid session options are rejected before loading model credentials", () => {
  for (const args of [["--continue", "--resume", "id"], ["--fork-session", "--chat"],
    ["--chat", "--continue", "--no-session-persistence"], ["--chat", "--resume", "id", "--no-session-persistence"],
    ["--chat", "--name", " "], ["--help", "--continue"], ["--checkConfig", "--name", "name"]]) {
    const result = run(args);
    assert.equal(result.status, 2, JSON.stringify(args));
    assert.ok(!result.stderr.includes("DEEPSEEK_API_KEY"));
  }
});

test("removed listing flags are rejected before configuration or startup", () => {
  for (const flag of ["--listSkills", "--listSessions"]) {
    for (const args of [[flag], [flag, "--chat"], [flag, "--help"], [flag, "--checkConfig"],
      [flag, "--permission", "read-only"]]) {
      const result = run(args, { HARNESS_PROVIDER: "invalid-provider" });
      assert.equal(result.status, 2, JSON.stringify(args));
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /Error \[USAGE\]/);
      assert.ok(!result.stderr.includes("DEEPSEEK_API_KEY"));
      assert.ok(!result.stderr.includes("Chat started"));
      assert.ok(!result.stderr.includes("Error [CONFIG]"));
    }
  }
});

test("CLI web is available by default, independently denied and rejects invalid options", () => {
  for (const args of [["--chat", "--web-permission", "ask"], ["--help", "--web-permission", "deny"],
    ["--checkConfig", "--web-permission", "allow"], ["--web-permission", "deny"]]) {
    assert.equal(run(args).status, 2, JSON.stringify(args));
  }
  const env = { DEEPSEEK_API_KEY: "offline-web-cli" };
  const allowed = run(["--chat", "--permission", "read-only"], env, "web permission\n/exit\n");
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stdout, /WEB_ALLOWED/);
  const denied = run(["--chat", "--web-permission", "deny"], env, "web denied\n/exit\n");
  assert.equal(denied.status, 0, denied.stderr);
  assert.match(denied.stdout, /WEB_DENIED/);
  assert.ok(!denied.stderr.includes("public news"));
});

test("TUI mode rejects pipes and conflicting modes before loading credentials", () => {
  const piped = run(["--tui"], {}, "/exit\n");
  assert.equal(piped.status, 2);
  assert.match(piped.stderr, /interactive terminal/);
  assert.ok(!piped.stderr.includes("DEEPSEEK_API_KEY"));
  for (const args of [["--tui", "--chat"], ["--tui", "--help"], ["--tui", "--checkConfig"],
    ["--tui", "task"], ["--tui", "--prompt", "task"]]) {
    assert.equal(run(args).status, 2, JSON.stringify(args));
  }
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

test("Web UI validates exclusive modes and its port before loading credentials", () => {
  for (const args of [["--webui", "--chat"], ["--webui", "--tui"], ["--webui", "--help"],
    ["--webui", "--checkConfig"], ["--webui", "task"], ["--webui", "--prompt", "task"],
    ["--chat", "--port", "3210"], ["--port", "3210"], ["--webui", "--port", "0"],
    ["--webui", "--port", "65536"], ["--webui", "--port", "1.5"], ["--webui", "--port", "abc"]]) {
    assert.equal(run(args).status, 2, JSON.stringify(args));
  }
  const missing = run(["--webui", "--workspace", ".", "--permission", "read-only", "--web-permission", "deny"]);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /DEEPSEEK_API_KEY/);
});

test("local config checks do not contact the model or expose credentials", () => {
  const result = run(["--checkConfig"], { DEEPSEEK_API_KEY: "offline-credential-only" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /no model provider was contacted/);
  assert.ok(!(result.stdout + result.stderr).includes("offline-credential-only"));
});

test("chat /skills lists local metadata without loading bodies or contacting the model", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const skill = join(workspace, ".agents", "skills", "review-fixture");
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "---\nname: review-fixture\ndescription: Review the fixture.\n---\nPRIVATE_SKILL_BODY\n");
  for (const flags of [[], ["--workspace", workspace]]) {
    const result = run(["--chat", ...flags], { DEEPSEEK_API_KEY: "offline-skill-list-only" }, "/skills\n/exit\n", workspace);
    assert.equal(result.status, 0, result.stderr);
    const localRows = result.stderr.split("\n").filter((line) => /^\$.* \[workspace\] \|/.test(line));
    assert.deepEqual(localRows, ['$review-fixture [workspace] | "Review the fixture." | "skill://review-fixture/SKILL.md"']);
    assert.equal(result.stdout, "");
    assert.ok(!result.stderr.includes("PRIVATE_SKILL_BODY"));
    assert.ok(!result.stderr.includes(workspace));
    assert.ok(!result.stderr.includes("offline-skill-list-only"));
    for (const event of ["model_request", "tool_result", "execution_report"]) assert.ok(!result.stderr.includes(`"type":"${event}"`));
  }
});

test("CLI discovers skills for ordinary tasks and reset clears loaded instructions", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const skill = join(workspace, ".fatcat", "skills", "review-fixture");
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "---\nname: review-fixture\ndescription: Review the fixture.\n---\nPRIVATE_SKILL_BODY\n");
  const result = run(["--chat", "--permission", "read-only"],
    { DEEPSEEK_API_KEY: "offline-skill-only" }, "skill load\nskill recall\n/reset\nskill recall\n/exit\n", workspace);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split("\n"), ["SKILL_LOADED", "SKILL_PRESENT", "SKILL_ABSENT"]);
  assert.ok(!result.stderr.includes("PRIVATE_SKILL_BODY"));
  assert.ok(!result.stderr.includes(workspace));
});

test("new provider config checks select only their own credential without making requests", () => {
  for (const [provider, key] of [["kimi", "MOONSHOT_API_KEY"], ["mimo", "MIMO_API_KEY"], ["qwen", "DASHSCOPE_API_KEY"]]) {
    const result = run(["--checkConfig"], { HARNESS_PROVIDER: provider!, [key!]: "offline-provider-only" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`Provider: ${provider}`));
    assert.ok(!(result.stdout + result.stderr).includes("offline-provider-only"));
    assert.match(result.stdout, /no model provider was contacted/);
  }
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
  assert.match(history[0].content, /Harness session recovery notice/);
  assert.match(history[0].content, /Do not automatically replay prior calls/);
  assert.deepEqual(history.slice(1), [{ role: "user", content: "keep" }, { role: "assistant", content: "keep" }]);
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

test("permission options require a task but do not require an explicit workspace", () => {
  for (const option of [["--permission", "workspace-write"], ["--shell-permission", "allow"]]) {
    for (const mode of [[], ["--help"], ["--checkConfig"]]) {
      const args = [...mode, ...option];
      assert.equal(run(args).status, 2, JSON.stringify(args));
    }
  }
});

test("ordinary prompt and chat expose workspace tools rooted at the launch directory", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await writeFile(join(workspace, "notes.txt"), "launch-directory-text");
  const env = { DEEPSEEK_API_KEY: "offline-only", FATCAT_TEST_WORKSPACE_ROOT: workspace };
  const single = run(["--prompt", "workspace"], env, "", workspace);
  assert.equal(single.status, 0, single.stderr);
  assert.equal(JSON.parse(single.stdout).result.content, "launch-directory-text");
  const chat = run(["--chat"], env, "workspace\nhistory\n/reset\nworkspace\n/exit\n", workspace);
  assert.equal(chat.status, 0, chat.stderr);
  const answers = chat.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(answers[0].result.content, "launch-directory-text");
  assert.deepEqual(answers[2], answers[0]);
  assert.ok(!JSON.stringify(answers[1]).includes("Workspace root (JSON string):"));
  assert.ok(!chat.stderr.includes(workspace));
});

test("single tasks and chat share workspace definitions, results, and safe error handling", async (t) => {
  const { workspace, outside } = await temporaryWorkspace(t);
  const folder = join(workspace, "text samples");
  await mkdir(folder);
  await writeFile(join(folder, "notes.txt"), "fixture-only-text");
  await writeFile(join(folder, ".env"), "fixture-secret-not-for-model");
  await writeFile(join(outside, "notes.txt"), "wrong-launch-directory-text");
  const env = { DEEPSEEK_API_KEY: "offline-credential-only", FATCAT_TEST_WORKSPACE_ROOT: folder };
  const single = run(["--workspace", folder, "--prompt", "workspace"], env, "", outside);
  assert.equal(single.status, 0, single.stderr);
  assert.deepEqual(JSON.parse(single.stdout), { ok: true, result: { kind: "file", path: "notes.txt", offset: 0, totalLines: 1, startLine: 1, endLine: 1, content: "fixture-only-text", truncated: false, nextOffset: null } });
  const chat = run(["--chat", "--workspace", folder], env, "workspace\n/reset\nworkspace\nworkspace blocked\n/exit\n", outside);
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
  const chat = run(["--chat"], { ...env, FATCAT_TEST_WORKSPACE_ROOT: workspace },
    "delegate workspace\n/reset\ndelegate workspace\n/exit\n", workspace);
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
  for (const args of [["--permission", "unsafe", "--prompt", "task"],
    ["--workspace", workspace, "--permission", "workspace-write", "--help"]]) assert.equal(run(args).status, 2);
  await writeFile(join(workspace, "notes.txt"), "before");
  const env = { DEEPSEEK_API_KEY: "offline-only" };
  const denied = run(["--prompt", "write fixture"], env, "yes\n", workspace);
  assert.equal(denied.status, 0, denied.stderr);
  assert.match(denied.stdout, /PERMISSION_DENIED/);
  assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "before");
  const readOnly = run(["--chat", "--permission", "read-only"], env, "write fixture\nshell fixture\n/exit\n", workspace);
  assert.equal(readOnly.status, 0, readOnly.stderr);
  for (const answer of readOnly.stdout.trim().split("\n")) assert.equal(JSON.parse(answer).error.code, "PERMISSION_DENIED");
  assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "before");
  assert.ok(!readOnly.stderr.includes("shell_record"));
  const allowed = run(["--permission", "workspace-write", "--prompt", "write fixture"], env, "", workspace);
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
  const { workspace, outside } = await temporaryWorkspace(t);
  for (const args of [["--shell-permission", "bad", "task"],
    ["--permission", "read-only", "--shell-permission", "allow", "task"]]) {
    assert.equal(run(args).status, 2);
  }
  const args = ["--permission", "workspace-write", "--prompt", "shell fixture"];
  const denied = run(args, { DEEPSEEK_API_KEY: "offline-only" }, "yes\n", workspace);
  assert.equal(denied.status, 0);
  assert.match(denied.stdout, /PERMISSION_DENIED/);
  assert.ok(!denied.stderr.includes("shell_record"));
  const allowed = run([...args, "--shell-permission", "allow"], { DEEPSEEK_API_KEY: "offline-only" }, "", workspace);
  assert.equal(allowed.status, 0, allowed.stderr);
  assert.match(allowed.stdout, /CLI_COMMAND_READY/);
  assert.match(allowed.stdout, /"success":true/);
  assert.match(allowed.stderr, /shell_record/);
  assert.ok(!allowed.stderr.includes("CLI_COMMAND_READY"));
  for (const flags of [[], ["--workspace", outside]]) {
    const expectedRoot = flags.length === 0 ? workspace : outside;
    const location = run(["--prompt", "shell cwd", "--shell-permission", "allow", ...flags],
      { DEEPSEEK_API_KEY: "offline-only", FATCAT_TEST_WORKSPACE_ROOT: expectedRoot }, "", workspace);
    assert.equal(location.status, 0, location.stderr);
    const outcome = JSON.parse(location.stdout);
    assert.equal(outcome.ok, true);
    assert.equal(outcome.result.success, true);
    assert.equal(outcome.result.stdout.trim(), expectedRoot);
  }
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

test("CLI chat projects old read payloads under pressure while preserving follow-up rules", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await writeFile(join(workspace, "notes.txt"), "CURRENT_MARKER\n" + "x".repeat(12000));
  const result = run(["--chat", "--workspace", workspace, "--permission", "read-only"],
    { DEEPSEEK_API_KEY: "offline-only", HARNESS_MAX_REQUEST_BYTES: "30000" },
    "context load\nkeep-context-rule\ncontext recall " + "padding ".repeat(1375) + "\n/exit\n");
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.trim().endsWith("CURRENT_MARKER"));
  const report = reports(result.stderr);
  assert.equal(report.length, 3);
  assert.equal(report[0]!.contextReduction.parent.requests, 0);
  assert.equal(report[1]!.contextReduction.parent.requests, 0);
  assert.equal(report[2]!.contextReduction.parent.requests, 2);
  assert.equal(report[2]!.requestBytes.parent.rejected, 0);
  assert.ok(report[2]!.contextReduction.parent.bytesSaved > 20000);
  assert.ok(!result.stderr.includes("CURRENT_MARKER"));
  assert.deepEqual(report[2]!.writes, []);
  assert.deepEqual(report[2]!.commands, []);
});
