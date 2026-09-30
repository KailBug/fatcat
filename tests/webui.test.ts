import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer, request } from "node:http";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { HarnessError } from "../src/errors.js";
import type { Message, Model, ModelTurn } from "../src/model.js";
import { Session } from "../src/session.js";
import { createTools } from "../src/tools.js";
import { WebUiController } from "../webui/controller.js";
import type { WebUiInfo } from "../webui/controller.js";
import { startWebUiServer } from "../webui/server.js";
import { temporaryWorkspace } from "./fixtures/workspace.js";

const info: WebUiInfo = { provider: "deepseek", model: "offline", workspace: "fixture", permission: "ask",
  shellPermission: "ask", webPermission: "deny", maxIterations: 4, maxRequestBytes: 262144, skills: 0, warnings: [] };
const answer = (content = "Ready"): ModelTurn => ({ message: { role: "assistant", content }, toolCalls: [] });
function tool(name: string, args: unknown): ModelTurn {
  const toolCalls = [{ id: "call-fixture", type: "function" as const, function: { name, arguments: JSON.stringify(args) } }];
  return { message: { role: "assistant", content: null, tool_calls: toolCalls }, toolCalls };
}
async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!await predicate()) { if (Date.now() > deadline) throw new Error("Fixture timed out."); await delay(10); }
}

test("Web UI preserves successful history, isolates snapshots and resets only while idle", async () => {
  const requests: Message[][] = [];
  const controller = new WebUiController(info, new Session({ maxIterations: 2, model: async (messages) => {
    requests.push(structuredClone(messages)); return answer("Hello \u4e16\u754c");
  } }));
  controller.submit("Remember amber");
  assert.throws(() => controller.submit("Concurrent"), /current turn/);
  assert.throws(() => controller.reset(), /current turn/);
  await until(() => !controller.snapshot().busy);
  controller.snapshot().turns[0]!.prompt = "mutated";
  assert.equal(controller.snapshot().turns[0]?.prompt, "Remember amber");
  controller.submit("Recall"); await until(() => !controller.snapshot().busy);
  assert.equal(requests[1]?.[1]?.content, "Remember amber");
  assert.equal(controller.snapshot().turns[1]?.answer, "Hello \u4e16\u754c");
  assert.equal(controller.snapshot().turns[1]?.report?.modelRequests.parent, 1);
  assert.equal(controller.snapshot().turns[1]?.report?.tokenUsage.parent.totals, null);
  controller.reset(); controller.submit("Fresh"); await until(() => !controller.snapshot().busy);
  assert.equal(requests[2]?.length, 2);
  assert.equal(controller.snapshot().turns.length, 1);
  await controller.close();
  assert.throws(() => controller.submit("Closed"), /shutting down/);
});

test("Web UI safely reports failures and cancellation, then permits another turn", async () => {
  const model: Model = async (messages, signal) => {
    const prompt = messages.at(-1)?.content;
    if (prompt === "Fail") throw new Error("PRIVATE_PROVIDER_RESPONSE");
    if (prompt === "Wait") await new Promise<void>((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(new HarnessError("CANCELLED", "Run cancelled.")), { once: true });
    });
    assert.ok(!JSON.stringify(messages).includes('"content":"Fail"'));
    return answer();
  };
  const controller = new WebUiController(info, new Session({ model, maxIterations: 2 }));
  controller.submit("Fail"); await until(() => !controller.snapshot().busy);
  assert.ok(!JSON.stringify(controller.snapshot()).includes("PRIVATE_PROVIDER_RESPONSE"));
  assert.equal(controller.snapshot().turns[0]?.report?.outcome, "stopped");
  controller.submit("Wait"); await delay(10); controller.stop();
  await until(() => !controller.snapshot().busy);
  assert.match(controller.snapshot().turns[1]!.error!, /CANCELLED/);
  controller.submit("Continue"); await until(() => !controller.snapshot().busy);
  assert.equal(controller.snapshot().turns[2]?.status, "answered");
  await controller.close();
});

test("browser approvals enforce real workspace writes, reject replay and retain facts after reset", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  let controller: WebUiController;
  const tools = await createTools(workspace, "ask", (req, signal) => controller.requestApproval("write", req, signal));
  const results: string[] = [];
  const model: Model = async (messages) => {
    if (messages.at(-1)?.role === "tool") { results.push(String(messages.at(-1)?.content)); return answer(); }
    return tool("write", { path: "result.txt", content: "Approved content" });
  };
  controller = new WebUiController(info, new Session({ model, tools, maxIterations: 2 }));
  t.after(() => controller.close());
  controller.submit("Deny"); await until(() => Boolean(controller.snapshot().approval));
  const denied = controller.snapshot().approval!;
  await assert.rejects(readFile(join(workspace, "result.txt")));
  assert.throws(() => controller.approve("wrong", true), /no longer pending/);
  controller.approve(denied.id, false);
  assert.throws(() => controller.approve(denied.id, true), /no longer pending/);
  await until(() => !controller.snapshot().busy);
  assert.match(results[0]!, /PERMISSION_DENIED/);
  controller.submit("Allow"); await until(() => Boolean(controller.snapshot().approval));
  controller.approve(controller.snapshot().approval!.id, true);
  await until(() => !controller.snapshot().busy);
  assert.equal(await readFile(join(workspace, "result.txt"), "utf8"), "Approved content");
  assert.equal(controller.snapshot().turns[1]?.report?.writes[0]?.status, "committed");
  controller.reset();
  assert.equal(tools.getWrites?.().length, 1);
  assert.equal(await readFile(join(workspace, "result.txt"), "utf8"), "Approved content");
});

