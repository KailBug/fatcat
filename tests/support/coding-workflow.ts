import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExecutionReport } from "../../src/execution-report.js";
import type { Tools } from "../../src/tools.js";
import { runPowerShell } from "../../src/permissions/process.js";

export const workflowCommand = "node --test check.test.mjs";
export const editablePaths = ["src/cart/subtotal.mjs", "src/receipt.mjs"] as const;
export const initialFiles: Record<string, string> = {
  "src/cart/subtotal.mjs": "export const subtotal = (items) => items.reduce((sum, item) => sum + item.priceCents, 0);\n",
  "src/receipt.mjs": 'import { subtotal } from "./cart/subtotal.mjs";\nexport function receipt(items, taxPercent = 0) {\n  const subtotalCents = subtotal(items);\n  const taxCents = Math.floor(subtotalCents * taxPercent / 100);\n  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };\n}\n',
  "src/catalog.mjs": 'export const catalogVersion = "user-owned-2026";\n',
};
export const initialChecks = `import assert from "node:assert/strict";
import test from "node:test";
import { subtotal } from "./src/cart/subtotal.mjs";
import { receipt } from "./src/receipt.mjs";
test("subtotal uses every quantity and supports empty carts", () => {
  assert.equal(subtotal([{ priceCents: 125, quantity: 3 }, { priceCents: 50, quantity: 2 }]), 475);
  assert.equal(subtotal([{ priceCents: 125, quantity: 0 }]), 0);
  assert.equal(subtotal([]), 0);
});
test("receipt rounds tax to the nearest cent and preserves its public result", () => {
  assert.deepEqual(receipt([{ priceCents: 105, quantity: 3 }], 10),
    { subtotalCents: 315, taxCents: 32, totalCents: 347 });
  assert.deepEqual(receipt([{ priceCents: 49, quantity: 1 }], 10),
    { subtotalCents: 49, taxCents: 5, totalCents: 54 });
  assert.deepEqual(receipt([], 10), { subtotalCents: 0, taxCents: 0, totalCents: 0 });
});
`;
export const followupChecks = initialChecks + `test("receipt discounts before tax without changing the original subtotal", () => {
  const items = [{ priceCents: 105, quantity: 3 }];
  assert.deepEqual(receipt(items, 10, 100), { subtotalCents: 315, taxCents: 22, totalCents: 237 });
  assert.deepEqual(receipt(items, 10, 999), { subtotalCents: 315, taxCents: 0, totalCents: 0 });
  assert.deepEqual(receipt(items, 10, 0), { subtotalCents: 315, taxCents: 32, totalCents: 347 });
  assert.deepEqual(items, [{ priceCents: 105, quantity: 3 }]);
});
`;
export const followupNote = "// Keep this user note added between conversation turns.\n";

export async function createWorkflowFixture(workspace: string): Promise<void> {
  await mkdir(join(workspace, "src", "cart"), { recursive: true });
  for (const [path, content] of Object.entries(initialFiles)) await writeFile(join(workspace, path), content);
  await writeFile(join(workspace, "check.test.mjs"), initialChecks);
}

export async function prepareWorkflowFollowup(workspace: string): Promise<void> {
  await writeFile(join(workspace, "check.test.mjs"), followupChecks);
  const path = join(workspace, "src/receipt.mjs");
  await writeFile(path, followupNote + await readFile(path, "utf8"));
}

export type WorkflowEvidence = {
  phase: 1 | 2;
  beforeFiles: Record<string, string>;
  beforeWriteIds: string[];
  beforeCommandIds: string[];
  freshReads: string[];
  searchedPaths: string[];
};

export async function captureWorkflowStart(workspace: string, tools: Tools, phase: 1 | 2): Promise<WorkflowEvidence> {
  const beforeFiles: Record<string, string> = {};
  for (const path of editablePaths) beforeFiles[path] = await readFile(join(workspace, path), "utf8");
  return { phase, beforeFiles, beforeWriteIds: tools.getWrites!().map((record) => record.id),
    beforeCommandIds: tools.getCommands!().map((record) => record.id), freshReads: [], searchedPaths: [] };
}

