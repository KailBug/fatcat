import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createAgent } from "../src/agent.js";
import { loadLiveConfig } from "./fixtures/live-config.js";
import { runAgent } from "../src/loop.js";
import type { LoopEvent } from "../src/loop.js";
import { createTools } from "../src/tools.js";

const fixtures = {
  "paginate.ts": `// Pages are one-based and contain at most size items.
export function paginate(items: number[], page: number, size: number): number[] {
  const start = (page - 1) * size;
  return items.slice(start, start + size + 1);
}
`,
  "clamp.ts": `// Return value unchanged inside [min, max], or the nearest boundary outside it.
export function clamp(value: number, min: number, max: number): number {
  return Math.min(min, Math.max(max, value));
}
`,
};
const workspace = await mkdtemp(join(tmpdir(), "fatcat-delegation-"));
try {
  for (const [name, contents] of Object.entries(fixtures)) await writeFile(join(workspace, name), contents);
  const config = loadLiveConfig();
  const agent = createAgent({ ...config, maxIterations: Math.min(config.maxIterations, 4) }, await createTools(workspace));
  const directEvents: LoopEvent[] = [];
  const direct = await runAgent("What is 17 plus 25? Answer with the number only.", { ...agent,
    onEvent: (event) => { directEvents.push(event); console.error(JSON.stringify({ scenario: "direct", ...event })); },
  });
  assert.match(direct, /\b42\b/);
  assert.ok(!directEvents.some((event) => event.type === "subagent_event" || (event.type === "tool_result" && event.tool === "delegate_task")));
  console.log(JSON.stringify({ scenario: "direct", passed: true, answer: direct }));

  const events: LoopEvent[] = [];
  const answer = await runAgent("Obtain two independent second-opinion reviews, one for paginate.ts and one for clamp.ts. Each reviewer must receive only its own file contract and example, without seeing the other review or your analysis. Combine their findings afterwards. Identify one correctness bug per file with expected versus actual output for paginate([10,20,30,40],1,2) and clamp(5,0,10). Do not modify files or execute commands. Return a concise combined review with both filenames.", {
    ...agent, onEvent: (event) => { events.push(event); console.error(JSON.stringify({ scenario: "independent_review", ...event })); },
  });
  const delegations = events.filter((event) => event.type === "tool_result" && event.tool === "delegate_task" && event.ok).length;
  assert.ok(delegations >= 1 && delegations <= 2, "Expected bounded task-driven delegation for independent reviews.");
  assert.ok(events.some((event) => event.type === "subagent_event" && event.event.type === "tool_result" && event.event.tool === "read" && event.event.ok));
  assert.match(answer, /paginate\.ts/);
  assert.match(answer, /clamp\.ts/);
  for (const [name, contents] of Object.entries(fixtures)) assert.equal(await readFile(join(workspace, name), "utf8"), contents);
  assert.deepEqual(agent.tools.getWrites!(), []);
  assert.deepEqual(agent.tools.getCommands!(), []);
  const requests = (items: LoopEvent[]): number => items.reduce((count, event) => count
    + (event.type === "model_request" ? 1 : event.type === "subagent_event" ? requests([event.event]) : 0), 0);
  console.log(JSON.stringify({ scenario: "independent_review", passed: true, delegations,
    requests: requests([...directEvents, ...events]), answer }));
} catch {
  console.error("Delegation verification failed. Inspect the fixed-scenario outcomes; model selection is not guaranteed for every task.");
  process.exitCode = 1;
} finally {
  const target = resolve(workspace);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("fatcat-delegation-")) {
    throw new Error("Refusing to remove an unexpected verification directory.");
  }
  await rm(target, { recursive: true, force: true });
}