test("stopping or closing while approval is pending denies it without writing", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  for (const action of ["stop", "close"] as const) {
    let controller: WebUiController;
    const tools = await createTools(workspace, "ask", (req, signal) => controller.requestApproval("write", req, signal));
    controller = new WebUiController(info, new Session({ maxIterations: 2, tools,
      model: async () => tool("write", { path: `${action}.txt`, content: "Never approved" }) }));
    controller.submit(action); await until(() => Boolean(controller.snapshot().approval));
    const id = controller.snapshot().approval!.id;
    await controller[action](); await until(() => !controller.snapshot().busy);
    assert.equal(controller.snapshot().approval, null);
    assert.throws(() => controller.approve(id, true), /no longer pending/);
    await assert.rejects(readFile(join(workspace, `${action}.txt`)));
    await controller.close();
  }
});

test("Web UI shell approvals use existing command rules and record the real exit code", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  let controller: WebUiController;
  const tools = await createTools(workspace, "ask", undefined, { permission: "ask",
    approve: (req, signal) => controller.requestApproval("shell", req, signal) });
  controller = new WebUiController(info, new Session({ tools, maxIterations: 2, model: async (messages) =>
    messages.at(-1)?.role === "tool" ? answer() : tool("shell", { command: "Write-Output WEBUI_CHECK", cwd: "." }) }));
  t.after(() => controller.close());
  for (const allow of [false, true]) {
    controller.submit("Check shell"); await until(() => Boolean(controller.snapshot().approval));
    assert.equal(controller.snapshot().approval?.kind, "shell");
    controller.approve(controller.snapshot().approval!.id, allow);
    await until(() => !controller.snapshot().busy);
  }
  assert.equal(controller.snapshot().turns[0]?.report?.commands.length, 0);
  assert.equal(controller.snapshot().turns[1]?.report?.commands[0]?.exitCode, 0);
  assert.equal(tools.getCommands?.()[0]?.stdout.trim(), "WEBUI_CHECK");
});

test("read-only mode never requests browser approval for denied write and shell tools", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  let approvals = 0;
  const tools = await createTools(workspace, "read-only", async () => { approvals++; return true; }, {
    permission: "deny", approve: async () => { approvals++; return true; },
  });
  for (const [name, args] of [["write", { path: "no.txt", content: "No" }], ["shell", { command: "Write-Output NO", cwd: "." }]] as const) {
    const controller = new WebUiController(info, new Session({ tools, maxIterations: 2, model: async (messages) =>
      messages.at(-1)?.role === "tool" ? answer(String(messages.at(-1)?.content)) : tool(name, args) }));
    controller.submit("Try tool"); await until(() => !controller.snapshot().busy);
    assert.match(controller.snapshot().turns[0]!.answer!, /PERMISSION_DENIED/);
    await controller.close();
  }
  assert.equal(approvals, 0);
});

