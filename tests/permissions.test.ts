import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { ApprovalCoordinator } from "../src/permissions/approval.js";
import { isPermissionMode, PermissionPolicy } from "../src/permissions/policy.js";
import type { PermissionMode } from "../src/permissions/types.js";
import { createWorkspace } from "../src/permissions/workspace.js";
import type { ProcessResult } from "../src/permissions/process.js";
import { createSubagentTools } from "../src/subagent.js";
import { createTools } from "../src/tools.js";
import type { ToolResult } from "../src/tools.js";
import { createShellTool } from "../src/tools/shell.js";
import { createWriteTool } from "../src/tools/write.js";
import { temporaryWorkspace } from "./fixtures/workspace.js";

function denied(result: ToolResult): void {
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "PERMISSION_DENIED");
}

test("permission modes preserve legacy settings, expose allowed choices, and enforce launch ceilings", () => {
  const policy = new PermissionPolicy("default");
  assert.deepEqual(policy.snapshot(), { mode: "default", permission: "ask", shellPermission: "ask",
    fileAccess: "workspace", networkAccess: "public", availableModes: ["default", "acceptEdits", "plan", "freeToGo"] });
  policy.select("acceptEdits");
  assert.equal(policy.snapshot().permission, "workspace-write");
  assert.equal(policy.snapshot().shellPermission, "ask");
  policy.select("plan");
  assert.equal(policy.snapshot().permission, "read-only");
  assert.equal(policy.snapshot().shellPermission, "deny");
  policy.snapshot().availableModes.length = 0;
  assert.equal(policy.availableModes().length, 4);
  assert.equal(isPermissionMode(undefined), false);
  assert.equal(isPermissionMode("custom"), false);
  assert.equal(isPermissionMode("acceptEdits"), true);
  assert.equal(isPermissionMode("freeToGo"), true);
  assert.throws(() => policy.select("bypassPermissions" as PermissionMode), /Permission mode/);
  const legacy = new PermissionPolicy({ permission: "workspace-write", shellPermission: "allow" }).snapshot();
  assert.equal(legacy.mode, "custom");
  assert.equal(legacy.fileAccess, "workspace");
  assert.equal(legacy.networkAccess, "public");
  policy.select("freeToGo");
  assert.deepEqual(policy.snapshot(), { mode: "freeToGo", permission: "workspace-write", shellPermission: "allow",
    fileAccess: "unrestricted", networkAccess: "unrestricted", availableModes: ["default", "acceptEdits", "plan", "freeToGo"] });
  assert.throws(() => new PermissionPolicy({ permission: "read-only", shellPermission: "ask" }), /Read-only/);
  for (const limits of [{ readOnly: true }, { shellDenied: true }]) {
    const restricted = new PermissionPolicy({ permission: "read-only", shellPermission: "deny" }, limits);
    assert.deepEqual(restricted.availableModes(), ["plan"]);
    assert.throws(() => restricted.select("default"), /launch restrictions/);
    assert.throws(() => restricted.select("acceptEdits"), /launch restrictions/);
    assert.throws(() => restricted.select("freeToGo"), /launch restrictions/);
    assert.throws(() => new PermissionPolicy("freeToGo", limits), /launch restrictions/);
    assert.equal(restricted.snapshot().mode, "plan");
  }
  const networkDenied = new PermissionPolicy("default", { webDenied: true });
  assert.deepEqual(networkDenied.availableModes(), ["default", "acceptEdits", "plan"]);
  assert.throws(() => networkDenied.select("freeToGo"), /launch restrictions/);
  assert.throws(() => new PermissionPolicy("freeToGo", { webDenied: true }), /launch restrictions/);
  const lease = policy.beginOperation();
  assert.equal(lease.fileAccess, "unrestricted");
  assert.throws(() => policy.select("default"), /active tool operation/);
  lease.release(); lease.release();
  policy.select("default");
  assert.equal(policy.snapshot().fileAccess, "workspace");
  assert.equal(policy.snapshot().networkAccess, "public");
});

test("shared tools switch live write authorization without rebuilding journals or weakening path rules", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const policy = new PermissionPolicy("default");
  let approvals = 0;
  const tools = await createTools(workspace, "ask", async () => { approvals++; return true; },
    { permission: "ask", approve: async () => true }, undefined, policy);
  const delegated = createSubagentTools(tools, async () => ({ message: { role: "assistant", content: "Done" }, toolCalls: [] }), 2);
  const turnTools = delegated.forTurn!();
  assert.equal((await turnTools.execute("write", '{"path":"manual.txt","content":"one"}')).ok, true);
  assert.equal(approvals, 1);
  policy.select("acceptEdits");
  assert.equal(turnTools.getPermissionState!().mode, "acceptEdits");
  assert.equal((await turnTools.execute("write", '{"path":"accepted.txt","content":"two"}')).ok, true);
  assert.equal(approvals, 1);
  for (const path of ["../outside.txt", ".env", "node_modules/file.txt"]) {
    const result = await turnTools.execute("write", JSON.stringify({ path, content: "blocked" }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "PATH_NOT_ALLOWED");
  }
  const records = tools.getWrites!();
  assert.equal(records.length, 2);
  policy.select("plan");
  denied(await turnTools.execute("write", '{"path":"planned.txt","content":"blocked"}'));
  denied(await turnTools.execute("shell", '{"command":"exit 0"}'));
  assert.equal((await turnTools.execute("read", '{"path":"accepted.txt"}')).ok, true);
  assert.deepEqual(tools.getWrites!(), records);
  assert.equal(await readFile(join(workspace, "accepted.txt"), "utf8"), "two");
  assert.deepEqual((await readdir(workspace)).sort(), ["accepted.txt", "manual.txt"]);
  policy.select("default");
  assert.equal((await turnTools.execute("write", '{"path":"last.txt","content":"three"}')).ok, true);
  assert.equal(approvals, 2);
  assert.equal(tools.getWrites!().length, 3);
});

