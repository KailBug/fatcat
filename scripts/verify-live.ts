import assert from "node:assert/strict";
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
} catch (error) {
  console.error(error instanceof HarnessError ? `Error [${error.code}]: ${error.message}` : "Live verification failed its assertions.");
  process.exitCode = 1;
}
