import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer, request } from "node:http";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { TestContext } from "node:test";
import { HarnessError } from "../src/errors.js";
import type { Message, Model, ModelTurn } from "../src/model.js";
import type { LoopOptions } from "../src/loop.js";
import { SessionManager } from "../src/session/manager.js";
import { SessionStore } from "../src/session/store.js";
import { createTools } from "../src/tools.js";
import { WebUiController } from "../webui/controller.js";
import type { WebUiInfo, WebUiState } from "../webui/controller.js";
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

async function controllerFor(t: TestContext, options: Pick<LoopOptions, "model" | "maxIterations" | "tools">): Promise<WebUiController> {
  const workspace = options.tools?.workspaceRoot ?? (await temporaryWorkspace(t)).workspace;
  const manager = await SessionManager.open(options, { workspace, persistence: false });
  const controller = await WebUiController.create({ ...info, workspace }, manager);
  t.after(() => controller.close());
  return controller;
}

test("Web UI preserves successful history, isolates snapshots and creates new sessions only while idle", async (t) => {
  const requests: Message[][] = [];
  const controller = await controllerFor(t, { maxIterations: 2, model: async (messages) => {
    requests.push(structuredClone(messages)); return answer("Hello \u4e16\u754c");
  } });
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
  const creating = controller.reset();
  assert.throws(() => controller.submit("During session change"), /current turn/);
  assert.throws(() => controller.rename("Concurrent rename"), /current turn/);
  assert.throws(() => controller.deleteSession(controller.snapshot().current.id), /current turn/);
  await creating; controller.submit("Fresh"); await until(() => !controller.snapshot().busy);
  assert.equal(requests[2]?.length, 2);
  assert.equal(controller.snapshot().turns.length, 1);
  await controller.close();
  assert.throws(() => controller.submit("Closed"), /shutting down/);
});

test("Web UI safely reports failures and cancellation, then permits another turn", async (t) => {
  const model: Model = async (messages, signal) => {
    const prompt = messages.at(-1)?.content;
    if (prompt === "Fail") throw new Error("PRIVATE_PROVIDER_RESPONSE");
    if (prompt === "Wait") await new Promise<void>((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(new HarnessError("CANCELLED", "Run cancelled.")), { once: true });
    });
    assert.ok(!JSON.stringify(messages).includes('"content":"Fail"'));
    return answer();
  };
  const controller = await controllerFor(t, { model, maxIterations: 2 });
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
  controller = await controllerFor(t, { model, tools, maxIterations: 2 });
  t.after(() => controller.close());
  controller.submit("Deny"); await until(() => Boolean(controller.snapshot().approval));
  const denied = controller.snapshot().approval!;
  assert.throws(() => controller.deleteSession(controller.snapshot().current.id), /current turn/);
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
  await controller.reset();
  assert.equal(tools.getWrites?.().length, 1);
  assert.equal(await readFile(join(workspace, "result.txt"), "utf8"), "Approved content");
});

test("stopping or closing while approval is pending denies it without writing", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  for (const action of ["stop", "close"] as const) {
    let controller: WebUiController;
    const tools = await createTools(workspace, "ask", (req, signal) => controller.requestApproval("write", req, signal));
    controller = await controllerFor(t, { maxIterations: 2, tools,
      model: async () => tool("write", { path: `${action}.txt`, content: "Never approved" }) });
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
  controller = await controllerFor(t, { tools, maxIterations: 2, model: async (messages) =>
    messages.at(-1)?.role === "tool" ? answer() : tool("shell", { command: "Write-Output WEBUI_CHECK", cwd: "." }) });
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
    const controller = await controllerFor(t, { tools, maxIterations: 2, model: async (messages) =>
      messages.at(-1)?.role === "tool" ? answer(String(messages.at(-1)?.content)) : tool(name, args) });
    controller.submit("Try tool"); await until(() => !controller.snapshot().busy);
    assert.match(controller.snapshot().turns[0]!.answer!, /PERMISSION_DENIED/);
    await controller.close();
  }
  assert.equal(approvals, 0);
});

