import assert from "node:assert/strict";
import { loadConfig } from "../src/config.js";
import { HarnessError } from "../src/errors.js";
import { runAgent } from "../src/loop.js";
import { createDeepSeekModel } from "../src/model.js";
import type { LoopEvent } from "../src/loop.js";

try {
  const config = loadConfig();
  const model = createDeepSeekModel(config);
  for (const scenario of [
    { name: "direct_answer", prompt: "Reply with exactly READY. Do not call any tools.", tool: false },
    { name: "tool_round_trip", prompt: "Use the sum tool to add 17 and 25, then report the total.", tool: true },
  ]) {
    const events: LoopEvent[] = [];
    const answer = await runAgent(scenario.prompt, {
      model, maxIterations: Math.min(config.maxIterations, 3),
      onEvent: (event) => { events.push(event); console.error(JSON.stringify({ scenario: scenario.name, ...event })); },
    });
    const toolUsed = events.some((event) => event.type === "tool_result" && event.tool === "sum" && event.ok);
    assert.equal(toolUsed, scenario.tool, "Unexpected tool usage.");
    assert.match(answer, scenario.tool ? /\b42\b/ : /READY/);
    console.log(JSON.stringify({ scenario: scenario.name, passed: true, answer }));
  }
} catch (error) {
  console.error(error instanceof HarnessError ? `Error [${error.code}]: ${error.message}` : "Live verification failed its assertions.");
  process.exitCode = 1;
}
