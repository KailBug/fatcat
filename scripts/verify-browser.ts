import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createTools } from "../src/tools.js";
import { runAgent } from "../src/loop.js";
import type { Model, ModelTurn } from "../src/model.js";
import { createTurnReporter } from "../src/execution-report.js";
import type { ExecutionReport } from "../src/execution-report.js";
import { HarnessError } from "../src/errors.js";

// Explicit real-browser validation; all agent decisions are injected, with no model credentials or requests.
const workspace = await mkdtemp(join(tmpdir(), "fatcat-browser-verify-"));
let networkHits = 0;
const network = createServer((_request, response) => { networkHits++; response.end("Unexpected external request"); });
await new Promise<void>((resolve) => network.listen(0, "127.0.0.1", resolve));
const address = network.address(); assert.ok(address && typeof address !== "string");
try {
  await writeFile(join(workspace, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><title>Browser verification</title><link rel="stylesheet" href="style.css"></head><body>
    <h1>Browser verification</h1><input id="name"><select id="tone"><option value="hello">Hello</option><option value="welcome">Welcome</option></select>
    <button id="greet">Greet</button><p id="greeting">Waiting</p><svg viewBox="0 0 200 100"><circle id="shape" cx="60" cy="50" r="20"/></svg>
    <script src="app.js"></script></body></html>`);
  await writeFile(join(workspace, "style.css"), "body {font-family:system-ui;margin:32px} svg {width:200px;height:100px} circle {fill:seagreen}");
  await writeFile(join(workspace, "app.js"), "document.querySelector('#greet').onclick = () => { document.querySelector('#greeting').textContent = document.querySelector('#tone').selectedOptions[0].text + ', ' + missingName.value; };");
  const request = { path: "index.html", steps: [{ action: "fill", selector: "#name", value: "Ada" },
    { action: "select", selector: "#tone", value: "welcome" }, { action: "click", selector: "#greet" }],
    selectors: ["#greeting", "#shape"], viewport: { width: 800, height: 600 } };
  const tools = await createTools(workspace, "workspace-write", undefined, { permission: "allow" }, undefined, undefined, {});
  let phase = 0;
  const observations: Record<string, any>[] = [];
  function call(name: string, args: unknown): ModelTurn {
    const tool = { id: `fixture-${phase}`, type: "function" as const, function: { name, arguments: JSON.stringify(args) } };
    return { message: { role: "assistant", content: null, tool_calls: [tool] }, toolCalls: [tool] };
  }
  const model: Model = async (messages) => {
    phase++;
    const last = messages.at(-1);
    if (last?.role === "tool") {
      const data = JSON.parse(String(last.content));
      assert.ok(data.ok, String(last.content));
      if (data.result.kind === "browser") observations.push(data.result);
    }
    if (phase === 1) return call("browser", request);
    if (phase === 2) {
      assert.ok(observations[0]!.diagnostics.some((item: { kind: string }) => item.kind === "pageerror"));
      return call("read", { path: "app.js" });
    }
    if (phase === 3) return call("write", { path: "app.js", oldText: "missingName.value", newText: "document.querySelector('#name').value" });
    if (phase === 4) return call("browser", request);
    assert.equal(observations[1]!.status, "completed");
    assert.equal(observations[1]!.completedSteps, 3);
    assert.equal(observations[1]!.diagnostics.filter((item: { kind: string }) => item.kind === "pageerror").length, 0);
    assert.ok(observations[1]!.snapshot.text.includes("Welcome, Ada"));
    return { message: { role: "assistant", content: "The injected repair scenario passed its DOM and runtime assertions. Screenshots are saved for user review." }, toolCalls: [] };
  };
  let report: ExecutionReport | undefined;
  await runAgent("Verify and repair the fixture", { model, tools, maxIterations: 6,
    onEvent: createTurnReporter((event) => { if (event.type === "execution_report") report = event.report; }) });
  assert.equal(report?.browserChecks?.length, 2);
  assert.equal(report?.browserChecks?.[0]?.laterWriteAttempt, true);
  assert.equal(report?.browserChecks?.[1]?.laterWriteAttempt, false);
  const before = observations[0]!, after = observations[1]!;
  assert.notEqual(before.sources.find((item: { path: string }) => item.path === "app.js").sha256,
    after.sources.find((item: { path: string }) => item.path === "app.js").sha256);
  assert.equal(after.snapshot.elements.find((item: { selector: string }) => item.selector === "#shape").svg.box.width, 40);
  for (const observation of observations) {
    const png = await readFile(join(workspace, observation.screenshotPath));
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    const saved = JSON.parse(await readFile(join(workspace, observation.reportPath), "utf8"));
    assert.equal(saved.id, observation.id); assert.equal(saved.visualVerification, "not_performed");
    assert.ok(saved.sources.some((asset: { path: string }) => asset.path === "style.css"));
  }
  await writeFile(join(workspace, "network.html"), `<h1>Boundary probe</h1><script>
    fetch('http://127.0.0.1:${address.port}/probe').catch(()=>{});
    try { new WebSocket('ws://127.0.0.1:${address.port}/probe') } catch {}
    document.body.dataset.rtc = typeof RTCPeerConnection;
    window.open('http://127.0.0.1:${address.port}/popup');
    </script>`);
  const boundary = await tools.execute("browser", JSON.stringify({ path: "network.html", steps: [{ action: "wait", milliseconds: 100 }], screenshot: false }));
  assert.ok(boundary.ok, JSON.stringify(boundary));
  assert.equal(networkHits, 0);
  assert.ok(JSON.stringify(boundary).includes("blocked") || JSON.stringify(boundary).includes("Content Security Policy"));
  await writeFile(join(workspace, "motion.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><circle id="circle" cy="50" r="10"><animate attributeName="cx" values="20;180;20" dur="2s" repeatCount="indefinite"/></circle></svg>');
  const svg = await tools.execute("browser", JSON.stringify({ path: "motion.svg", selectors: ["#circle"], steps: [{ action: "wait", milliseconds: 200 }] }));
  assert.ok(svg.ok, JSON.stringify(svg));
  const failedStep = await tools.execute("browser", JSON.stringify({ path: "index.html", steps: [{ action: "click", selector: "#missing" }] }));
  assert.ok(failedStep.ok, JSON.stringify(failedStep));
  assert.equal((failedStep.result as Record<string, unknown>).status, "failed");
  const cancelled = new AbortController();
  const pending = tools.execute("browser", JSON.stringify({ path: "index.html", steps: [{ action: "wait", milliseconds: 2000 }] }), cancelled.signal);
  const timer = setTimeout(() => cancelled.abort(), 500);
  try { await assert.rejects(pending, (error: unknown) => error instanceof HarnessError && error.code === "CANCELLED"); }
  finally { clearTimeout(timer); }
  assert.equal(tools.getBrowserChecks!().at(-1)?.status, "cancelled");
  console.log("Browser verification passed: real local assets, fill/select/click, runtime-error repair loop, source hashes, SVG geometry, JSON/PNG evidence, network/popup boundary, failed step and cancellation. Model decisions were injected; no real model API was used.");
} finally {
  await new Promise<void>((resolve) => network.close(() => resolve()));
  const target = resolve(workspace);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("fatcat-browser-verify-")) throw new Error("Unexpected verification directory.");
  await rm(target, { recursive: true, force: true });
}