test("local HTTP boundary protects state and mutations and serves only built UI assets", async (t) => {
  const controller = await controllerFor(t, { maxIterations: 1, model: async () => answer() });
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
  for (const path of ["/", "/app.js", "/markdown.js", "/session-menu.js", "/session-dialog.js", "/styles.css", "/favicon.svg", "/icons.js", "/icons.svg", "/icons-LICENSE.txt"]) {
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
  const controller = await controllerFor(t, { maxIterations: 1, model: async (_messages, signal) => {
    await new Promise<void>((_resolve, reject) => signal!.addEventListener("abort", () => {
      cancelled = true; reject(new HarnessError("CANCELLED", "Run cancelled."));
    }, { once: true }));
    return answer();
  } });
  const server = await startWebUiServer(controller, 0); t.after(() => server.close());
  const token = new URLSearchParams(new URL(server.url).hash.slice(1)).get("token")!;
  const post = (path: string, body: unknown) => fetch(`${server.origin}/api/${path}`, { method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post("message", { prompt: "Wait" })).status, 202);
  assert.equal((await post("message", { prompt: "Second" })).status, 409);
  assert.equal((await post("reset", {})).status, 409);
  assert.equal((await post("session/new", {})).status, 409);
  assert.equal((await post("session/resume", { id: controller.snapshot().current.id })).status, 409);
  assert.equal((await post("session/rename", { name: "Busy" })).status, 409);
  assert.equal((await post("session/fork", {})).status, 409);
  assert.equal((await post("session/delete", { id: controller.snapshot().current.id })).status, 409);
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
  const { workspace, base } = await temporaryWorkspace(t);
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address(); assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  child = spawn(process.execPath, ["--import", new URL("./fixtures/webui-transport.js", import.meta.url).href,
    fileURLToPath(new URL("../src/cli.js", import.meta.url)), "--webui", "--port", String(port), "--permission", "read-only"], {
    cwd: workspace, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HARNESS_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "offline-webui-secret",
      DEEPSEEK_MODEL: "offline-model", HARNESS_MAX_ITERATIONS: "4", HARNESS_REQUEST_TIMEOUT_MS: "10000", HARNESS_MAX_REQUEST_BYTES: "262144",
      FATCAT_SESSION_DIR: join(base, "sessions"), FATCAT_WEBUI_OPEN_BROWSER: "0" },
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

test("Web UI saves, names, switches, forks and restores canonical history after restart", async (t) => {
  const { workspace, base } = await temporaryWorkspace(t);
  const store = new SessionStore({ root: join(base, "sessions") });
  const requests: Message[][] = [];
  const model: Model = async (messages) => {
    requests.push(structuredClone(messages));
    if (messages.at(-1)?.content === "Fail") throw new Error("PRIVATE_FAILURE");
    return answer(`Saved ${String(messages.at(-1)?.content)}`);
  };
  const options = { model, maxIterations: 2 };
  const manager = await SessionManager.open(options, { workspace, store });
  const controller = await WebUiController.create({ ...info, workspace }, manager);
  t.after(() => controller.close());
  controller.submit("Remember amber"); await until(() => !controller.snapshot().busy);
  const first = controller.snapshot().current.id;
  await controller.rename("Amber");
  assert.equal(controller.snapshot().current.name, "Amber");
  await controller.newSession("Another session");
  const second = controller.snapshot().current.id;
  assert.notEqual(second, first);
  assert.equal(controller.snapshot().turns.length, 0);
  controller.submit("Beta"); await until(() => !controller.snapshot().busy);
  await controller.resume(first);
  assert.equal(controller.snapshot().turns[0]?.prompt, "Remember amber");
  assert.equal(controller.snapshot().turns[0]?.answer, "Saved Remember amber");
  assert.equal(controller.snapshot().turns[0]?.report, undefined);
  assert.equal(controller.snapshot().approval, null);
  controller.submit("Recall"); await until(() => !controller.snapshot().busy);
  assert.ok(JSON.stringify(requests.at(-1)).includes("Remember amber"));
  assert.ok(!JSON.stringify(requests.at(-1)).includes('"content":"Beta"'));
  await controller.fork("Amber branch");
  const fork = controller.snapshot().current.id;
  assert.notEqual(fork, first);
  assert.equal(controller.snapshot().current.forkedFrom, first);
  assert.equal(controller.snapshot().turns.length, 2);
  controller.submit("Branch only"); await until(() => !controller.snapshot().busy);
  await controller.resume(first);
  assert.equal(controller.snapshot().turns.length, 2);
  assert.equal(controller.snapshot().sessions.length, 3);
  await controller.close();

  const reopened = await SessionManager.open(options, { workspace, store, selection: { resume: first } });
  const restored = await WebUiController.create({ ...info, workspace }, reopened);
  t.after(() => restored.close());
  assert.equal(restored.snapshot().current.name, "Amber");
  assert.equal(restored.snapshot().persistent, true);
  assert.deepEqual(restored.snapshot().turns.map((turn) => turn.prompt), ["Remember amber", "Recall"]);
  restored.submit("Fail"); await until(() => !restored.snapshot().busy);
  assert.equal(restored.snapshot().current.interrupted, true);
  assert.ok(!JSON.stringify(restored.snapshot()).includes("PRIVATE_FAILURE"));
  await restored.close();
  const failedReopen = await SessionManager.open(options, { workspace, store, selection: { resume: first } });
  const afterFailure = await WebUiController.create({ ...info, workspace }, failedReopen);
  t.after(() => afterFailure.close());
  assert.equal(afterFailure.snapshot().turns.length, 2);
  assert.equal(afterFailure.snapshot().current.interrupted, true);
  assert.equal(afterFailure.snapshot().approval, null);
  assert.ok(!JSON.stringify(failedReopen.history).includes('"content":"Fail"'));
});

test("session HTTP routes validate bodies and preserve old history when creating a chat", async (t) => {
  const { workspace, base } = await temporaryWorkspace(t);
  const manager = await SessionManager.open({ maxIterations: 1, model: async () => answer() }, {
    workspace, store: new SessionStore({ root: join(base, "sessions") }),
  });
  const controller = await WebUiController.create({ ...info, workspace }, manager);
  const server = await startWebUiServer(controller, 0);
  t.after(() => server.close());
  const token = new URLSearchParams(new URL(server.url).hash.slice(1)).get("token")!;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const post = (path: string, body: unknown) => fetch(`${server.origin}/api/${path}`, { method: "POST", headers, body: JSON.stringify(body) });
  for (const [path, body] of [["session/new", { permission: "allow" }], ["session/new", { name: 4 }],
    ["session/resume", {}], ["session/resume", { id: 4 }], ["session/resume", { id: "a", extra: true }],
    ["session/rename", { name: 4 }], ["session/rename", { id: 4, name: "Invalid" }],
    ["session/fork", { name: false }], ["session/fork", { id: "" }], ["session/delete", {}],
    ["session/delete", { id: 4 }], ["session/delete", { id: "" }], ["session/delete", { id: "a", revision: 0 }],
    ["session/delete", { id: "a", revision: "1" }], ["session/delete", { id: "a", extra: true }]] as const) {
    assert.equal((await post(path, body)).status, 400);
  }
  const first = controller.snapshot().current.id;
  assert.equal((await post("message", { prompt: "First session" })).status, 202);
  await until(() => !controller.snapshot().busy);
  assert.equal((await post("session/rename", { name: "First" })).status, 202);
  assert.equal((await post("session/new", { name: "Second" })).status, 202);
  assert.notEqual(controller.snapshot().current.id, first);
  assert.equal(controller.snapshot().turns.length, 0);
  assert.equal((await post("session/resume", { id: first })).status, 202);
  assert.equal(controller.snapshot().turns[0]?.prompt, "First session");
  assert.equal((await post("session/fork", { name: "Branch" })).status, 202);
  assert.equal(controller.snapshot().current.forkedFrom, first);
  assert.equal(controller.snapshot().turns.length, 1);
  assert.equal((await post("session/resume", { id: "../outside" })).status, 400);
  assert.equal(controller.snapshot().current.name, "Branch");
  const branch = controller.snapshot().current.id;
  const other = await SessionManager.open({ maxIterations: 1, model: async () => answer() }, {
    workspace, store: new SessionStore({ root: join(base, "sessions") }), selection: { resume: branch },
  });
  await other.rename("External rename");
  assert.equal((await post("session/rename", { name: "Stale rename" })).status, 409);
  assert.equal((await post("session/resume", { id: branch })).status, 202);
  assert.equal(controller.snapshot().current.name, "External rename");
});

test("session menu HTTP routes operate on selected sessions and reject stale deletion", async (t) => {
  const { workspace, base, outside } = await temporaryWorkspace(t);
  const store = new SessionStore({ root: join(base, "sessions") });
  let calls = 0;
  const agent = { maxIterations: 1, model: async () => { calls++; return answer(); } };
  const manager = await SessionManager.open(agent, { workspace, store });
  const controller = await WebUiController.create({ ...info, workspace }, manager);
  const server = await startWebUiServer(controller, 0);
  t.after(() => server.close());
  const token = new URLSearchParams(new URL(server.url).hash.slice(1)).get("token")!;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const post = (path: string, body: unknown, custom: Record<string, string> = headers) => fetch(`${server.origin}/api/${path}`, {
    method: "POST", headers: custom, body: JSON.stringify(body) });
  const source = controller.snapshot().current.id;
  controller.submit("Source history"); await until(() => !controller.snapshot().busy);
  await controller.newSession();
  const active = controller.snapshot().current.id;
  controller.submit("Active history"); await until(() => !controller.snapshot().busy);
  const activeTurns = controller.snapshot().turns;
  assert.equal((await post("session/rename", { id: source, name: "Selected source" })).status, 202);
  assert.equal(controller.snapshot().current.id, active);
  assert.deepEqual(controller.snapshot().turns, activeTurns);
  assert.equal((await store.load(workspace, source)).name, "Selected source");
  assert.equal((await post("session/fork", { id: source, name: "Source branch" })).status, 202);
  const fork = controller.snapshot().current.id;
  assert.equal(controller.snapshot().current.forkedFrom, source);
  assert.deepEqual(controller.snapshot().turns.map((turn) => turn.prompt), ["Source history"]);
  const forkTurns = controller.snapshot().turns;
  assert.equal((await post("session/delete", { id: active })).status, 202);
  assert.equal(controller.snapshot().current.id, fork);
  assert.deepEqual(controller.snapshot().turns, forkTurns);
  const revision = controller.snapshot().current.revision;
  assert.equal((await post("session/delete", { id: fork, revision })).status, 202);
  const fresh = controller.snapshot().current.id;
  assert.notEqual(fresh, fork);
  assert.equal(controller.snapshot().turns.length, 0);
  assert.equal(controller.snapshot().current.turnCount, 0);
  assert.deepEqual(controller.snapshot().sessions.map((item) => item.id).sort(), [source, fresh].sort());
  assert.equal((await post("session/delete", { id: source }, { ...headers, Authorization: "Bearer wrong" })).status, 401);
  assert.equal((await post("session/delete", { id: source }, { ...headers, Origin: "https://example.com" })).status, 403);
  const foreign = await SessionManager.open(agent, { workspace: outside, store });
  assert.equal((await post("session/delete", { id: foreign.current.id })).status, 400);
  assert.equal((await post("session/delete", { id: "../outside" })).status, 400);
  const sourceRevision = controller.snapshot().sessions.find((item) => item.id === source)!.revision;
  const other = await SessionManager.open(agent, { workspace, store, selection: { resume: source } });
  await other.rename("Changed outside browser");
  assert.equal((await post("session/delete", { id: source, revision: sourceRevision })).status, 409);
  const refreshed = await (await fetch(`${server.origin}/api/state`, { headers })).json() as WebUiState;
  const changedSource = refreshed.sessions.find((item) => item.id === source)!;
  assert.ok(changedSource.revision > sourceRevision);
  assert.equal(changedSource.name, "Changed outside browser");
  assert.equal(controller.snapshot().current.id, fresh);
  assert.equal((await store.load(workspace, source)).name, "Changed outside browser");
  assert.equal((await post("session/delete", { id: source, revision: changedSource.revision })).status, 202);
  assert.equal(controller.snapshot().current.id, fresh);
  controller.submit("Active retry history"); await until(() => !controller.snapshot().busy);
  const beforeConflict = controller.snapshot();
  const externalActive = await SessionManager.open(agent, { workspace, store, selection: { resume: fresh } });
  await externalActive.rename("Externally updated active session");
  assert.equal((await post("session/delete", { id: fresh, revision: beforeConflict.current.revision })).status, 409);
  const afterConflict = await (await fetch(`${server.origin}/api/state`, { headers })).json() as WebUiState;
  assert.deepEqual(afterConflict.turns, beforeConflict.turns);
  assert.deepEqual(afterConflict.current, beforeConflict.current);
  assert.equal(afterConflict.approval, null);
  const changedActive = afterConflict.sessions.find((item) => item.id === fresh)!;
  assert.ok(changedActive.revision > beforeConflict.current.revision);
  assert.equal(changedActive.name, "Externally updated active session");
  assert.equal((await post("session/delete", { id: fresh, revision: changedActive.revision })).status, 202);
  assert.notEqual(controller.snapshot().current.id, fresh);
  assert.equal(controller.snapshot().turns.length, 0);
  assert.equal(controller.snapshot().sessions.length, 1);
  assert.equal((await store.list(outside)).length, 1);
  assert.equal(calls, 3);
});
