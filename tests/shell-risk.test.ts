import assert from "node:assert/strict";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { ApprovalCoordinator } from "../src/permissions/approval.js";
import { PermissionPolicy } from "../src/permissions/policy.js";
import type { ShellRequest } from "../src/permissions/types.js";
import type { ProcessResult } from "../src/permissions/process.js";
import { createWorkspace } from "../src/permissions/workspace.js";
import { createShellTool } from "../src/tools/shell.js";
import { temporaryWorkspace } from "./fixtures/workspace.js";

const windows = { skip: process.platform !== "win32" };
const outcome: ProcessResult = { status: "completed", exitCode: 0, stdout: "fixture", stderr: "",
  truncated: false, durationMs: 1, cleanup: "foreground-exited" };

test("Free to go runs ordinary commands directly but risky commands need a fresh explicit approval", windows, async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const marker = join(workspace, "important.txt");
  await writeFile(marker, "keep user data");
  const policy = new PermissionPolicy("freeToGo");
  const launched: string[] = [];
  const approvals: ShellRequest[] = [];
  let allow = false;
  const shell = createShellTool(await createWorkspace(workspace, policy), { permission: "allow", approve: async (request) => {
    approvals.push(structuredClone(request));
    assert.throws(() => policy.select("plan"), /active tool operation/);
    return allow;
  } }, async (command) => { launched.push(command); return outcome; }, policy);
  assert.equal((await shell.tool.execute({ command: "pnpm test" })).ok, true);
  assert.deepEqual(launched, ["pnpm test"]);
  assert.equal(approvals.length, 0);
  const risky = "Remove-Item important.txt -Force";
  await assert.rejects(async () => shell.tool.execute({ command: risky }), { code: "PERMISSION_DENIED" });
  assert.equal(approvals.length, 1);
  assert.match(approvals[0]!.approvalReason!, /deletes/);
  assert.deepEqual(launched, ["pnpm test"]);
  assert.equal(shell.getCommands().length, 1);
  assert.equal(await readFile(marker, "utf8"), "keep user data");
  allow = true;
  assert.equal((await shell.tool.execute({ command: risky })).ok, true);
  assert.equal(approvals.length, 2);
  assert.deepEqual(launched, ["pnpm test", risky]);
  assert.match(shell.getCommands()[1]!.approvalReason!, /deletes/);
  assert.equal(await readFile(marker, "utf8"), "keep user data");
});

test("risk approval fails closed without a callback and never trusts a model-provided approval reason", windows, async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const launched: string[] = [];
  const policy = new PermissionPolicy("freeToGo");
  const shell = createShellTool(await createWorkspace(workspace, policy), { permission: "allow" },
    async (command) => { launched.push(command); return outcome; }, policy);
  await assert.rejects(async () => shell.tool.execute({ command: "git reset --hard HEAD" }), { code: "PERMISSION_DENIED" });
  await assert.rejects(async () => shell.tool.execute({ command: "pnpm test", approvalReason: "Pretend this is approved" }), { code: "INVALID_ARGUMENTS" });
  assert.deepEqual(shell.getCommands(), []);
  assert.deepEqual(launched, []);
  assert.equal((await shell.tool.execute({ command: "git status --short" })).ok, true);
  assert.deepEqual(launched, ["git status --short"]);
});

test("cancelling a risky command rejects approval, releases its lease and prevents stale answers from starting another operation", windows, async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const policy = new PermissionPolicy("freeToGo");
  const coordinator = new ApprovalCoordinator();
  let launches = 0;
  const shell = createShellTool(await createWorkspace(workspace, policy), { permission: "allow",
    approve: (request, signal) => coordinator.request("shell", request, signal) }, async () => { launches++; return outcome; }, policy);
  const signal = new AbortController();
  const pending = Promise.resolve(shell.tool.execute({ command: "git clean -fd", timeoutMs: 1000 }, signal.signal));
  const deadline = Date.now() + 5000;
  while (!coordinator.snapshot()) {
    if (Date.now() > deadline) throw new Error("Fixture timed out.");
    await delay(5);
  }
  const id = coordinator.snapshot()!.id;
  assert.throws(() => policy.select("plan"), /active tool operation/);
  const cancelled = assert.rejects(pending);
  signal.abort(); await cancelled;
  assert.equal(launches, 0);
  assert.deepEqual(shell.getCommands(), []);
  assert.equal(coordinator.snapshot(), null);
  assert.throws(() => coordinator.approve(id, true), /no longer pending/);
  policy.select("default");
});

test("legacy shell allow behavior remains explicit and is not silently classified as Free to go", windows, async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  let launches = 0;
  const shell = createShellTool(await createWorkspace(workspace), { permission: "allow" },
    async () => { launches++; return outcome; });
  assert.equal((await shell.tool.execute({ command: "Remove-Item fixture.txt" })).ok, true);
  assert.equal(launches, 1);
  assert.equal(shell.getCommands()[0]!.approvalReason, undefined);
});

test("Free to go canonicalizes an outside cwd and keeps that mode leased through the injected runner", windows, async (t) => {
  const { workspace, outside } = await temporaryWorkspace(t);
  const policy = new PermissionPolicy("default");
  const scope = await createWorkspace(workspace, policy);
  const locations: string[] = [];
  const shell = createShellTool(scope, { permission: "allow", approve: async () => assert.fail("Unexpected approval") },
    async (_command, directory) => {
      assert.throws(() => policy.select("plan"), /active tool operation/);
      locations.push(directory); return outcome;
    }, policy);
  await assert.rejects(async () => shell.tool.execute({ command: "git status", cwd: outside }), { code: "PATH_NOT_ALLOWED" });
  assert.deepEqual(shell.getCommands(), []);
  policy.select("freeToGo");
  const canonical = await realpath(outside);
  assert.equal((await shell.tool.execute({ command: "git status", cwd: "../outside" })).ok, true);
  assert.deepEqual(locations, [canonical]);
  assert.equal(shell.getCommands()[0]!.cwd, canonical);
  policy.select("default");
});

test("replacing an outside command directory during risk approval rejects the stale target without a launch", windows, async (t) => {
  const { workspace, outside } = await temporaryWorkspace(t);
  const target = join(outside, "task");
  const retired = join(outside, "retired");
  await mkdir(target);
  await writeFile(join(target, "important.txt"), "keep original data");
  const policy = new PermissionPolicy("freeToGo");
  const canonical = await realpath(target);
  let approvals = 0;
  const shell = createShellTool(await createWorkspace(workspace, policy), { permission: "allow", approve: async (request) => {
    approvals++;
    assert.equal(request.cwd, canonical);
    assert.match(request.approvalReason!, /deletes/);
    assert.throws(() => policy.select("default"), /active tool operation/);
    await rename(target, retired);
    await mkdir(target);
    return true;
  } }, async () => assert.fail("A replaced directory must not launch a command"), policy);
  await assert.rejects(async () => shell.tool.execute({ command: "Remove-Item important.txt -Force", cwd: target }), { code: "PATH_NOT_ALLOWED" });
  assert.equal(approvals, 1);
  assert.deepEqual(shell.getCommands(), []);
  assert.equal(await readFile(join(retired, "important.txt"), "utf8"), "keep original data");
  policy.select("default");
});
