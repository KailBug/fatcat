import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { createAgent } from "../src/agent.js";
import { loadLiveConfig } from "./fixtures/live-config.js";
import { createTurnReporter } from "../src/execution-report.js";
import type { ExecutionReport } from "../src/execution-report.js";
import { Session } from "../src/session.js";
import { createTools } from "../src/tools.js";
import type { Tools } from "../src/tools.js";
import { runPowerShell } from "../src/tools/process.js";
import { assertWorkflowTurn, captureWorkflowStart, createWorkflowFixture, editablePaths,
  prepareWorkflowFollowup, workflowCommand } from "./fixtures/coding-workflow.js";
import type { WorkflowEvidence } from "./fixtures/coding-workflow.js";

const config = loadLiveConfig();
const workspace = await mkdtemp(resolve(tmpdir(), "fatcat-workflow-"));
let phase: 1 | 2 = 1;
let stage = "fixture setup";
try {
  await createWorkflowFixture(workspace);
  let evidence: WorkflowEvidence;
  const base = await createTools(workspace, "ask", async (request) => request.operation === "edit"
    && (phase === 1 ? editablePaths.some((path) => path === request.path) : request.path === "src/receipt.mjs"), {
    permission: "ask", approve: async (request) => request.command === workflowCommand && request.cwd === ".",
  });
  const tools: Tools = { ...base, async execute(...args) {
    const result = await base.execute(...args);
    if (args[0] === "read" && result.ok) {
      const value = result.result as { kind?: string; path?: string; content?: string; matches?: { path: string }[] };
      if (value.kind === "search") {
        for (const match of value.matches ?? []) evidence.searchedPaths.push(match.path);
      } else if (value.kind === "file" && value.path && value.content === evidence.beforeFiles[value.path]) {
        const alreadyEdited = base.getWrites!().some((record) => record.path === value.path
          && !evidence.beforeWriteIds.includes(record.id));
        if (!alreadyEdited) evidence.freshReads.push(value.path);
      }
    }
    return result;
  } };
  const maxIterations = Math.min(config.maxIterations, 8);
  const session = new Session(createAgent({ ...config, maxIterations }, tools));
  const reports: ExecutionReport[] = [];
  const prompts = [
    `Fix the shopping cart calculations. Use read with a literal query in src to locate subtotal and its receipt caller, then read both modules and check.test.mjs. First reproduce the failing checks with shell command exactly "${workflowCommand}" and cwd ".". subtotal must multiply each priceCents by quantity; receipt must round percentage tax to the nearest cent. Change only those two source modules using exact write edits, preserving the public result shape and unrelated code. Run the same checks after the edits, correct any remaining failures, and report the actual results. Do not edit tests or src/catalog.mjs.`,
    `Extend receipt with an optional third argument discountCents, defaulting to 0. Keep subtotalCents as the original quantity-weighted subtotal; subtract the discount before calculating tax, clamp the taxable amount to zero, round tax to the nearest cent, and return totalCents as the discounted taxable amount plus tax. Keep the existing two-argument behavior and do not mutate items. I added new checks and a user note to the current files since your last answer: read both source modules and check.test.mjs again, preserve that note, and reproduce the new failure using shell command exactly "${workflowCommand}" and cwd "." before editing. Edit only src/receipt.mjs, then run the same checks again and report this turn's actual result. Do not edit tests, src/catalog.mjs, or the subtotal module.`,
  ];
  for (const prompt of prompts) {
    if (phase === 2) await prepareWorkflowFollowup(workspace);
    stage = "initial independent check";
    const before = await runPowerShell(workflowCommand, workspace, 10000);
    assert.equal(before.status, "completed");
    assert.notEqual(before.exitCode, null);
    assert.notEqual(before.exitCode, 0, "The fixture must require changes in each turn.");
    assert.equal(before.truncated, false);
    evidence = await captureWorkflowStart(workspace, tools, phase);
    let report: ExecutionReport | undefined;
    stage = "model turn";
    const answer = await session.run(prompt, { onEvent: createTurnReporter((event) => {
      if (event.type === "execution_report") {
        assert.equal(report, undefined, "Each turn must produce exactly one report.");
        report = event.report;
      }
      console.error(JSON.stringify({ scenario: "workflow", phase, ...event }));
    }) });
    stage = "acceptance assertions";
    assert.ok(report);
    await assertWorkflowTurn(workspace, tools, evidence, report);
    assert.ok(report.modelRequests.parent <= maxIterations);
    assert.ok(report.modelRequests.children <= 2 * Math.min(3, maxIterations));
    reports.push(report);
    console.log(JSON.stringify({ scenario: "workflow", phase, passed: true,
      requests: report.modelRequests, requestBytes: report.requestBytes, tokenUsage: report.tokenUsage,
      changedPaths: [...new Set(report.writes.map((record) => record.path))], answer }));
    phase = 2;
  }
  const requests = reports.reduce((sum, report) => sum + report.modelRequests.parent + report.modelRequests.children, 0);
  console.log(JSON.stringify({ scenario: "workflow", passed: true, turns: reports.length, requests }));
} catch {
  console.error(`Workflow verification failed in phase ${phase} during ${stage}. Inspect the recorded outcomes; no provider details are displayed.`);
  process.exitCode = 1;
} finally {
  const target = resolve(workspace);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("fatcat-workflow-")) {
    throw new Error("Refusing to remove an unexpected verification directory.");
  }
  await rm(target, { recursive: true, force: true });
}
