import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { loadLiveConfig } from "./fixtures/live-config.js";
import { runAgent } from "../src/loop.js";
import { createAgent } from "../src/agent.js";
import { createTurnReporter } from "../src/execution-report.js";
import type { ExecutionReport } from "../src/execution-report.js";
import { createTools } from "../src/tools.js";
import type { Tools } from "../src/tools.js";
import { failure } from "../src/tools/types.js";
import { runPowerShell } from "../src/permissions/process.js";

const command = "node --test check.test.mjs";
const sourcePath = "src/math/add.mjs";
const source = "export const add = (a, b) => a - b;\n";
const consumer = 'import { add } from "./math/add.mjs";\nexport const total = (a, b) => add(a, b);\n';
const checks = `import assert from "node:assert/strict";
import test from "node:test";
import { total } from "./src/total.mjs";
test("adds positive and negative values", () => {
  assert.equal(total(2, 3), 5);
  assert.equal(total(-4, 1), -3);
});
`;
const workspace = await mkdtemp(join(tmpdir(), "fatcat-coding-"));
try {
  await mkdir(join(workspace, "src", "math"), { recursive: true });
  await writeFile(join(workspace, sourcePath), source);
  await writeFile(join(workspace, "src", "total.mjs"), consumer);
  await writeFile(join(workspace, "check.test.mjs"), checks);
  const before = await runPowerShell(command, workspace, 10000);
  assert.equal(before.status, "completed");
  assert.notEqual(before.exitCode, 0, "The initial fixture must fail verification.");
  const config = loadLiveConfig();
  const base = await createTools(workspace, "workspace-write", undefined, {
    permission: "ask", approve: async (request) => request.command === command && request.cwd === ".",
  });
  // Only the known source file and fixed verification command are authorized by this live check.
  let searches = 0;
  let locatedSource = false;
  const tools: Tools = { ...base, async execute(name, args, signal, callId) {
    if (name === "write") {
      const input = JSON.parse(args) as { path?: string };
      if (input.path !== sourcePath) return failure("PERMISSION_DENIED", "Only src/math/add.mjs may be edited in this verification fixture.");
    }
    const result = await base.execute(name, args, signal, callId);
    if (name === "read" && result.ok) {
      const value = result.result as { kind?: string; matches?: { path: string }[] };
      if (value.kind === "search") {
        searches++;
        locatedSource ||= value.matches?.some((match) => match.path === sourcePath) ?? false;
      }
    }
    return result;
  } };
  let report: ExecutionReport | undefined;
  const agent = createAgent({ ...config, maxIterations: Math.min(config.maxIterations, 8) }, tools);
  const answer = await runAgent(`The total function returns an incorrect sum. Use read with a literal query in src to locate the add implementation and its caller, then inspect the relevant files and check.test.mjs. Fix only the add implementation using an exact write edit. Do not change its caller. Run shell with command exactly "${command}" and cwd ".". Do not change the test. Report CODING_VERIFIED only if the command succeeds; otherwise explain the failure.`, {
    ...agent,
    onEvent: createTurnReporter((event) => {
      if (event.type === "execution_report") report = event.report;
      console.error(JSON.stringify({ scenario: "coding", ...event }));
    }),
  });
  assert.equal(await readFile(join(workspace, "check.test.mjs"), "utf8"), checks);
  assert.equal(await readFile(join(workspace, "src", "total.mjs"), "utf8"), consumer);
  assert.notEqual(await readFile(join(workspace, sourcePath), "utf8"), source);
  assert.ok(searches > 0 && locatedSource, "Search must locate the implementation before completing the task.");
  assert.ok(tools.getWrites!().some((record) => record.status === "committed"));
  assert.ok(tools.getCommands!().some((record) => record.command === command && record.status === "completed" && record.exitCode === 0 && !record.truncated));
  const after = await runPowerShell(command, workspace, 10000);
  assert.equal(after.exitCode, 0);
  assert.equal(after.status, "completed");
  assert.match(answer, /CODING_VERIFIED/);
  assert.ok(report);
  assert.equal(report.outcome, "answered");
  assert.equal(report.taskVerification, "not_assessed");
  assert.ok(report.writes.some((record) => record.status === "committed"));
  const commands = tools.getCommands!();
  assert.deepEqual(report.commands.map((record) => record.id).sort(), commands.map((record) => record.id).sort());
  assert.ok(report.commands.some((record) => record.succeeded && !record.laterWriteAttempt));
  const requests = report.modelRequests.parent + report.modelRequests.children;
  for (const role of ["parent", "children"] as const) {
    assert.equal(report.requestBytes[role].checked, report.modelRequests[role]);
    assert.equal(report.requestBytes[role].rejected, 0);
    assert.equal(report.tokenUsage[role].reportedRequests, report.modelRequests[role]);
    if (report.modelRequests[role] > 0) {
      const usage: ExecutionReport["tokenUsage"]["parent"]["totals"] = report.tokenUsage[role].totals;
      assert.ok(usage && usage.promptTokens > 0 && usage.completionTokens > 0);
      assert.equal(usage.totalTokens, usage.promptTokens + usage.completionTokens);
    }
  }

  console.log(JSON.stringify({ scenario: "coding", passed: true, requests, searches, requestBytes: report.requestBytes, tokenUsage: report.tokenUsage, answer }));
} catch {
  console.error("Coding verification failed. Inspect the recorded outcomes; no provider details are displayed.");
  process.exitCode = 1;
} finally {
  const target = resolve(workspace);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("fatcat-coding-")) {
    throw new Error("Refusing to remove an unexpected verification directory.");
  }
  await rm(target, { recursive: true, force: true });
}
