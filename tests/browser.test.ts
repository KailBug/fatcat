import assert from "node:assert/strict";
import { link, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createTools } from "../src/tools.js";
import type { ToolResult } from "../src/tools.js";
import { PermissionPolicy } from "../src/permissions/policy.js";
import { createWorkspace } from "../src/permissions/workspace.js";
import { readBrowserFile } from "../src/permissions/browser.js";
import { parseBrowserRequest } from "../src/browser/protocol.js";
import type { BrowserRun } from "../src/browser/runtime.js";
import { readBrowserEvidence, saveBrowserEvidence } from "../src/browser/evidence.js";
import { createTurnReporter } from "../src/execution-report.js";
import type { ExecutionReport } from "../src/execution-report.js";
import { runAgent } from "../src/loop.js";
import { createSubagentTools } from "../src/subagent.js";
import { HarnessError } from "../src/errors.js";
import { temporaryWorkspace } from "./fixtures/workspace.js";

const simulated: BrowserRun = { status: "completed", completedSteps: 0, diagnostics: [], diagnosticsTruncated: false,
  sources: [], snapshot: { title: "Offline fixture", text: "Ready" }, png: Buffer.from("offline-png-fixture") };
function result(value: ToolResult): Record<string, unknown> {
  assert.ok(value.ok, JSON.stringify(value));
  return value.result as Record<string, unknown>;
}

test("browser protocol rejects arbitrary code, URLs, excess steps, invalid keys and oversized viewports", () => {
  assert.equal(parseBrowserRequest({ path: "demo.html" }).screenshot, true);
  for (const input of [{ path: "https://example.com" }, { path: "demo.html", code: "process.exit()" },
    { path: "demo.html", steps: [{ action: "evaluate", value: "alert(1)" }] },
    { path: "demo.html", steps: Array.from({ length: 13 }, () => ({ action: "click", selector: "button" })) },
    { path: "demo.html", steps: [{ action: "press", selector: "input", value: "Control+O" }] },
    { path: "demo.html", steps: [{ action: "click", selector: "button", value: "unused" }] },
    { path: "demo.html", steps: [{ action: "wait", milliseconds: 2001 }] },
    { path: "demo.html", steps: Array.from({ length: 3 }, () => ({ action: "wait", milliseconds: 2000 })) },
    { path: "demo.html", viewport: { width: 10000, height: 800 } }, { path: "demo.html", screenshot: "true" }]) {
    assert.throws(() => parseBrowserRequest(input), /workspace HTML/);
  }
});

test("browser is opt-in for programmatic callers, requires approval and shares mode locks", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await writeFile(join(workspace, "demo.html"), "<h1>Ready</h1>");
  assert.ok(!(await createTools(workspace)).definitions.some((item) => item.function.name === "browser"));
  const policy = new PermissionPolicy("default");
  let launches = 0; let allowed = false; let approvals = 0;
  const tools = await createTools(workspace, "ask", undefined, { permission: "ask" }, undefined, policy, {
    approve: async (request) => { approvals++; assert.equal(request.path, "demo.html");
      assert.throws(() => policy.select("freeToGo"), /active tool/); return allowed; },
    runner: async () => { launches++; return simulated; },
  });
  let response = await tools.execute("browser", JSON.stringify({ path: "demo.html" }));
  assert.ok(!response.ok && response.error.code === "PERMISSION_DENIED");
  assert.equal(launches, 0); assert.equal(tools.getBrowserChecks!().length, 0);
  allowed = true;
  const data = result(await tools.execute("browser", JSON.stringify({ path: "demo.html" })));
  assert.equal(launches, 1); assert.equal(approvals, 2);
  assert.equal(await readFile(join(workspace, String(data.screenshotPath)), "utf8"), "offline-png-fixture");
  const saved = JSON.parse(await readFile(join(workspace, String(data.reportPath)), "utf8"));
  assert.equal(saved.screenshotPath, data.screenshotPath);
  assert.equal(data.visualVerification, "not_performed");
  policy.select("plan");
  response = await tools.execute("browser", JSON.stringify({ path: "demo.html" }));
  assert.ok(!response.ok && response.error.code === "PERMISSION_DENIED");
  policy.select("acceptEdits");
  const textOnly = result(await tools.execute("browser", JSON.stringify({ path: "demo.html", screenshot: false })));
  assert.equal(textOnly.screenshotPath, null);
  assert.equal(approvals, 3);
  policy.select("freeToGo");
  result(await tools.execute("browser", JSON.stringify({ path: "demo.html" })));
  assert.equal(approvals, 3);
});

test("browser cannot elevate read-only or shell-deny, and Free to go cannot escape the workspace", async (t) => {
  const { workspace, outside } = await temporaryWorkspace(t);
  await writeFile(join(workspace, "demo.html"), "<h1>Ready</h1>");
  await writeFile(join(outside, "private.html"), "PRIVATE");
  let launches = 0;
  for (const policy of [new PermissionPolicy("plan"), new PermissionPolicy({ permission: "workspace-write", shellPermission: "deny" })]) {
    const tools = await createTools(workspace, "workspace-write", undefined, {}, undefined, policy, { approve: async () => true,
      runner: async () => { launches++; return simulated; } });
    const response = await tools.execute("browser", JSON.stringify({ path: "demo.html" }));
    assert.ok(!response.ok && response.error.code === "PERMISSION_DENIED");
  }
  const tools = await createTools(workspace, "workspace-write", undefined, {}, undefined, new PermissionPolicy("freeToGo"), {
    runner: async () => { launches++; return simulated; },
  });
  for (const path of [join(outside, "private.html"), "../outside/private.html", "https://example.com/page.html"]) {
    assert.equal((await tools.execute("browser", JSON.stringify({ path }))).ok, false);
  }
  assert.equal(launches, 0);
});

