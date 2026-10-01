import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  assertWorkflowTurn, captureWorkflowStart, createWorkflowFixture, editablePaths,
  followupNote, initialFiles, prepareWorkflowFollowup, workflowCommand,
} from "../scripts/fixtures/coding-workflow.js";
import type { WorkflowEvidence } from "../scripts/fixtures/coding-workflow.js";
import { createTurnReporter } from "../src/execution-report.js";
import type { ExecutionReport } from "../src/execution-report.js";
import type { Model, ModelTurn } from "../src/model.js";
import { Session } from "../src/session/session.js";
import { createTools } from "../src/tools.js";
import type { Tools } from "../src/tools.js";
import { temporaryWorkspace } from "./fixtures/workspace.js";

const windows = { skip: process.platform !== "win32" };
const answer = (content: string): ModelTurn => ({ message: { role: "assistant", content }, toolCalls: [] });
function calls(prefix: string, operations: [string, unknown][]): ModelTurn {
  const toolCalls = operations.map(([name, args], index) => ({
    id: `${prefix}-${index}`, type: "function" as const,
    function: { name, arguments: JSON.stringify(args) },
  }));
  return { message: { role: "assistant", content: null, tool_calls: toolCalls }, toolCalls };
}

const fixedReceipt = initialFiles["src/receipt.mjs"]!.replace("Math.floor(", "Math.round(");
const discountedReceipt = `import { subtotal } from "./cart/subtotal.mjs";
export function receipt(items, taxPercent = 0, discountCents = 0) {
  const subtotalCents = subtotal(items);
  const taxableCents = Math.max(0, subtotalCents - discountCents);
  const taxCents = Math.round(taxableCents * taxPercent / 100);
  return { subtotalCents, taxCents, totalCents: taxableCents + taxCents };
}
`;

async function scriptedWorkflow(workspace: string) {
  const base = await createTools(workspace, "workspace-write", undefined, {
    permission: "ask", approve: async (request) => request.command === workflowCommand && request.cwd === ".",
  });
  let evidence: WorkflowEvidence;
  let steps: ModelTurn[] = [];
  const attemptedWrites = new Set<string>();
  const tools: Tools = { ...base, async execute(name, args, signal, callId) {
    const input = JSON.parse(args) as { path?: string };
    if (name === "write" && input.path) attemptedWrites.add(input.path);
    const result = await base.execute(name, args, signal, callId);
    if (name === "read" && result.ok) {
      const value = result.result as { kind: string; path: string; content?: string; matches?: { path: string }[] };
      if (value.kind === "file" && !attemptedWrites.has(value.path)
        && value.content === evidence.beforeFiles[value.path]) evidence.freshReads.push(value.path);
      if (value.kind === "search") evidence.searchedPaths.push(...(value.matches ?? []).map((match) => match.path));
    }
    return result;
  } };
  const model: Model = async (messages, _signal, observe) => {
    // Synthetic observations exercise reporting without making a provider request.
    observe?.({ type: "model_input", bytes: Buffer.byteLength(JSON.stringify(messages)), limitBytes: 262144, accepted: true });
    observe?.({ type: "model_usage", usage: { promptTokens: 12, completionTokens: 4, totalTokens: 16 } });
    const next = steps.shift();
    assert.ok(next, "The scripted model must not request an extra step.");
    return next;
  };
  const session = new Session({ tools, model, maxIterations: 3 });
  return { tools, async run(phase: 1 | 2) {
    evidence = await captureWorkflowStart(workspace, tools, phase);
    attemptedWrites.clear();
    const reads: [string, unknown][] = editablePaths.map((path) => ["read", { path }]);
    if (phase === 1) reads.unshift(["read", { path: "src", query: "subtotal" }]);
    reads.push(["read", { path: "check.test.mjs" }], ["shell", { command: workflowCommand, cwd: "." }]);
    const writes: [string, unknown][] = phase === 1 ? [
      ["write", { path: editablePaths[0], oldText: "sum + item.priceCents", newText: "sum + item.priceCents * item.quantity" }],
      ["write", { path: editablePaths[1], oldText: "Math.floor(", newText: "Math.round(" }],
    ] : [["write", { path: editablePaths[1], oldText: fixedReceipt, newText: discountedReceipt }]];
    writes.push(["shell", { command: workflowCommand, cwd: "." }]);
    steps = [calls(`read-${phase}`, reads), calls(`edit-${phase}`, writes), answer(`Phase ${phase} checks passed.`)];
    let report: ExecutionReport | undefined;
    await session.run(phase === 1 ? "Fix the cart and receipt." : "Add the discount requested in the new tests.", {
      onEvent: createTurnReporter((event) => {
        if (event.type === "execution_report") report = event.report;
      }),
    });
    assert.ok(report);
    assert.equal(steps.length, 0);
    return { evidence, report };
  } };
}

