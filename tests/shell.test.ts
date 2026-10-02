import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { HarnessError } from "../src/errors.js";
import { createTools } from "../src/tools.js";
import { createShellTool } from "../src/tools/shell.js";
import { createWorkspace } from "../src/permissions/workspace.js";
import { commandEnvironment, runPowerShell, outputLimit } from "../src/permissions/process.js";
import { createTerminalInput } from "../src/terminal.js";
import { temporaryWorkspace } from "./fixtures/workspace.js";

const windows = { skip: process.platform !== "win32" };
const quote = (value: string) => "'" + value.replaceAll("'", "''") + "'";

test("shell needs separate authorization and read-only cannot elevate it", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  for (const permission of ["read-only", "workspace-write"] as const) {
    const tools = await createTools(workspace, permission);
    assert.ok(tools.definitions.some((tool) => tool.function.name === "shell"));
    const result = await tools.execute("shell", '{"command":"exit 0"}');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "PERMISSION_DENIED");
    assert.deepEqual(tools.getCommands!(), []);
  }
  await assert.rejects(createTools(workspace, "read-only", undefined, { permission: "allow" }), /Read-only/);
  await assert.rejects(createTools(undefined, "ask", undefined, { permission: "allow" }), /workspace/);
});

test("shell validates fields and cwd before asking, and rejects a directory changed during approval", windows, async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await writeFile(join(workspace, "file.txt"), "text");
  const tools = await createTools(workspace, "ask", undefined, { permission: "ask", approve: async () => assert.fail("Unexpected approval") });
  for (const args of [{}, { command: "" }, { command: "x", extra: true }, { command: "x", timeoutMs: 0 },
    { command: "x", timeoutMs: 120001 }, { command: "x", timeoutMs: 1.5 }, { command: "x", cwd: "../outside" },
    { command: "x", cwd: "file.txt" }, { command: "x", cwd: ".git" }, { command: "x\0y" }, { command: "x".repeat(4001) }]) {
    assert.equal((await tools.execute("shell", JSON.stringify(args))).ok, false);
  }
  const scope = await createWorkspace(workspace);
  let reads = 0;
  const shell = createShellTool({ ...scope, async resolvePath(path, signal) {
    const result = await scope.resolvePath(path, signal);
    if (++reads === 2) result.absolute += "-changed";
    return result;
  } }, { permission: "ask", approve: async () => true }, async () => assert.fail("Directory changed"));
  await assert.rejects(async () => shell.tool.execute({ command: "exit 0" }), /directory changed/);
});

test("native PowerShell preserves cwd, Unicode, stderr and nonzero exit codes", windows, async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await mkdir(join(workspace, "nested"));
  const tools = await createTools(workspace, "workspace-write", undefined, { permission: "allow" });
  const result = await tools.execute("shell", JSON.stringify({ cwd: "nested",
    command: "[Console]::Out.WriteLine('hello \u4e2d\u6587'); [Console]::Error.WriteLine('diagnostic'); (Get-Location).Path; exit 7" }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const output = result.result as { success: boolean; stdout: string; stderr: string; exitCode: number; status: string };
  assert.equal(output.success, false);
  assert.equal(output.exitCode, 7, JSON.stringify(result));
  assert.equal(output.status, "completed");
  assert.match(output.stdout, /hello \u4e2d\u6587/);
  assert.ok(output.stdout.includes(join(workspace, "nested")));
  assert.match(output.stderr, /diagnostic/);
  const thrown = await runPowerShell("throw 'expected-failure'", workspace, 10000);
  assert.equal(thrown.exitCode, 1);
  assert.match(thrown.stderr, /expected-failure/);
  const native = await runPowerShell(`& ${quote(process.execPath)} -e 'process.exit(9)'`, workspace, 10000);
  assert.equal(native.exitCode, 9);
  const copy = tools.getCommands!(); copy[0]!.exitCode = 0;
  assert.equal(tools.getCommands!()[0]!.exitCode, 7);
});

test("child environment excludes model credentials, hooks and arbitrary inherited secrets", windows, async (t) => {
  assert.deepEqual(commandEnvironment({ Path: "runtime", SystemRoot: "windows", PSModulePath: "system-modules", DEEPSEEK_API_KEY: "fake",
    CUSTOM_SECRET: "fake", NODE_OPTIONS: "--import unsafe", GITHUB_TOKEN: "fake" }),
  { Path: "runtime", SystemRoot: "windows", PSModulePath: "system-modules" });
  assert.deepEqual(commandEnvironment({ psmodulepath: "system-modules", PYTHONPATH: "untrusted" }),
    { psmodulepath: "system-modules" });
  const { workspace } = await temporaryWorkspace(t);
  const result = await runPowerShell("if ($env:DEEPSEEK_API_KEY -or $env:NODE_OPTIONS) { exit 5 }; 'environment-ok'", workspace, 10000);
  assert.equal(result.exitCode, 0, JSON.stringify(result));
  assert.match(result.stdout, /environment-ok/);
});

test("output limits bound both streams and stop a noisy command", windows, async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const result = await runPowerShell("[Console]::Out.Write(('x' * 100000)); Start-Sleep -Seconds 30", workspace, 10000);
  assert.equal(result.status, "output_limit", JSON.stringify(result));
  assert.equal(result.truncated, true);
  assert.equal(result.cleanup, "tree-killed");
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= outputLimit);
});

