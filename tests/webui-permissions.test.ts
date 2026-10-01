import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { TestContext } from "node:test";
import { PermissionPolicy } from "../src/permissions/policy.js";
import { SessionManager } from "../src/session/manager.js";
import { createTools } from "../src/tools.js";
import type { Model, ModelTurn } from "../src/model.js";
import { WebUiController } from "../webui/controller.js";
import type { WebUiState } from "../webui/controller.js";
import { startWebUiServer } from "../webui/server.js";
import { temporaryWorkspace } from "./fixtures/workspace.js";

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Permission fixture timed out.");
    await delay(10);
  }
}

function call(name: string, args: unknown): ModelTurn {
  const toolCalls = [{ id: "permission-fixture", type: "function" as const,
    function: { name, arguments: JSON.stringify(args) } }];
  return { message: { role: "assistant", content: null, tool_calls: toolCalls }, toolCalls };
}

const model: Model = async (messages) => {
  const last = messages.at(-1)!;
  if (last.role === "user") {
    if (last.content === "write") return call("write", { path: "notes.txt", oldText: "before", newText: "after" });
    if (last.content === "shell") return call("shell", { command: "'PERMISSION_FIXTURE'" });
    return call("read", { path: "notes.txt" });
  }
  return { message: { role: "assistant", content: String(last.content) }, toolCalls: [] };
};

async function setup(t: TestContext, policy = new PermissionPolicy("default", { webDenied: true }), webPermission: "allow" | "deny" = "deny") {
  const { workspace } = await temporaryWorkspace(t);
  await writeFile(join(workspace, "notes.txt"), "before");
  let controller!: WebUiController;
  const initial = policy.snapshot();
  const tools = await createTools(workspace, initial.permission,
    (request, signal) => controller.requestApproval("write", request, signal),
    { permission: initial.shellPermission, approve: (request, signal) => controller.requestApproval("shell", request, signal) },
    { permission: webPermission }, policy);
  const manager = await SessionManager.open({ model, tools, maxIterations: 2 }, { workspace, persistence: false });
  controller = await WebUiController.create({ provider: "deepseek", model: "offline", workspace,
    permission: initial.permission, shellPermission: initial.shellPermission, webPermission,
    maxIterations: 2, maxRequestBytes: 262144, skills: 0, warnings: [] }, manager, policy);
  t.after(() => controller.close());
  return { controller, tools, manager, workspace };
}

test("Web UI modes change actual tool authorization, keep approvals once-only and retain journals across sessions", async (t) => {
  const { controller, tools, manager, workspace } = await setup(t);
  controller.submit("write");
  await until(() => controller.snapshot().approval?.kind === "write");
  const pending = controller.snapshot().approval!;
  assert.throws(() => controller.selectPermissionMode("acceptEdits"), /current turn/);
  assert.equal(controller.snapshot().approval?.id, pending.id);
  controller.approve(pending.id, false);
  await until(() => !controller.snapshot().busy);
  assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "before");
  assert.throws(() => controller.approve(pending.id, true), /no longer pending/);
  controller.selectPermissionMode("acceptEdits");
  controller.submit("write");
  await until(() => !controller.snapshot().busy);
  assert.equal(controller.snapshot().approval, null);
  assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "after");
  assert.equal(tools.getWrites!()[0]?.status, "committed");
  controller.submit("shell");
  await until(() => controller.snapshot().approval?.kind === "shell");
  controller.stop();
  await until(() => !controller.snapshot().busy);
  assert.equal(tools.getCommands!().length, 0);
  controller.selectPermissionMode("plan");
  for (const prompt of ["write", "shell"]) {
    controller.submit(prompt);
    await until(() => !controller.snapshot().busy);
    assert.match(controller.snapshot().turns.at(-1)!.answer!, /PERMISSION_DENIED/);
    assert.equal(controller.snapshot().approval, null);
  }
  controller.submit("read");
  await until(() => !controller.snapshot().busy);
  assert.match(controller.snapshot().turns.at(-1)!.answer!, /after/);
  assert.equal(controller.snapshot().info.webPermission, "deny");
  await controller.newSession();
  assert.equal(controller.snapshot().permissionMode.mode, "plan");
  assert.equal(tools.getWrites!().length, 1);
  assert.equal(manager.history.length, 0);
  const snapshot = controller.snapshot();
  snapshot.permissionMode.availableModes.length = 0;
  assert.equal(controller.snapshot().permissionMode.availableModes.length, 3);
});

