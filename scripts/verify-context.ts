import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createAgent } from "../src/agent.js";
import { loadLiveConfig } from "./fixtures/live-config.js";
import { createTurnReporter } from "../src/execution-report.js";
import type { ExecutionReport } from "../src/execution-report.js";
import { Session } from "../src/session/session.js";
import { createTools } from "../src/tools.js";
import type { Tools } from "../src/tools.js";

const workspace = await mkdtemp(join(tmpdir(), "fatcat-context-"));
const oldText = "CURRENT_MARKER=AMBER-17\n" + "x".repeat(12000);
const newText = "CURRENT_MARKER=INDIGO-83\n" + "x".repeat(12000);
let phase = 1;
try {
  await writeFile(join(workspace, "notes.txt"), oldText);
  const base = await createTools(workspace);
  let loaded = false;
  let reread = false;
  const tools: Tools = { ...base, async execute(...args) {
    const result = await base.execute(...args);
    if (args[0] === "read" && result.ok) {
      const value = result.result as { kind?: string; path?: string; content?: string };
      if (value.kind === "file" && value.path === "notes.txt") {
        if (phase === 1 && value.content === oldText) loaded = true;
        if (phase === 3 && value.content?.includes("CURRENT_MARKER=INDIGO-83")) reread = true;
      }
    }
    return result;
  } };
  const config = loadLiveConfig();
  // The smaller local budget deliberately exercises projection using only synthetic data.
  const session = new Session(createAgent({ ...config, maxRequestBytes: 26000,
    maxIterations: Math.min(config.maxIterations, 3) }, tools));
  const reports: ExecutionReport[] = [];
  async function run(prompt: string) {
    return session.run(prompt, { onEvent: createTurnReporter((event) => {
      if (event.type === "execution_report") reports.push(event.report);
      console.error(JSON.stringify({ scenario: "context", phase, ...event }));
    }) });
  }
  const first = await run("Handle this small read-only check directly. Read all of notes.txt using read, then reply only LOADED. Do not quote its contents.");
  assert.equal(first.trim(), "LOADED");
  assert.ok(loaded);
  phase = 2;
  assert.equal((await run("For the next check, use the answer prefix RESULT:. For now reply only READY; no tools are needed.")).trim(), "READY");
  await writeFile(join(workspace, "notes.txt"), newText);
  phase = 3;
  const answer = await run("Handle this small check directly. Read exactly the first line of notes.txt with read limit 1 and report its current marker value using the requested prefix. Do not infer current contents from earlier history. The rest is irrelevant synthetic load-test padding: " + "padding ".repeat(875));
  assert.ok(reread, "The current marker must come from a fresh tool read.");
  assert.match(answer.trim(), /^RESULT:/);
  assert.match(answer, /INDIGO-83/);
  assert.ok(!answer.includes("AMBER-17"));
  assert.equal(reports.length, 3);
  assert.equal(reports[0]!.contextReduction.parent.requests, 0);
  assert.equal(reports[1]!.contextReduction.parent.requests, 0);
  assert.ok(reports[2]!.contextReduction.parent.requests > 0);
  for (const report of reports) {
    assert.equal(report.outcome, "answered");
    assert.equal(report.requestBytes.parent.rejected, 0);
    assert.ok(report.requestBytes.parent.maxBytes! <= 26000);
    assert.equal(report.requestBytes.children.rejected, 0);
  }
  assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), newText);
  assert.deepEqual(base.getWrites!(), []);
  assert.deepEqual(base.getCommands!(), []);
  const requests = reports.reduce((sum, report) => sum + report.modelRequests.parent + report.modelRequests.children, 0);
  console.log(JSON.stringify({ scenario: "context", passed: true, requests,
    reduction: reports[2]!.contextReduction, answer }));
} catch {
  console.error(`Context verification failed in phase ${phase}. Inspect recorded outcomes; no provider details are displayed.`);
  process.exitCode = 1;
} finally {
  const target = resolve(workspace);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("fatcat-context-")) {
    throw new Error("Refusing to remove an unexpected verification directory.");
  }
  await rm(target, { recursive: true, force: true });
}