/** Check real files and this turn's journals; model wording is never a pass condition. */
export async function assertWorkflowTurn(workspace: string, tools: Tools,
  evidence: WorkflowEvidence, report: ExecutionReport): Promise<void> {
  assert.equal(await readFile(join(workspace, "check.test.mjs"), "utf8"),
    evidence.phase === 1 ? initialChecks : followupChecks, "The fixed checks must remain unchanged.");
  assert.equal(await readFile(join(workspace, "src/catalog.mjs"), "utf8"), initialFiles["src/catalog.mjs"],
    "Unrelated user code must remain unchanged.");
  const requiredEdits: readonly string[] = evidence.phase === 1 ? editablePaths : ["src/receipt.mjs"];
  for (const path of requiredEdits) {
    assert.notEqual(await readFile(join(workspace, path), "utf8"), evidence.beforeFiles[path],
      `This turn must change ${path}.`);
  }
  if (evidence.phase === 2) {
    assert.equal(await readFile(join(workspace, editablePaths[0]), "utf8"), evidence.beforeFiles[editablePaths[0]],
      "The follow-up must preserve the already-correct subtotal module.");
    assert.ok((await readFile(join(workspace, "src/receipt.mjs"), "utf8")).startsWith(followupNote),
      "The user note added between turns must be preserved.");
  }
  for (const path of editablePaths) {
    assert.ok(evidence.freshReads.includes(path), `This turn must read the current ${path} before editing it.`);
    if (evidence.phase === 1) assert.ok(evidence.searchedPaths.includes(path), "Search must locate both related modules.");
  }
  const writes = tools.getWrites!().filter((record) => !evidence.beforeWriteIds.includes(record.id));
  const commands = tools.getCommands!().filter((record) => !evidence.beforeCommandIds.includes(record.id));
  assert.equal(report.outcome, "answered");
  assert.equal(report.taskVerification, "not_assessed");
  assert.deepEqual(report.writes, writes, "Report writes must be exactly this turn's journal entries.");
  assert.deepEqual(report.commands.map((record) => record.id).sort(), commands.map((record) => record.id).sort(),
    "Report commands must be exactly this turn's journal entries.");
  for (const record of commands) {
    const { succeeded, laterWriteAttempt: _laterWriteAttempt, ...observed } = report.commands.find((item) => item.id === record.id)!;
    const { command: _command, stdout: _stdout, stderr: _stderr, ...expected } = record;
    assert.deepEqual(observed, expected, "Reported command metadata must match the actual journal outcome.");
    assert.equal(succeeded, record.status === "completed" && record.exitCode === 0
      && !record.truncated && record.cleanup !== "unconfirmed", "Reported command success must match the actual outcome.");
  }
  for (const path of requiredEdits) assert.ok(writes.some((record) => record.path === path && record.status === "committed"));
  assert.ok(commands.length >= 2, "Reproduce a failure, then run a new successful check.");
  assert.ok(commands.every((record) => record.command === workflowCommand && record.cwd === "."));
  assert.ok(commands.some((record) => record.status === "completed" && record.exitCode !== null
    && record.exitCode !== 0 && !record.truncated), "The agent must observe a failing check in this turn.");
  const last = commands.at(-1)!;
  assert.equal(last.status, "completed");
  assert.equal(last.exitCode, 0);
  assert.equal(last.truncated, false);
  assert.notEqual(last.cleanup, "unconfirmed");
  const reportedLast = report.commands.find((record) => record.id === last.id);
  assert.ok(reportedLast?.succeeded && !reportedLast.laterWriteAttempt,
    "The last successful command must follow the last write attempt.");
  for (const role of ["parent", "children"] as const) {
    assert.equal(report.requestBytes[role].checked, report.modelRequests[role]);
    assert.equal(report.requestBytes[role].rejected, 0);
    assert.equal(report.tokenUsage[role].reportedRequests, report.modelRequests[role]);
    if (report.modelRequests[role] > 0) {
      const usage = report.tokenUsage[role].totals;
      assert.ok(usage && usage.promptTokens > 0 && usage.completionTokens > 0);
      assert.equal(usage.totalTokens, usage.promptTokens + usage.completionTokens);
    }
  }
  const independent = await runPowerShell(workflowCommand, workspace, 10000);
  assert.equal(independent.status, "completed");
  assert.equal(independent.exitCode, 0, "Independent verification of the current files must pass.");
  assert.equal(independent.truncated, false);
  assert.notEqual(independent.cleanup, "unconfirmed");
}