test("browser asset reader rejects hidden, linked, invalid text and oversized resources", async (t) => {
  const { workspace, outside } = await temporaryWorkspace(t);
  const scope = await createWorkspace(workspace);
  await writeFile(join(workspace, "index.html"), "<p>Hello</p>");
  await writeFile(join(workspace, "invalid.js"), Buffer.from([0xff]));
  await writeFile(join(workspace, ".private.html"), "PRIVATE");
  await writeFile(join(outside, "private.html"), "PRIVATE");
  await link(join(outside, "private.html"), join(workspace, "linked.html"));
  await symlink(outside, join(workspace, "linked"), process.platform === "win32" ? "junction" : "dir");
  const asset = await readBrowserFile(scope, "index.html");
  assert.equal(asset.bytes.toString(), "<p>Hello</p>"); assert.match(asset.sha256, /^[a-f0-9]{64}$/);
  for (const path of [".private.html", "../outside/private.html", "linked.html", "linked/private.html", "invalid.js"]) {
    await assert.rejects(readBrowserFile(scope, path));
  }
  await assert.rejects(readBrowserFile(scope, "index.html", undefined, 2), /byte limit/);
  await assert.rejects(readBrowserFile(scope, "index.html", AbortSignal.abort()), /cancelled/);
});

test("browser cancellation releases permission lock, rejects overlap and records cancellation without replay", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await writeFile(join(workspace, "demo.html"), "<h1>Ready</h1>");
  const policy = new PermissionPolicy("freeToGo");
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const tools = await createTools(workspace, "workspace-write", undefined, {}, undefined, policy, {
    runner: async (_request, _workspace, signal) => {
      started();
      await new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new HarnessError("CANCELLED", "Run cancelled.")), { once: true }));
      return simulated;
    },
  });
  const abort = new AbortController();
  const pending = tools.execute("browser", JSON.stringify({ path: "demo.html" }), abort.signal);
  await ready;
  const overlap = await tools.execute("browser", JSON.stringify({ path: "demo.html" }));
  assert.ok(!overlap.ok && overlap.error.code === "BROWSER_BUSY");
  abort.abort(); await assert.rejects(pending, /cancelled/);
  assert.equal(tools.getBrowserChecks!()[0]?.status, "cancelled");
  assert.equal(tools.getBrowserChecks!()[0]?.reportPath, null);
  policy.select("plan");
});

test("browser evidence cannot overwrite files or follow an evidence directory junction", async (t) => {
  const { workspace, outside } = await temporaryWorkspace(t);
  const id = "a".repeat(32);
  await saveBrowserEvidence(workspace, id, { text: "<script>untrusted</script>" }, Buffer.from("png"));
  await assert.rejects(saveBrowserEvidence(workspace, id, { text: "overwrite" }, Buffer.from("changed")));
  assert.equal((await readBrowserEvidence(workspace, id, "screenshot")).bytes.toString(), "png");
  await assert.rejects(readBrowserEvidence(workspace, "../private", "report"), /Invalid evidence/);
  const isolated = join(outside, "another"); await mkdir(isolated);
  await symlink(join(workspace, "fatcat-browser-evidence"), join(isolated, "fatcat-browser-evidence"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(saveBrowserEvidence(isolated, "b".repeat(32), {}));
});

test("browser records survive failed model turns and child journal duplicates are not counted twice", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await writeFile(join(workspace, "demo.html"), "<h1>Ready</h1>");
  const tools = await createTools(workspace, "workspace-write", undefined, { permission: "allow" }, undefined, undefined, { runner: async () => simulated });
  let calls = 0; let report: ExecutionReport | undefined;
  const model = async () => {
    if (++calls === 1) {
      const call = { id: "browser-call", type: "function" as const, function: { name: "browser", arguments: '{"path":"demo.html"}' } };
      return { message: { role: "assistant" as const, content: null, tool_calls: [call] }, toolCalls: [call] };
    }
    throw new Error("Injected model failure");
  };
  const delegated = createSubagentTools(tools, model, 3);
  await assert.rejects(runAgent("Check the page", { model, tools: delegated, maxIterations: 3,
    onEvent: createTurnReporter((event) => { if (event.type === "execution_report") report = event.report; }) }));
  assert.equal(report?.browserChecks?.length, 1);
  assert.equal(report?.browserChecks?.[0]?.status, "completed");
  const entry = tools.getBrowserChecks!()[0]!;
  const observe = createTurnReporter((event) => { if (event.type === "execution_report") report = event.report; });
  observe({ type: "subagent_event", callId: "child", event: { type: "browser_record", record: entry } });
  observe({ type: "browser_record", record: entry });
  observe({ type: "write_record", record: { id: "write", path: "demo.html", operation: "edit", status: "committed", beforeHash: "a", afterHash: "b", bytes: 1 } });
  observe({ type: "completed", iterations: 1 });
  assert.equal(report?.browserChecks?.length, 1);
  assert.equal(report?.browserChecks?.[0]?.laterWriteAttempt, true);
});