test("coding workflow acceptance requires current files and observed per-turn evidence", windows, async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await createWorkflowFixture(workspace);
  const workflow = await scriptedWorkflow(workspace);
  const first = await workflow.run(1);
  await assertWorkflowTurn(workspace, workflow.tools, first.evidence, first.report);
  assert.equal(first.report.writes.length, 2);
  assert.equal(first.report.commands.length, 2);
  assert.equal(first.report.commands[0]!.succeeded, false);
  assert.equal(first.report.commands[0]!.laterWriteAttempt, true);
  assert.equal(first.report.commands[1]!.succeeded, true);

  await t.test("an unexecuted completion claim cannot pass the fixture gate", async (child) => {
    const empty = await temporaryWorkspace(child);
    await createWorkflowFixture(empty.workspace);
    const tools = await createTools(empty.workspace, "workspace-write");
    const evidence = await captureWorkflowStart(empty.workspace, tools, 1);
    let report: ExecutionReport | undefined;
    const session = new Session({ tools, maxIterations: 1, model: async () => answer("All changes are complete and all tests passed.") });
    await session.run("Fix the cart and receipt.", {
      onEvent: createTurnReporter((event) => {
        if (event.type === "execution_report") report = event.report;
      }),
    });
    assert.ok(report);
    await assert.rejects(assertWorkflowTurn(empty.workspace, tools, evidence, report), /This turn must change/);
    assert.deepEqual(report.commands, []);
    assert.deepEqual(report.writes, []);
  });

  await t.test("fixed tests and unrelated user files remain protected", async () => {
    for (const [path, reason] of [["check.test.mjs", /fixed checks must remain unchanged/],
      ["src/catalog.mjs", /Unrelated user code must remain unchanged/]] as const) {
      const absolute = join(workspace, path);
      const saved = await readFile(absolute, "utf8");
      try {
        await writeFile(absolute, saved + "// Unauthorized change.\n");
        await assert.rejects(assertWorkflowTurn(workspace, workflow.tools, first.evidence, first.report), reason);
      } finally {
        await writeFile(absolute, saved);
      }
    }
  });

  await t.test("partial repairs and regressions after historical success are rejected", async () => {
    const receiptPath = join(workspace, editablePaths[1]);
    const savedReceipt = await readFile(receiptPath, "utf8");
    try {
      await writeFile(receiptPath, initialFiles[editablePaths[1]]!);
      await assert.rejects(assertWorkflowTurn(workspace, workflow.tools, first.evidence, first.report), /This turn must change src\/receipt/);
    } finally {
      await writeFile(receiptPath, savedReceipt);
    }
    const subtotalPath = join(workspace, editablePaths[0]);
    const savedSubtotal = await readFile(subtotalPath, "utf8");
    try {
      await writeFile(subtotalPath, savedSubtotal.replace("item.quantity", "1"));
      await assert.rejects(assertWorkflowTurn(workspace, workflow.tools, first.evidence, first.report), /Independent verification of the current files must pass/);
    } finally {
      await writeFile(subtotalPath, savedSubtotal);
    }
  });

  await t.test("fresh reads and source discovery cannot be inferred from a successful answer", async () => {
    for (const path of editablePaths) {
      const missingRead = structuredClone(first.evidence);
      missingRead.freshReads = missingRead.freshReads.filter((read) => read !== path);
      await assert.rejects(assertWorkflowTurn(workspace, workflow.tools, missingRead, first.report), /must read the current/);
    }
    const missingSearch = structuredClone(first.evidence);
    missingSearch.searchedPaths = [editablePaths[0]];
    await assert.rejects(assertWorkflowTurn(workspace, workflow.tools, missingSearch, first.report), /Search must locate both/);
  });

  await t.test("reports require real command entries and a check after the last write", async () => {
    const missingCommand = structuredClone(first.report);
    missingCommand.commands.pop();
    await assert.rejects(assertWorkflowTurn(workspace, workflow.tools, first.evidence, missingCommand), /Report commands must be exactly/);
    const incorrectExit = structuredClone(first.report);
    incorrectExit.commands[0]!.exitCode = 0;
    await assert.rejects(assertWorkflowTurn(workspace, workflow.tools, first.evidence, incorrectExit), /Reported command metadata must match/);
    const incorrectSuccess = structuredClone(first.report);
    incorrectSuccess.commands[0]!.succeeded = true;
    await assert.rejects(assertWorkflowTurn(workspace, workflow.tools, first.evidence, incorrectSuccess), /Reported command success must match/);
    const staleCommand = structuredClone(first.report);
    staleCommand.commands.at(-1)!.laterWriteAttempt = true;
    await assert.rejects(assertWorkflowTurn(workspace, workflow.tools, first.evidence, staleCommand), /last successful command must follow the last write/);
    const missingUsage = structuredClone(first.report);
    missingUsage.tokenUsage.parent.reportedRequests = 0;
    await assert.rejects(assertWorkflowTurn(workspace, workflow.tools, first.evidence, missingUsage));
  });

  await t.test("a follow-up preserves user edits and cannot reuse previous-turn evidence", async () => {
    await prepareWorkflowFollowup(workspace);
    const second = await workflow.run(2);
    await assertWorkflowTurn(workspace, workflow.tools, second.evidence, second.report);
    assert.equal(second.report.writes.length, 1);
    assert.equal(second.report.commands.length, 2);
    assert.ok(second.report.commands.every((record) => !first.report.commands.some((previous) => previous.id === record.id)));
    assert.equal(await readFile(join(workspace, editablePaths[0]), "utf8"), second.evidence.beforeFiles[editablePaths[0]]);
    await assert.rejects(assertWorkflowTurn(workspace, workflow.tools, second.evidence, first.report), /Report writes must be exactly/);
    const missingRead = structuredClone(second.evidence);
    missingRead.freshReads = [];
    await assert.rejects(assertWorkflowTurn(workspace, workflow.tools, missingRead, second.report), /must read the current/);
    const subtotalPath = join(workspace, editablePaths[0]);
    const savedSubtotal = await readFile(subtotalPath, "utf8");
    try {
      await writeFile(subtotalPath, savedSubtotal + "// Unrequested follow-up edit.\n");
      await assert.rejects(assertWorkflowTurn(workspace, workflow.tools, second.evidence, second.report), /follow-up must preserve the already-correct subtotal/);
    } finally {
      await writeFile(subtotalPath, savedSubtotal);
    }
    const path = join(workspace, editablePaths[1]);
    const saved = await readFile(path, "utf8");
    try {
      await writeFile(path, saved.slice(followupNote.length));
      await assert.rejects(assertWorkflowTurn(workspace, workflow.tools, second.evidence, second.report), /user note added between turns must be preserved/);
    } finally {
      await writeFile(path, saved);
    }
  });
});