test("manual mode without an approval callback stays denied; acceptEdits preauthorizes only writes", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const policy = new PermissionPolicy("default");
  const tools = await createTools(workspace, "ask", undefined, {}, undefined, policy);
  denied(await tools.execute("write", '{"path":"no-approval.txt","content":"blocked"}'));
  policy.select("acceptEdits");
  assert.equal((await tools.execute("write", '{"path":"accepted.txt","content":"allowed"}')).ok, true);
  denied(await tools.execute("shell", '{"command":"exit 0"}'));
  assert.deepEqual(tools.getCommands!(), []);
  await assert.rejects(createTools(undefined, "read-only", undefined, {}, undefined, policy), /explicit workspace/);
});

test("shell uses the shared policy while retaining approval and command records", { skip: process.platform !== "win32" }, async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const policy = new PermissionPolicy("acceptEdits");
  let approvals = 0;
  let launches = 0;
  const outcome: ProcessResult = { status: "completed", exitCode: 0, stdout: "fixture", stderr: "", truncated: false,
    durationMs: 1, cleanup: "foreground-exited" };
  const shell = createShellTool(await createWorkspace(workspace), { permission: "allow", approve: async () => {
    approvals++; return true;
  } }, async () => { launches++; return outcome; }, policy);
  assert.equal((await shell.tool.execute({ command: "fixture" })).ok, true);
  assert.equal(approvals, 1);
  policy.select("plan");
  await assert.rejects(async () => shell.tool.execute({ command: "fixture" }), /denied/);
  assert.equal(launches, 1);
  assert.equal(approvals, 1);
  policy.select("default");
  assert.equal((await shell.tool.execute({ command: "fixture" })).ok, true);
  assert.equal(launches, 2);
  assert.equal(approvals, 2);
  assert.equal(shell.getCommands().length, 2);
});

test("pending write approval holds the policy stable, and cancellation releases it without side effects", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const coordinator = new ApprovalCoordinator();
  const policy = new PermissionPolicy("default");
  const writer = createWriteTool(await createWorkspace(workspace), "read-only", undefined,
    (request, signal) => coordinator.request("write", request, signal), policy);
  const controller = new AbortController();
  const pending = Promise.resolve(writer.tool.execute({ path: "pending.txt", content: "blocked" }, controller.signal));
  const deadline = Date.now() + 5000;
  while (!coordinator.snapshot()) {
    if (Date.now() > deadline) throw new Error("Fixture timed out.");
    await delay(5);
  }
  const id = coordinator.snapshot()!.id;
  assert.throws(() => policy.select("acceptEdits"), /active tool operation/);
  controller.abort();
  await assert.rejects(pending, { code: "CANCELLED" });
  assert.equal(coordinator.snapshot(), null);
  assert.throws(() => coordinator.approve(id, true), /no longer pending/);
  assert.deepEqual(await readdir(workspace), []);
  assert.deepEqual(writer.getWrites(), []);
  policy.select("acceptEdits");
  assert.equal((await writer.tool.execute({ path: "accepted.txt", content: "allowed" })).ok, true);
  assert.equal(writer.getWrites().length, 1);
});

test("approval coordinator isolates snapshots, rejects stale answers, and cancels only the pending request", async () => {
  let changes = 0;
  const coordinator = new ApprovalCoordinator<{ action: { value: string } }>(() => { changes++; });
  const firstSignal = new AbortController();
  const input = { value: "original" };
  const first = coordinator.request("action", input, firstSignal.signal);
  input.value = "mutated";
  const firstId = coordinator.snapshot()!.id;
  coordinator.snapshot()!.request.value = "changed snapshot";
  assert.equal(coordinator.snapshot()!.request.value, "original");
  assert.throws(() => coordinator.request("action", { value: "concurrent" }), /awaiting approval/);
  assert.throws(() => coordinator.approve("wrong-id", true), /no longer pending/);
  coordinator.approve(firstId, true);
  assert.equal(await first, true);
  assert.throws(() => coordinator.approve(firstId, true), /no longer pending/);
  const secondSignal = new AbortController();
  const second = coordinator.request("action", { value: "second" }, secondSignal.signal);
  const secondId = coordinator.snapshot()!.id;
  assert.notEqual(secondId, firstId);
  firstSignal.abort();
  assert.equal(coordinator.snapshot()!.id, secondId);
  secondSignal.abort();
  assert.equal(await second, false);
  assert.equal(coordinator.snapshot(), null);
  assert.throws(() => coordinator.approve(secondId, true), /no longer pending/);
  assert.equal(await coordinator.request("action", { value: "already cancelled" }, secondSignal.signal), false);
  const third = coordinator.request("action", { value: "denied" });
  coordinator.deny(); coordinator.deny();
  assert.equal(await third, false);
  assert.equal(changes, 6);
});
