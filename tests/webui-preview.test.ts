import assert from "node:assert/strict";
import { link, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { SessionManager } from "../src/session/manager.js";
import { PermissionPolicy } from "../src/permissions/policy.js";
import { WebUiController } from "../webui/controller.js";
import { createPreviewStore } from "../webui/preview.js";
import { startWebUiServer } from "../webui/server.js";
import { temporaryWorkspace } from "./fixtures/workspace.js";

async function fixture(t: TestContext) {
  const folders = await temporaryWorkspace(t);
  const manager = await SessionManager.open({ maxIterations: 1, model: async () => {
    throw new Error("Preview must not request a model.");
  } }, { workspace: folders.workspace, persistence: false });
  const controller = await WebUiController.create({ provider: "deepseek", model: "offline", workspace: folders.workspace,
    permission: "read-only", shellPermission: "deny", webPermission: "deny", maxIterations: 1,
    maxRequestBytes: 262144, skills: 0, warnings: [] }, manager);
  const server = await startWebUiServer(controller, 0);
  t.after(() => server.close());
  const token = new URLSearchParams(new URL(server.url).hash.slice(1)).get("token")!;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const post = (body: unknown, override = headers) => fetch(`${server.origin}/api/preview`, {
    method: "POST", headers: override, body: JSON.stringify(body),
  });
  return { ...folders, controller, server, headers, post, token };
}

test("preview requires authentication, publishes isolated single-use snapshots and refreshes from disk without changing sessions", async (t) => {
  const { workspace, controller, server, headers, post, token } = await fixture(t);
  await mkdir(join(workspace, "art"));
  const path = "art/animation.html";
  const first = '<!doctype html><h1>First</h1><script>document.body.dataset.running="yes"</script>';
  await writeFile(join(workspace, path), first);
  const before = controller.snapshot();
  assert.equal((await fetch(`${server.origin}/api/preview`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) })).status, 401);
  assert.equal((await post({ path }, { ...headers, Origin: "null" } as typeof headers)).status, 403);
  assert.equal((await post({ path }, { ...headers, Origin: "https://example.com" } as typeof headers)).status, 403);
  for (const invalid of [{}, { path: 1 }, { path, token }, { path: " " }, { path: "x".repeat(1025) + ".html" }]) {
    assert.equal((await post(invalid)).status, 400);
  }
  const prepared = await post({ path });
  assert.equal(prepared.status, 200);
  const snapshot = await prepared.json() as { path: string; url: string; bytes: number };
  assert.equal(snapshot.path, path);
  assert.equal(snapshot.bytes, Buffer.byteLength(first));
  assert.match(snapshot.url, /^\/preview\/[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(snapshot).includes(token));
  await writeFile(join(workspace, path), "<h1>Updated</h1>");
  const rendered = await fetch(server.origin + snapshot.url);
  assert.equal(rendered.status, 200);
  assert.equal(await rendered.text(), first);
  assert.equal(rendered.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(rendered.headers.get("cache-control"), "no-store");
  assert.equal(rendered.headers.get("referrer-policy"), "no-referrer");
  assert.equal(rendered.headers.get("x-content-type-options"), "nosniff");
  const csp = rendered.headers.get("content-security-policy")!;
  assert.match(csp, /sandbox allow-scripts/);
  assert.doesNotMatch(csp, /allow-same-origin|allow-popups|allow-forms|unsafe-eval/);
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /base-uri 'none'; form-action 'none'/);
  assert.match(csp, /script-src 'unsafe-inline'/);
  assert.ok(csp.includes(`frame-ancestors ${server.origin}`));
  assert.equal(rendered.headers.get("access-control-allow-origin"), null);
  assert.equal((await fetch(server.origin + snapshot.url)).status, 404);
  const refreshed = await (await post({ path })).json() as { url: string };
  assert.notEqual(refreshed.url, snapshot.url);
  assert.equal(await (await fetch(server.origin + refreshed.url)).text(), "<h1>Updated</h1>");
  const parent = await fetch(server.origin);
  assert.ok(parent.headers.get("content-security-policy")!.includes(`frame-src ${server.origin}/preview/`));
  assert.deepEqual(controller.snapshot(), before);
});

