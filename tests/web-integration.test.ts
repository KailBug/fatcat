import assert from "node:assert/strict";
import test from "node:test";
import { createAgent } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import { createTurnReporter } from "../src/execution-report.js";
import type { ReportEvent } from "../src/execution-report.js";
import type { Message } from "../src/model.js";
import { Session } from "../src/session.js";
import { discoverSkills } from "../src/skills.js";
import { createTools } from "../src/tools.js";
import { temporaryWorkspace } from "./fixtures/workspace.js";

const config = loadConfig({ DEEPSEEK_API_KEY: "offline-web-only", HARNESS_MAX_ITERATIONS: "5" });
const answer = (content: string) => Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] });
const call = (name: string, args: unknown, id: string) => Response.json({ choices: [{ finish_reason: "tool_calls", message: {
  role: "assistant", content: null, tool_calls: [{ type: "function", id, function: { name, arguments: JSON.stringify(args) } }],
} }] });

test("SDK and Session load the actual weather Skill, retrieve data, cite it and retain history", async (t) => {
  const { workspace, outside: userHome } = await temporaryWorkspace(t);
  let webRequests = 0;
  const base = await createTools(workspace, "read-only", undefined, {}, {
    permission: "allow", resolver: async () => [{ address: "8.8.8.8", family: 4 }],
    transport: async (url) => {
      webRequests++;
      assert.equal(url.hostname, "api.open-meteo.com");
      return Response.json({ timezone: "Europe/Berlin", current_units: { temperature_2m: "C" }, current: { time: "2026-09-29T12:00", temperature_2m: 18 } });
    },
  });
  const skills = await discoverSkills({ workspace, userHome });
  let requests = 0;
  const agent = createAgent(config, base, async (input, init) => {
    const { messages, tools } = await new Request(input, init).json() as { messages: Message[]; tools: { function: { name: string } }[] };
    assert.ok(tools.some((tool) => tool.function.name === "web"));
    assert.match(String(messages[0]?.content), /skill:\/\/weather-lookup\/SKILL.md/);
    requests++;
    const last = messages.at(-1)!;
    if (last.role === "user" && last.content === "Check weather") return call("read", { path: "skill://weather-lookup/SKILL.md" }, "skill");
    if (last.role === "tool" && last.tool_call_id === "skill") {
      assert.match(String(last.content), /geocoding-api.open-meteo.com/);
      return call("web", { action: "fetch", url: "https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.41&current=temperature_2m" }, "weather");
    }
    assert.ok(messages.some((message) => message.role === "tool" && String(message.content).includes('"untrusted":true')));
    assert.ok(messages.some((message) => message.role === "tool" && String(message.content).includes("temperature_2m")));
    return answer("Berlin: 18 C at 12:00 Europe/Berlin. [Source](https://api.open-meteo.com/v1/forecast?latitude=52.52&longitude=13.41&current=temperature_2m)");
  }, skills);
  const events: ReportEvent[] = [];
  const session = new Session(agent);
  assert.match(await session.run("Check weather", { onEvent: createTurnReporter((event) => events.push(event)) }), /18 C/);
  assert.match(await session.run("Recall source"), /Source/);
  assert.equal(webRequests, 1);
  assert.equal(requests, 4);
  const report = events.find((event) => event.type === "execution_report");
  assert.ok(report && report.type === "execution_report");
  assert.equal(report.report.toolResults.ok, 2);
  assert.equal(report.report.writes.length, 0);
  assert.equal(report.report.commands.length, 0);
  assert.doesNotMatch(JSON.stringify(events), /latitude|temperature_2m|offline-web-only/);
});

test("children share web permission and network denial cannot be elevated by delegation", async () => {
  for (const permission of ["allow", "deny"] as const) {
    let requests = 0;
    const base = await createTools(undefined, "read-only", undefined, {}, {
      permission, resolver: async () => [{ address: "8.8.8.8", family: 4 }],
      transport: async () => { requests++; return new Response("Public source", { headers: { "content-type": "text/plain" } }); },
    });
    const agent = createAgent(config, base, async (input, init) => {
      const { messages, tools } = await new Request(input, init).json() as { messages: Message[]; tools: { function: { name: string } }[] };
      assert.ok(tools.some((tool) => tool.function.name === "web"));
      const parent = tools.some((tool) => tool.function.name === "delegate_task");
      if (messages.at(-1)?.role === "user") return parent
        ? call("delegate_task", { task: "Read the source" }, "delegate")
        : call("web", { action: "fetch", url: "https://www.example.com" }, "fetch");
      assert.match(String(messages.at(-1)?.content), permission === "allow" ? /Public source/ : /PERMISSION_DENIED/);
      return answer(permission === "allow" ? "Public source" : "PERMISSION_DENIED");
    });
    assert.equal(await new Session(agent).run("Research independently"), permission === "allow" ? "Public source" : "PERMISSION_DENIED");
    assert.equal(requests, permission === "allow" ? 1 : 0);
  }
});
