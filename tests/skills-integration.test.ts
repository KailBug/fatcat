import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createAgent } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import { prepareRequestContext } from "../src/context/request.js";
import type { Message } from "../src/model.js";
import { Session } from "../src/session/session.js";
import { discoverSkills } from "../src/skills.js";
import { createTools } from "../src/tools.js";
import { temporaryWorkspace } from "./fixtures/workspace.js";

const config = loadConfig({ DEEPSEEK_API_KEY: "offline-skills-only", HARNESS_MAX_ITERATIONS: "4" });
const skillBody = "---\nname: review-fixture\ndescription: Inspect test coverage for a change.\nallowed-tools: shell\n---\nSKILL_PRIVATE_INSTRUCTION\nRead references/checklist.md before reviewing.\n";
function answer(content: string) {
  return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] });
}
function call(name: string, args: unknown, id = "skill-call") {
  return Response.json({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null,
    tool_calls: [{ type: "function", id, function: { name, arguments: JSON.stringify(args) } }],
  } }] });
}
type Body = { messages: Message[]; tools: { function: { name: string } }[] };
const loaded = (messages: Message[]) => messages.some((message) => message.role === "tool"
  && String(message.content).includes("SKILL_PRIVATE_INSTRUCTION"));

async function fixture(workspace: string, userHome: string) {
  const root = join(workspace, ".agents", "skills", "review-fixture");
  await mkdir(join(root, "references"), { recursive: true });
  await writeFile(join(root, "SKILL.md"), skillBody);
  await writeFile(join(root, "references", "checklist.md"), "CHECKLIST_RESOURCE\n");
  return discoverSkills({ workspace, userHome, builtinRoot: false });
}

test("skill activation follows successful Session history, failure isolation and reset", async (t) => {
  const { workspace, outside } = await temporaryWorkspace(t);
  const catalog = await fixture(workspace, outside);
  let latest: Message[] = [];
  const agent = createAgent(config, await createTools(workspace), async (input, init) => {
    const { messages } = await new Request(input, init).json() as Body;
    latest = structuredClone(messages);
    assert.ok(String(messages[0]?.content).includes("Inspect test coverage"));
    assert.ok(!String(messages[0]?.content).includes("SKILL_PRIVATE_INSTRUCTION"));
    const prompt = messages.findLast((message) => message.role === "user")?.content;
    if (prompt === "Recall") return answer(loaded(messages) ? "Loaded" : "Absent");
    if (messages.at(-1)?.role === "user") {
      assert.equal(loaded(messages), false);
      return call("read", { path: "skill://review-fixture/SKILL.md" });
    }
    assert.ok(loaded(messages));
    if (prompt === "Load then fail") return Response.json({ error: { message: "private-provider-error" } }, { status: 500 });
    return answer("Loaded");
  }, catalog);
  const session = new Session(agent);
  await assert.rejects(session.run("Load then fail"), { code: "MODEL_HTTP" });
  assert.equal(await session.run("Recall"), "Absent");
  assert.equal(await session.run("Use $review-fixture"), "Loaded");
  assert.equal(await session.run("Recall"), "Loaded");
  assert.equal(latest.filter((message) => message.role === "tool").length, 1);
  assert.equal(await new Session(agent).run("Recall"), "Absent");
  session.reset();
  assert.equal(await session.run("Recall"), "Absent");
});

test("delegated skills load independently and allowed-tools cannot authorize shell", async (t) => {
  const { workspace, outside } = await temporaryWorkspace(t);
  const catalog = await fixture(workspace, outside);
  let children = 0;
  const base = await createTools(workspace);
  const agent = createAgent(config, base, async (input, init) => {
    const { messages, tools } = await new Request(input, init).json() as Body;
    assert.ok(String(messages[0]?.content).includes("skill://review-fixture/SKILL.md"));
    if (tools.some((tool) => tool.function.name === "delegate_task")) {
      assert.equal(loaded(messages), false);
      if (messages.at(-1)?.role === "user") return call("delegate_task", { task: "Use $review-fixture to inspect permissions." }, "delegate");
      return answer("Child observed the permission boundary.");
    }
    children++;
    assert.ok(!JSON.stringify(messages).includes("Parent private context"));
    if (children === 1) return call("read", { path: "skill://review-fixture/SKILL.md" }, "child-read");
    assert.ok(loaded(messages));
    if (children === 2) return call("shell", { command: "exit 0" }, "child-shell");
    assert.match(String(messages.at(-1)?.content), /PERMISSION_DENIED/);
    return answer("The skill cannot grant shell permission.");
  }, catalog);
  assert.equal(await new Session(agent).run("Parent private context"), "Child observed the permission boundary.");
  assert.equal(children, 3);
  assert.deepEqual(base.getCommands!(), []);
});

test("loaded skill instructions survive old-read projection but still count toward request limits", () => {
  const messages: Message[] = [{ role: "system", content: "Base role" }, { role: "user", content: "Load skill and file" },
    { role: "assistant", content: null, tool_calls: [
      { type: "function", id: "skill", function: { name: "read", arguments: '{"path":"skill://review-fixture/SKILL.md"}' } },
      { type: "function", id: "file", function: { name: "read", arguments: '{"path":"notes.txt"}' } },
    ] },
    { role: "tool", tool_call_id: "skill", content: JSON.stringify({ ok: true, result: { kind: "skill", path: "skill://review-fixture/SKILL.md", content: skillBody } }) },
    { role: "tool", tool_call_id: "file", content: JSON.stringify({ ok: true, result: { kind: "file", path: "notes.txt", content: "x".repeat(10000) } }) },
    { role: "assistant", content: "Loaded" }, { role: "user", content: "Second turn" },
    { role: "assistant", content: "Ready" }, { role: "user", content: "Continue" }];
  const snapshot = structuredClone(messages);
  const prepared = prepareRequestContext({ messages }, 4000);
  assert.equal(prepared.omittedReadResults, 1);
  assert.ok(JSON.stringify(prepared.body).includes("SKILL_PRIVATE_INSTRUCTION"));
  assert.deepEqual(messages, snapshot);
  const tooSmall = prepareRequestContext({ messages }, 100);
  assert.ok(tooSmall.bytes > 100);
  assert.ok(JSON.stringify(tooSmall.body).includes("SKILL_PRIVATE_INSTRUCTION"));
});

test("skill catalog and content cannot bypass the model request budget", async (t) => {
  const { workspace, outside } = await temporaryWorkspace(t);
  const catalog = await fixture(workspace, outside);
  let calls = 0;
  const agent = createAgent({ ...config, maxRequestBytes: 1 }, await createTools(workspace), async () => {
    calls++;
    return answer("Unexpected");
  }, catalog);
  await assert.rejects(new Session(agent).run("Use $review-fixture"), { code: "MODEL_CONTEXT_LIMIT" });
  assert.equal(calls, 0);
});
