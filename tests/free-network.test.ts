import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { PermissionPolicy } from "../src/permissions/policy.js";
import { createWebTool } from "../src/tools/web.js";
import type { ToolResult } from "../src/tools.js";

function failure(value: ToolResult, code: string): void {
  assert.equal(value.ok, false, JSON.stringify(value));
  if (!value.ok) assert.equal(value.error.code, code);
}

test("broader network scope reaches an actual loopback custom-port page and restores the public boundary", async (t) => {
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (request.url === "/redirect") { response.writeHead(302, { Location: "/page" }); response.end(); }
    else response.end('<title>Local fixture</title><p>LOCAL_NETWORK_FIXTURE</p><a href="/source">Source</a>');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/redirect`;
  const policy = new PermissionPolicy("default");
  const tool = createWebTool({ permission: "allow" }, policy);
  failure(await tool.execute({ action: "fetch", url }), "WEB_URL_NOT_ALLOWED");
  assert.equal(requests, 0);
  policy.select("freeToGo");
  const page = await tool.execute({ action: "fetch", url });
  assert.ok(page.ok, JSON.stringify(page));
  const result = page.result as { content: string; links: { title: string; url: string }[] };
  assert.match(result.content, /LOCAL_NETWORK_FIXTURE/);
  assert.deepEqual(result.links, [{ title: "Source", url: `http://127.0.0.1:${address.port}/source` }]);
  assert.equal(requests, 2);
  policy.select("default");
  failure(await tool.execute({ action: "fetch", url }), "WEB_URL_NOT_ALLOWED");
  assert.equal(requests, 2);
});

test("broader network scope pins private DNS, revalidates redirects and still rejects malformed URLs and IP answers", async () => {
  const policy = new PermissionPolicy("freeToGo");
  const urls: string[] = [];
  const tool = createWebTool({ permission: "allow", resolver: async () => [{ address: "10.0.0.8", family: 4 }],
    transport: async (url, address) => {
      urls.push(url.href);
      assert.equal(address.address, "10.0.0.8");
      if (urls.length === 1) return new Response(null, { status: 302, headers: { location: "http://fixture.local:4567/page" } });
      return new Response("PRIVATE_DNS_FIXTURE", { headers: { "content-type": "text/plain" } });
    } }, policy);
  assert.equal((await tool.execute({ action: "fetch", url: "https://fixture.local/page" })).ok, true);
  assert.deepEqual(urls, ["https://fixture.local/page", "http://fixture.local:4567/page"]);
  for (const url of ["file:///C:/fixture.txt", "data:text/plain,fixture", "http://user:password@fixture.local/", "http://fixture.local/\n"]) {
    failure(await tool.execute({ action: "fetch", url }), "WEB_URL_NOT_ALLOWED");
  }
  assert.equal(urls.length, 2);
  const malformed = createWebTool({ permission: "allow", resolver: async () => [{ address: "not-an-ip", family: 4 }],
    transport: async () => { throw new Error("Must not launch with invalid DNS."); } }, policy);
  failure(await malformed.execute({ action: "fetch", url: "http://fixture.local/" }), "WEB_URL_NOT_ALLOWED");
  const denied = createWebTool({ permission: "deny", transport: async () => { throw new Error("Deny must precede the transport."); } }, policy);
  failure(await denied.execute({ action: "fetch", url: "http://localhost:4321/" }), "PERMISSION_DENIED");
});

test("in-flight network access holds the policy until cancellation and retains deadline limits", async () => {
  const policy = new PermissionPolicy("freeToGo");
  let started = false;
  const tool = createWebTool({ permission: "allow", transport: async () => {
    started = true;
    return new Promise<Response>(() => {});
  }, timeoutMs: 1000 }, policy);
  const abort = new AbortController();
  const request = Promise.resolve(tool.execute({ action: "fetch", url: "http://127.0.0.1:4567/" }, abort.signal));
  while (!started) await delay(1);
  assert.throws(() => policy.select("default"), /active tool operation/);
  abort.abort();
  await assert.rejects(request, { code: "CANCELLED" });
  policy.select("default");
  const deadline = createWebTool({ permission: "allow", transport: async () => new Promise<Response>(() => {}), timeoutMs: 10 },
    new PermissionPolicy("freeToGo"));
  failure(await deadline.execute({ action: "fetch", url: "http://127.0.0.1:4567/" }), "WEB_TIMEOUT");
});
