import assert from "node:assert/strict";
import { readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createAgent } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import { runAgent, runAgentTurn } from "../src/loop.js";
import { createTools } from "../src/tools.js";
import { discoverSkills } from "../src/skills.js";
import type { Message } from "../src/model.js";
import { temporaryWorkspace } from "./fixtures/workspace.js";

const config = loadConfig({ DEEPSEEK_API_KEY: "offline-agent-only", HARNESS_MAX_ITERATIONS: "3" });
function answer(content: string) {
  return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] });
}
function calls(...tools: { name: string; args: unknown; id: string }[]) {
  return Response.json({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null,
    tool_calls: tools.map(({ name, args, id }) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } })),
  } }] });
}
type RequestBody = { messages: Message[]; tools: { function: { name: string } }[] };

test("default agent construction is idle and direct tasks make no child requests", async () => {
  let requests = 0;
  const agent = createAgent(config, undefined, async (input, init) => {
    requests++;
    const body = await new Request(input, init).json() as RequestBody;
    assert.deepEqual(body.tools.map((tool) => tool.function.name), ["sum", "delegate_task"]);
    assert.ok(!String(body.messages[0]?.content).includes("Workspace root (JSON string):"));
    return answer("Direct answer");
  });
  assert.equal(requests, 0);
  assert.equal(await runAgent("A simple question", agent), "Direct answer");
  assert.equal(requests, 1);
});

test("assembled SDK parent and child use distinct definitions and isolated histories", async () => {
  let parents = 0;
  let children = 0;
  const agent = createAgent(config, undefined, async (input, init) => {
    const body = await new Request(input, init).json() as RequestBody;
    const names = body.tools.map((tool) => tool.function.name);
    if (names.includes("delegate_task")) {
      assert.match(String(body.messages[0]?.content), /prefer delegate_task/);
      if (++parents === 1) return calls({ name: "delegate_task", args: { task: "Focused child context" }, id: "parent-delegate" });
      assert.equal(body.messages.at(-1)?.role, "tool");
      assert.equal((body.messages.at(-1) as { tool_call_id: string }).tool_call_id, "parent-delegate");
      assert.match(String(body.messages.at(-1)?.content), /Child result: 42/);
      assert.ok(!JSON.stringify(body.messages).includes("child-sum"));
      return answer("Reviewed child result");
    }
    children++;
    assert.deepEqual(names, ["sum"]);
    assert.ok(!String(body.messages[0]?.content).includes("prefer delegate_task"));
    assert.ok(!JSON.stringify(body.messages).includes("Parent-only details"));
    assert.equal(body.messages[1]?.content, "Focused child context");
    if (children === 1) return calls({ name: "sum", args: { numbers: [17, 25] }, id: "child-sum" });
    assert.equal(body.messages.at(-1)?.content, '{"ok":true,"result":42}');
    return answer("Child result: 42");
  });
  assert.equal(await runAgent("Parent-only details", agent), "Reviewed child result");
  assert.equal(parents, 2);
  assert.equal(children, 2);
});

test("default delegation cannot turn a read-only workspace into write or shell access", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const base = await createTools(workspace);
  const agent = createAgent(config, base, async (input, init) => {
    const body = await new Request(input, init).json() as RequestBody;
    const parent = body.tools.some((tool) => tool.function.name === "delegate_task");
    if (parent) {
      if (body.messages.at(-1)?.role === "user") return calls({ name: "delegate_task", args: { task: "Try requested operations" }, id: "delegate" });
      return answer("Both operations denied");
    }
    assert.deepEqual(body.tools.map((tool) => tool.function.name), ["sum", "read", "write", "shell"]);
    if (body.messages.at(-1)?.role === "user") return calls(
      { name: "write", args: { path: "blocked.txt", content: "blocked" }, id: "child-write" },
      { name: "shell", args: { command: "exit 0" }, id: "child-shell" });
    const results = body.messages.filter((message) => message.role === "tool");
    assert.equal(results.length, 2);
    assert.ok(results.every((message) => String(message.content).includes("PERMISSION_DENIED")));
    return answer("Denied");
  });
  assert.equal(await runAgent("Try operations through a child", agent), "Both operations denied");
  assert.deepEqual(await readdir(workspace), []);
  assert.deepEqual(base.getWrites!(), []);
  assert.deepEqual(base.getCommands!(), []);
});


test("parent delegation guidance does not mutate or accumulate in caller history", async () => {
  let requests = 0;
  const agent = createAgent(config, undefined, async (input, init) => {
    const body = await new Request(input, init).json() as RequestBody;
    const system = String(body.messages[0]?.content);
    assert.equal((system.match(/prefer delegate_task/g) ?? []).length, 1);
    requests++;
    return answer("Ready");
  });
  const messages: Message[] = [{ role: "system", content: "Original role." }, { role: "user", content: "Hello" }];
  const before = structuredClone(messages);
  await agent.model(messages);
  await agent.model(messages);
  assert.deepEqual(messages, before);
  assert.equal(requests, 2);
});

test("canonical workspace context reaches parent and child without entering saved history", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const root = await realpath(workspace);
  const base = await createTools(join(workspace, "."));
  const skills = await discoverSkills({ workspace, userHome: join(workspace, "missing-home") });
  const guidance = `Workspace root (JSON string): ${JSON.stringify(root)}`;
  let parents = 0;
  let children = 0;
  const agent = createAgent(config, base, async (input, init) => {
    const body = await new Request(input, init).json() as RequestBody;
    const system = String(body.messages[0]?.content);
    assert.equal(system.split(guidance).length - 1, 1);
    assert.match(system, /Use relative paths with read, write, and shell cwd/);
    assert.ok(system.includes("skill://workspace-editing/SKILL.md"));
    if (body.tools.some((tool) => tool.function.name === "delegate_task")) {
      parents++;
      if (body.messages.at(-1)?.role === "user") {
        return calls({ name: "delegate_task", args: { task: "Identify the workspace from runtime context" }, id: "location" });
      }
      return answer("Workspace identified");
    }
    children++;
    return answer("Child received workspace context");
  }, skills);
  assert.equal(base.workspaceRoot, root);
  assert.equal(agent.tools.workspaceRoot, root);
  assert.equal(agent.tools.forTurn!().workspaceRoot, root);
  const first = await runAgentTurn("Identify the workspace", [], agent);
  const before = structuredClone(first.messages);
  const second = await runAgentTurn("Identify it again", first.messages, agent);
  assert.deepEqual(first.messages, before);
  for (const history of [first.messages, second.messages]) {
    assert.ok(!JSON.stringify(history).includes("Workspace root (JSON string):"));
  }
  await runAgent("Identify after a fresh history", agent);
  assert.equal(parents, 6);
  assert.equal(children, 3);
  assert.deepEqual(base.getWrites!(), []);
  assert.deepEqual(base.getCommands!(), []);
});