test("permission mode HTTP route enforces authentication, schema, idle state and launch deny ceilings", async (t) => {
  const { controller } = await setup(t, new PermissionPolicy({ permission: "ask", shellPermission: "deny" }, { shellDenied: true }));
  const server = await startWebUiServer(controller, 0);
  t.after(() => server.close());
  const token = new URL(server.url).hash.slice("#token=".length);
  const post = (body: unknown, headers: Record<string, string> = {}) => fetch(`${server.origin}/api/permission-mode`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify(body),
  });
  assert.equal((await post({ mode: "plan" }, { Authorization: "invalid" })).status, 401);
  assert.equal((await post({ mode: "plan" }, { Origin: "https://outside.example" })).status, 403);
  for (const body of [{ mode: "auto" }, { mode: "acceptEdits", allowed: true }, { mode: 1 }, {}]) {
    assert.equal((await post(body)).status, 400);
  }
  assert.deepEqual(controller.snapshot().permissionMode.availableModes, ["plan"]);
  assert.equal(controller.snapshot().permissionMode.mode, "custom");
  assert.equal((await post({ mode: "acceptEdits" })).status, 400);
  assert.equal((await post({ mode: "freeToGo" })).status, 400);
  assert.equal(controller.snapshot().info.shellPermission, "deny");
  controller.submit("write");
  await until(() => controller.snapshot().approval !== null);
  assert.equal((await post({ mode: "plan" })).status, 409);
  const approval = controller.snapshot().approval!;
  controller.approve(approval.id, false);
  await until(() => !controller.snapshot().busy);
  assert.equal((await post({ mode: "plan" })).status, 202);
  const response = await fetch(`${server.origin}/api/state`, { headers: { Authorization: `Bearer ${token}` } });
  const state = await response.json() as WebUiState;
  assert.equal(state.permissionMode.mode, "plan");
  assert.equal(state.info.permission, "read-only");
  const etag = response.headers.get("ETag")!;
  assert.equal((await fetch(`${server.origin}/api/state`, { headers: { Authorization: `Bearer ${token}`, "If-None-Match": etag } })).status, 304);
});

test("Free to go HTTP selection changes scopes, retains journals and restores bounded modes", async (t) => {
  const { controller, tools, workspace } = await setup(t, new PermissionPolicy("default"), "allow");
  const server = await startWebUiServer(controller, 0);
  t.after(() => server.close());
  const token = new URL(server.url).hash.slice("#token=".length);
  const select = (mode: string) => fetch(`${server.origin}/api/permission-mode`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ mode }),
  });
  assert.equal((await select("freeToGo")).status, 202);
  assert.equal(controller.snapshot().permissionMode.fileAccess, "unrestricted");
  assert.equal(controller.snapshot().permissionMode.networkAccess, "unrestricted");
  assert.equal(controller.snapshot().info.shellPermission, "allow");
  const path = join(workspace, "..", "outside", "free.txt");
  assert.equal((await tools.execute("write", JSON.stringify({ path, content: "outside fixture" }))).ok, true);
  assert.equal(controller.snapshot().approval, null);
  assert.equal(await readFile(path, "utf8"), "outside fixture");
  await controller.newSession();
  assert.equal(controller.snapshot().permissionMode.mode, "freeToGo");
  assert.equal(tools.getWrites!().length, 1);
  assert.equal((await select("default")).status, 202);
  assert.equal(controller.snapshot().permissionMode.fileAccess, "workspace");
  assert.equal(controller.snapshot().permissionMode.networkAccess, "public");
  const outside = await tools.execute("read", JSON.stringify({ path }));
  assert.equal(outside.ok, false);
  if (!outside.ok) assert.equal(outside.error.code, "PATH_NOT_ALLOWED");
  assert.equal(tools.getWrites!().length, 1);
});