test("timeout and cancellation terminate a foreground process tree and retain outcomes", windows, async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await writeFile(join(workspace, "child.cjs"), 'require("node:fs").writeFileSync("child.pid", String(process.pid)); setInterval(() => {}, 1000);');
  const command = `& ${quote(process.execPath)} child.cjs`;
  const timed = await runPowerShell(command, workspace, 1000);
  assert.equal(timed.status, "timed_out");
  assert.equal(timed.cleanup, "tree-killed");
  const pid = Number(await readFile(join(workspace, "child.pid"), "utf8"));
  assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
  const controller = new AbortController();
  const tools = await createTools(workspace, "workspace-write", undefined, { permission: "allow" });
  const timer = setTimeout(() => controller.abort(), 1000);
  t.after(() => clearTimeout(timer));
  await assert.rejects(tools.execute("shell", JSON.stringify({ command }), controller.signal),
    (error: unknown) => error instanceof HarnessError && error.code === "CANCELLED");
  assert.equal(tools.getCommands!()[0]!.status, "cancelled");
  assert.equal(tools.getCommands!()[0]!.cleanup, "tree-killed");
});

test("terminal command approval is separate, complete, escaped and unavailable to pipes", windows, async (t) => {
  for (const interactive of [true, false]) {
    const input = Object.assign(new PassThrough(), { isTTY: interactive });
    const error = Object.assign(new PassThrough(), { isTTY: interactive });
    let text = ""; error.on("data", (chunk: Buffer) => { text += chunk.toString(); });
    const terminal = createTerminalInput(input, error);
    t.after(terminal.close);
    input.write("yes\n");
    const request = { command: "# " + "x".repeat(2000) + "\n'visible-end'", cwd: ".", timeoutMs: 1000 };
    if (!interactive) {
      await assert.rejects(terminal.approveShell(request), /interactive terminal/);
      continue;
    }
    const pending = terminal.approveShell(request);
    while (!text.includes("Allow this command?")) await once(error, "data", { signal: AbortSignal.timeout(5000) });
    assert.match(text, /outside the workspace/);
    assert.match(text, /visible-end/);
    assert.ok(!text.includes("truncated"));
    input.write("no\n");
    assert.equal(await pending, false);
    assert.equal(await terminal.readTask(), "yes");
    const next = terminal.approveShell({ ...request, command: "exit 0" });
    input.write("yes\n");
    assert.equal(await next, true);
  }
});

test("spawn failure, uncertain cleanup, output summaries and journal bounds are explicit", windows, async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const scope = await createWorkspace(workspace);
  const result = { status: "completed" as const, exitCode: 0, stdout: "x".repeat(2000), stderr: "", truncated: false,
    durationMs: 1, cleanup: "foreground-exited" as const };
  const writer = createShellTool(scope, { permission: "allow" }, async () => result);
  for (let i = 0; i < 20; i++) assert.equal((await writer.tool.execute({ command: "exit 0" })).ok, true);
  await assert.rejects(async () => writer.tool.execute({ command: "exit 0" }), /20 attempts/);
  assert.equal(writer.getCommands()[0]!.outputSummaryTruncated, true);
  assert.equal(writer.getCommands()[0]!.stdout.length, 1000);
  const failed = createShellTool(scope, { permission: "allow" }, async () => ({ ...result, status: "termination_failed", cleanup: "unconfirmed" }));
  await failed.tool.execute({ command: "exit 0" });
  await assert.rejects(async () => failed.tool.execute({ command: "exit 0" }), /prior process tree/);
  const missing = await runPowerShell("exit 0", join(workspace, "missing"), 1000);
  assert.equal(missing.status, "spawn_failed");
  assert.equal(missing.cleanup, "not-started");
});


test("denial and cancellation before approval launch nothing, and overlapping shell calls are rejected", windows, async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const scope = await createWorkspace(workspace);
  const denied = createShellTool(scope, { permission: "ask", approve: async () => false }, async () => assert.fail("Denied command ran"));
  await assert.rejects(async () => denied.tool.execute({ command: "exit 0" }), /not approved/);
  assert.deepEqual(denied.getCommands(), []);
  const controller = new AbortController();
  const cancelled = createShellTool(scope, { permission: "ask", approve: async () => { controller.abort(); return true; } }, async () => assert.fail("Cancelled command ran"));
  await assert.rejects(async () => cancelled.tool.execute({ command: "exit 0" }, controller.signal), /cancelled/);
  assert.deepEqual(cancelled.getCommands(), []);
  let release!: (allow: boolean) => void;
  let waiting!: () => void;
  const ready = new Promise<void>((resolve) => { waiting = resolve; });
  const pending = createShellTool(scope, { permission: "ask", approve: async () => { waiting(); return new Promise((resolve) => { release = resolve; }); } });
  const first = pending.tool.execute({ command: "exit 0" });
  const rejected = assert.rejects(async () => first, /not approved/);
  await ready;
  await assert.rejects(async () => pending.tool.execute({ command: "exit 0" }), /already running/);
  release(false);
  await rejected;
});
