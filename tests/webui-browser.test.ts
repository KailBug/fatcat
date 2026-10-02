import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createTools } from "../src/tools.js";
import { SessionManager } from "../src/session/manager.js";
import { PermissionPolicy } from "../src/permissions/policy.js";
import { WebUiController } from "../webui/controller.js";
import { startWebUiServer } from "../webui/server.js";

import { temporaryWorkspace } from "./fixtures/workspace.js";

test("Web UI browser approvals are single-operation and evidence endpoints require the chat capability", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await writeFile(join(workspace, "index.html"), "<h1>Fixture</h1>");
  const policy = new PermissionPolicy("default");
  let controller: WebUiController;
  let launches = 0;
  const tools = await createTools(workspace, "ask", undefined, { permission: "ask" }, undefined, policy, {
    approve: (request, signal) => controller.requestApproval("browser", request, signal),
    runner: async () => { launches++; return { status: "completed", completedSteps: 0,
      diagnostics: [{ kind: "pageerror", message: "<script>not executable</script>" }], diagnosticsTruncated: false,
      sources: [], snapshot: { text: "Fixture" }, png: Buffer.from("fake png") }; },
  });
  let callId = 0;
  const session = await SessionManager.open({ tools, maxIterations: 3, model: async (messages) => {
    if (messages.at(-1)?.role === "tool") return { message: { role: "assistant", content: "Browser result received." }, toolCalls: [] };
    const call = { id: `browser-${++callId}`, type: "function" as const, function: { name: "browser", arguments: '{"path":"index.html"}' } };
    return { message: { role: "assistant", content: null, tool_calls: [call] }, toolCalls: [call] };
  } }, { workspace, persistence: false });
  controller = await WebUiController.create({ provider: "deepseek", model: "offline", workspace,
    permission: "ask", shellPermission: "ask", webPermission: "deny", maxIterations: 3, maxRequestBytes: 262144,
    skills: 0, warnings: [] }, session, policy);
  const server = await startWebUiServer(controller, 0); t.after(() => server.close());
  const token = new URLSearchParams(new URL(server.url).hash.slice(1)).get("token")!;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const post = (path: string, body: unknown) => fetch(server.origin + "/api/" + path, { method: "POST", headers, body: JSON.stringify(body) });
  async function until(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 5000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error("Fixture timed out"); await delay(5); }
  }
  await post("message", { prompt: "Deny a check" });
  await until(() => Boolean(controller.snapshot().approval));
  const denied = controller.snapshot().approval!;
  assert.equal(denied.kind, "browser"); assert.equal(launches, 0);
  assert.equal((await post("approval", { id: denied.id, allowed: false })).status, 202);
  await until(() => !controller.snapshot().busy);
  assert.equal(launches, 0);
  await post("message", { prompt: "Allow a check" });
  await until(() => Boolean(controller.snapshot().approval));
  assert.equal((await post("approval", { id: denied.id, allowed: true })).status, 409);
  assert.equal((await post("approval", { id: controller.snapshot().approval!.id, allowed: true })).status, 202);
  await until(() => !controller.snapshot().busy);
  assert.equal(launches, 1);
  const check = controller.snapshot().turns.at(-1)?.report?.browserChecks?.[0]; assert.ok(check);
  assert.equal(check.errorCount, 1); assert.equal(check.status, "completed");
  const path = `${server.origin}/api/browser-evidence/${check.id}`;
  assert.equal((await fetch(path + "/report")).status, 401);
  assert.equal((await fetch(path + "/report", { headers: { ...headers, Origin: "null" } })).status, 403);
  const report = await fetch(path + "/report", { headers });
  assert.equal(report.status, 200); assert.match(report.headers.get("content-type")!, /application\/json/);
  assert.equal((await report.json() as { id: string }).id, check.id);
  const image = await fetch(path + "/screenshot", { headers });
  assert.equal(image.status, 200); assert.equal(image.headers.get("content-type"), "image/png");
  assert.equal(image.headers.get("cache-control"), "no-store");
  assert.equal((await fetch(`${server.origin}/api/browser-evidence/${"f".repeat(32)}/report`, { headers })).status, 404);
  assert.notEqual((await fetch(`${server.origin}/api/browser-evidence/../../.env/report`, { headers })).status, 200);
  await post("message", { prompt: "Cancel an approval" });
  await until(() => Boolean(controller.snapshot().approval));
  const cancelled = controller.snapshot().approval!.id;
  await post("stop", {}); await until(() => !controller.snapshot().busy);
  assert.equal((await post("approval", { id: cancelled, allowed: true })).status, 409);
  assert.equal(launches, 1);
});
