import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createTools } from "../src/tools.js";
import type { Tools, ToolResult } from "../src/tools.js";
import { loadLiveConfig } from "./fixtures/live-config.js";
import { HarnessError } from "../src/errors.js";
import { runAgent } from "../src/loop.js";
import { createDeepSeekModel } from "../src/model.js";
import { Session } from "../src/session.js";
import { createSubagentTools } from "../src/subagent.js";
import type { LoopEvent } from "../src/loop.js";

async function verifyWorkspaceWrite(config: ReturnType<typeof loadLiveConfig>): Promise<void> {
  const workspace = await mkdtemp(join(tmpdir(), "fatcat-live-write-"));
  try {
    const tools = await createTools(workspace, "workspace-write");
    const events: LoopEvent[] = [];
    const answer = await runAgent(
      'Use write to create calculation.ts containing exactly "export const total = 1;" followed by a newline. Read it with read. Then use write with oldText "total = 1" and newText "total = 2". Read it again to verify the change. Reply with WRITE_READY only after verification.', {
        model: createDeepSeekModel(config, undefined, tools), tools, maxIterations: Math.min(config.maxIterations, 6),
        onEvent: (event) => { events.push(event); console.error(JSON.stringify({ scenario: "workspace_write", ...event })); },
      });
    assert.equal(await readFile(join(workspace, "calculation.ts"), "utf8"), "export const total = 2;\n");
    assert.deepEqual(tools.getWrites!().map((record) => [record.operation, record.status]), [["create", "committed"], ["edit", "committed"]]);
    assert.ok(events.filter((event) => event.type === "tool_result" && event.tool === "read" && event.ok).length >= 2);
    assert.match(answer, /WRITE_READY/);
    console.log(JSON.stringify({ scenario: "workspace_write", passed: true, answer }));
  } finally {
    const target = resolve(workspace);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("fatcat-live-write-")) {
      throw new Error("Refusing to remove an unexpected verification directory.");
    }
    await rm(target, { recursive: true, force: true });
  }
}

try {
  const config = loadLiveConfig();
  const model = createDeepSeekModel(config);
  const maxIterations = Math.min(config.maxIterations, 3);
  const session = new Session({ model, maxIterations });
  for (const scenario of [
    { name: "direct_answer", prompt: "Reply with exactly READY. Do not call any tools.", tool: false, expected: /READY/ },
    { name: "tool_round_trip", prompt: "Use the sum tool to add 17 and 25, then report the total.", tool: true, expected: /\b42\b/ },
    { name: "session_follow_up", prompt: "Use the sum tool to add 8 to the total from my previous request. Reply with the new total only.", tool: true, expected: /\b50\b/ },
  ]) {
    const events: LoopEvent[] = [];
    const onEvent = (event: LoopEvent) => { events.push(event); console.error(JSON.stringify({ scenario: scenario.name, ...event })); };
    const answer = scenario.name === "direct_answer"
      ? await runAgent(scenario.prompt, { model, maxIterations, onEvent })
      : await session.run(scenario.prompt, { onEvent });
    const toolUsed = events.some((event) => event.type === "tool_result" && event.tool === "sum" && event.ok);
    assert.equal(toolUsed, scenario.tool, "Unexpected tool usage.");
    assert.match(answer, scenario.expected);
    console.log(JSON.stringify({ scenario: scenario.name, passed: true, answer }));
  }
  const workspaceTools = await createTools(fileURLToPath(new URL("../../examples/workspace", import.meta.url)));
  const readResults: ToolResult[] = [];
  const tools: Tools = { ...workspaceTools, async execute(name, args, signal, callId) {
    const result = await workspaceTools.execute(name, args, signal, callId);
    if (name === "read") readResults.push(result);
    return result;
  } };
  const events: LoopEvent[] = [];
  const answer = await runAgent("Use read to inspect the workspace root. Then read project-notes.txt with limit 1, starting at offset 0, and follow each nextOffset with limit 1 until it is null. Report the verification phrase from that file exactly.", {
    model: createDeepSeekModel(config, undefined, tools), tools, maxIterations: Math.min(config.maxIterations, 5),
    onEvent: (event) => { events.push(event); console.error(JSON.stringify({ scenario: "workspace_read", ...event })); },
  });
  assert.ok(events.some((event) => event.type === "tool_result" && event.tool === "read" && event.ok));
  const pages = readResults.filter((result) => result.ok).map((result) => result.result) as {
    kind: string; offset: number; startLine?: number; endLine?: number; nextOffset: number | null;
  }[];
  assert.ok(pages.some((page) => page.kind === "directory"));
  const filePages = pages.filter((page) => page.kind === "file");
  assert.deepEqual(filePages.map((page) => page.offset), [0, 1, 2]);
  assert.deepEqual(filePages.map((page) => page.nextOffset), [1, 2, null]);
  assert.ok(filePages.every((page) => page.startLine === page.endLine));
  assert.match(answer, /AMBER-MEADOW-42/);
  console.log(JSON.stringify({ scenario: "workspace_read", passed: true, answer }));
  const delegatedTools = createSubagentTools(tools, createDeepSeekModel(config, undefined, tools), config.maxIterations);
  const delegatedEvents: LoopEvent[] = [];
  const delegatedAnswer = await runAgent("Use delegate_task to ask a child assistant to read project-notes.txt with read and return its verification phrase. Then report the child's phrase only.", {
    model: createDeepSeekModel(config, undefined, delegatedTools), tools: delegatedTools, maxIterations,
    onEvent: (event) => { delegatedEvents.push(event); console.error(JSON.stringify({ scenario: "subagent_read", ...event })); },
  });
  assert.ok(delegatedEvents.some((event) => event.type === "tool_result" && event.tool === "delegate_task" && event.ok));
  assert.ok(delegatedEvents.some((event) => event.type === "subagent_event"
    && event.event.type === "tool_result" && event.event.tool === "read" && event.event.ok));
  assert.match(delegatedAnswer, /AMBER-MEADOW-42/);
  console.log(JSON.stringify({ scenario: "subagent_read", passed: true, answer: delegatedAnswer }));
  await verifyWorkspaceWrite(config);
} catch (error) {
  console.error(error instanceof HarnessError ? `Error [${error.code}]: ${error.message}` : "Live verification failed its assertions.");
  process.exitCode = 1;
}