test("preview handles SVG and HTML extensions, rejects inaccessible paths, links, invalid encoding and oversized files", async (t) => {
  const { workspace, outside, post, server } = await fixture(t);
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><circle r="4"><animate attributeName="cx" values="0;90;0" dur="2s" repeatCount="indefinite"/></circle></svg>';
  await writeFile(join(workspace, "drawing.SVG"), svg);
  const metadata = await (await post({ path: "drawing.SVG" })).json() as { url: string };
  const rendered = await fetch(server.origin + metadata.url);
  assert.equal(rendered.headers.get("content-type"), "image/svg+xml; charset=utf-8");
  assert.equal(await rendered.text(), svg);
  await mkdir(join(workspace, "nested"));
  await writeFile(join(workspace, "nested", "sample page.htm"), "<p>Local</p>");
  assert.equal((await post({ path: "nested\\sample page.htm" })).status, 200);
  await writeFile(join(outside, "private.html"), "PRIVATE");
  await writeFile(join(workspace, ".hidden.html"), "PRIVATE");
  await mkdir(join(workspace, "node_modules"));
  await writeFile(join(workspace, "node_modules", "private.html"), "PRIVATE");
  await writeFile(join(workspace, "binary.html"), Buffer.from([0xff, 0x00]));
  await writeFile(join(workspace, "large.html"), "x".repeat(1024 * 1024 + 1));
  await mkdir(join(workspace, "folder.html"));
  await link(join(outside, "private.html"), join(workspace, "hardlink.html"));
  await symlink(outside, join(workspace, "linked"), process.platform === "win32" ? "junction" : "dir");
  for (const path of ["../outside/private.html", "nested/../../outside/private.html", join(outside, "private.html"),
    "C:\\private.html", ".hidden.html", "node_modules/private.html", "missing.html", "binary.html", "large.html",
    "folder.html", "hardlink.html", "linked/private.html", "file.txt", "nested/sample page.htm:stream.html", "%2e%2e/outside/private.html"]) {
    const response = await post({ path });
    assert.equal(response.status, 400, path);
    assert.ok(!(await response.text()).includes("PRIVATE"));
  }
  assert.equal((await fetch(server.origin + "/preview/drawing.SVG")).status, 404);
});

test("preview snapshots expire, remain bounded and are removed on shutdown", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await writeFile(join(workspace, "page.html"), "<h1>Preview</h1>");
  const store = await createPreviewStore(workspace);
  const initial = await store.prepare("page.html");
  for (let i = 0; i < 8; i++) await store.prepare("page.html");
  assert.equal(store.take(initial.url.slice("/preview/".length)), undefined);
  const expiring = await store.prepare("page.html");
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  t.mock.timers.tick(60_001);
  assert.equal(store.take(expiring.url.slice("/preview/".length)), undefined);
  const pending = await store.prepare("page.html");
  store.close();
  assert.equal(store.take(pending.url.slice("/preview/".length)), undefined);
  await assert.rejects(store.prepare("page.html"), /shutting down/);
});

test("preview cancellation and Free to go never extend its workspace boundary", async (t) => {
  const { workspace, outside } = await temporaryWorkspace(t);
  await writeFile(join(workspace, "page.html"), "<h1>Preview</h1>");
  await writeFile(join(outside, "private.html"), "PRIVATE");
  const store = await createPreviewStore(workspace);
  await assert.rejects(store.prepare("page.html", AbortSignal.abort()), /cancelled/);
  const manager = await SessionManager.open({ maxIterations: 1, model: async () => { throw new Error("Unexpected model request"); } }, { workspace, persistence: false });
  const policy = new PermissionPolicy("freeToGo");
  const controller = await WebUiController.create({ provider: "deepseek", model: "offline", workspace,
    permission: "workspace-write", shellPermission: "allow", webPermission: "allow", maxIterations: 1,
    maxRequestBytes: 262144, skills: 0, warnings: [] }, manager, policy);
  const server = await startWebUiServer(controller, 0);
  t.after(() => server.close());
  const token = new URLSearchParams(new URL(server.url).hash.slice(1)).get("token")!;
  const response = await fetch(server.origin + "/api/preview", { method: "POST", headers: {
    Authorization: `Bearer ${token}`, "Content-Type": "application/json",
  }, body: JSON.stringify({ path: join(outside, "private.html") }) });
  assert.equal(response.status, 400);
});