test("local HTTP boundary protects state and mutations and serves only built UI assets", async (t) => {
  const controller = new WebUiController(info, new Session({ maxIterations: 1, model: async () => answer() }));
  const server = await startWebUiServer(controller, 0);
  t.after(() => server.close());
  const token = new URLSearchParams(new URL(server.url).hash.slice(1)).get("token")!;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  assert.equal((await fetch(`${server.origin}/api/state`)).status, 401);
  assert.equal((await fetch(`${server.origin}/api/state`, { headers: { ...headers, Origin: "https://example.com" } })).status, 403);
  const badHost = await new Promise<number>((resolve, reject) => {
    request(`${server.origin}/api/state`, { headers: { ...headers, Host: "attacker.example" } }, (res) => { res.resume(); resolve(res.statusCode!); }).on("error", reject).end();
  });
  assert.equal(badHost, 403);
  const state = await fetch(`${server.origin}/api/state`, { headers });
  assert.equal(state.status, 200);
  assert.ok(!(await state.text()).includes(token));
  assert.equal((await fetch(`${server.origin}/api/state`, { headers: { ...headers, "If-None-Match": state.headers.get("etag")! } })).status, 304);
  for (const path of ["/", "/app.js", "/markdown.js", "/styles.css", "/favicon.svg"]) {
    const response = await fetch(server.origin + path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.ok(!(await response.text()).includes(token));
  }
  for (const path of ["/.env", "/src/config.ts", "/../package.json", "/favicon.ico"]) assert.equal((await fetch(server.origin + path)).status, 404);
  const post = (path: string, body: string, custom = headers) => fetch(`${server.origin}/api/${path}`, { method: "POST", headers: custom, body });
  assert.equal((await post("message", '{"prompt":"test"}', { ...headers, Authorization: "Bearer wrong" })).status, 401);
  assert.equal((await post("message", '{"prompt":"test"}', { ...headers, "Content-Type": "text/plain" })).status, 415);
  assert.equal((await post("message", "{invalid")).status, 400);
  assert.equal((await post("message", JSON.stringify({ prompt: "x".repeat(70_000) }))).status, 413);
  assert.equal((await post("message", JSON.stringify({ prompt: "\u4e2d".repeat(12_000) }))).status, 400);
  assert.equal((await post("message", '{"prompt":" "}')).status, 400);
  assert.equal((await post("approval", '{"id":"missing","allowed":"true"}')).status, 400);
  assert.equal((await post("approval", '{"id":"missing","allowed":true}')).status, 409);
  assert.equal((await post("message", '{"prompt":"Hello"}')).status, 202);
  await until(() => !controller.snapshot().busy);
  assert.equal(controller.snapshot().turns[0]?.answer, "Ready");
  assert.equal((await post("reset", "{}")).status, 202);
  assert.equal(controller.snapshot().turns.length, 0);
});

test("HTTP concurrent submissions conflict and shutdown cancels an active model request", async (t) => {
  let cancelled = false;
  const controller = new WebUiController(info, new Session({ maxIterations: 1, model: async (_messages, signal) => {
    await new Promise<void>((_resolve, reject) => signal!.addEventListener("abort", () => {
      cancelled = true; reject(new HarnessError("CANCELLED", "Run cancelled."));
    }, { once: true }));
    return answer();
  } }));
  const server = await startWebUiServer(controller, 0); t.after(() => server.close());
  const token = new URLSearchParams(new URL(server.url).hash.slice(1)).get("token")!;
  const post = (path: string, body: unknown) => fetch(`${server.origin}/api/${path}`, { method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post("message", { prompt: "Wait" })).status, 202);
  assert.equal((await post("message", { prompt: "Second" })).status, 409);
  assert.equal((await post("reset", {})).status, 409);
  await server.close();
  assert.equal(cancelled, true);
  assert.equal(controller.snapshot().busy, false);
});

test("actual CLI Web UI starts without a TTY, uses the launch workspace and keeps credentials server-side", async (t) => {
  let child: ReturnType<typeof spawn> | undefined;
  // Release the child's Windows working directory before the fixture removes it.
  t.after(async () => { if (child && child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<void>((resolve) => child!.once("exit", () => resolve())); child.kill("SIGKILL"); await exited;
  } });
  const { workspace } = await temporaryWorkspace(t);
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address(); assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  child = spawn(process.execPath, ["--import", new URL("./fixtures/webui-transport.js", import.meta.url).href,
    fileURLToPath(new URL("../src/cli.js", import.meta.url)), "--webui", "--port", String(port), "--permission", "read-only"], {
    cwd: workspace, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HARNESS_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "offline-webui-secret",
      DEEPSEEK_MODEL: "offline-model", HARNESS_MAX_ITERATIONS: "4", HARNESS_REQUEST_TIMEOUT_MS: "10000", HARNESS_MAX_REQUEST_BYTES: "262144" },
  });
  let output = ""; let errors = "";
  child.stdout!.on("data", (chunk) => { output += String(chunk); }); child.stderr!.on("data", (chunk) => { errors += String(chunk); });
  await until(() => /http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]+/.test(output) || child!.exitCode !== null);
  const url = output.match(/http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]+/)?.[0]; assert.ok(url, errors);
  const { origin, hash } = new URL(url);
  const headers = { Authorization: `Bearer ${new URLSearchParams(hash.slice(1)).get("token")}`, "Content-Type": "application/json" };
  const snapshot = await (await fetch(`${origin}/api/state`, { headers })).json();
  assert.equal(snapshot.info.workspace, workspace);
  assert.equal(snapshot.info.permission, "read-only");
  assert.equal(snapshot.info.shellPermission, "deny");
  assert.ok(!JSON.stringify(snapshot).includes("offline-webui-secret"));
  assert.equal((await fetch(`${origin}/api/message`, { method: "POST", headers, body: JSON.stringify({ prompt: "Hello" }) })).status, 202);
  await until(async () => !(await (await fetch(`${origin}/api/state`, { headers })).json()).busy);
  const final = await (await fetch(`${origin}/api/state`, { headers })).json();
  assert.match(final.turns[0].answer, /offline preview/);
  assert.equal(final.turns[0].report.tokenUsage.parent.totals.totalTokens, 30);
  assert.ok(!(output + errors).includes("offline-webui-secret"));
});
