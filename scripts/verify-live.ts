import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createTools } from "../src/tools.js";
import { loadConfig } from "../src/config.js";
import { HarnessError } from "../src/errors.js";
import { runAgent } from "../src/loop.js";
import { createDeepSeekModel } from "../src/model.js";
import { Session } from "../src/session.js";
import type { LoopEvent } from "../src/loop.js";

try {
  const config = loadConfig();
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
  const tools = await createTools(fileURLToPath(new URL("../../examples/workspace", import.meta.url)));
  const events: LoopEvent[] = [];
  const answer = await runAgent("Use list_directory to inspect the workspace root, then use read_file to read project-notes.txt. Report the verification phrase from that file exactly.", {
    model: createDeepSeekModel(config, undefined, tools), tools, maxIterations: Math.min(config.maxIterations, 4),
    onEvent: (event) => { events.push(event); console.error(JSON.stringify({ scenario: "workspace_read", ...event })); },
  });
  for (const name of ["list_directory", "read_file"]) {
    assert.ok(events.some((event) => event.type === "tool_result" && event.tool === name && event.ok), `Expected ${name}.`);
  }
  assert.match(answer, /AMBER-MEADOW-42/);
  console.log(JSON.stringify({ scenario: "workspace_read", passed: true, answer }));
} catch (error) {
  console.error(error instanceof HarnessError ? `Error [${error.code}]: ${error.message}` : "Live verification failed its assertions.");
  process.exitCode = 1;
}
