import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { HarnessError } from "../src/errors.js";
import type { LoopEvent } from "../src/loop.js";
import type { Model, ModelTurn } from "../src/model.js";
import { Session } from "../src/session/session.js";
import { createSubagentTools } from "../src/subagent.js";
import { createTools } from "../src/tools.js";
import { temporaryWorkspace } from "./fixtures/workspace.js";

const windows = { skip: process.platform !== "win32" };
const answer = (content: string): ModelTurn => ({ message: { role: "assistant", content }, toolCalls: [] });
function call(name: string, args: unknown): ModelTurn {
  const toolCalls = [{ id: "execute-1", type: "function" as const, function: { name, arguments: JSON.stringify(args) } }];
  return { message: { role: "assistant", content: null, tool_calls: toolCalls }, toolCalls };
}

test("shell facts survive failed turns and reset while logs omit command and output", windows, async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const tools = await createTools(workspace, "workspace-write", undefined, { permission: "allow" });
  const events: LoopEvent[] = [];
  const model: Model = async (messages) => {
    if (messages.at(-1)?.content === "Continue") {
      const context = messages.find((message) => String(message.content).startsWith("Harness command records"));
      assert.ok(context);
      assert.match(String(context.content), /command-evidence/);
      assert.match(String(context.content), /completed/);
      assert.ok(!messages.some((message) => message.role === "tool"));
      return answer("Command completed before the earlier failure.");
    }
    if (messages.at(-1)?.role === "user") return call("shell", { command: "[IO.File]::WriteAllText((Join-Path (Get-Location) 'evidence.txt'), 'command-evidence'); 'command-evidence'" });
    throw new HarnessError("MODEL_HTTP", "Expected failure after command completion.");
  };
  const session = new Session({ tools, model, maxIterations: 3 });
  await assert.rejects(session.run("Execute then fail", { onEvent: (event) => events.push(event) }), /Expected failure/);
  assert.equal(await readFile(join(workspace, "evidence.txt"), "utf8"), "command-evidence");
  assert.ok(!JSON.stringify(events).includes("command-evidence"));
  assert.equal(events.filter((event) => event.type === "shell_record").length, 1);
  session.reset();
  assert.match(await session.run("Continue"), /completed/);
  assert.equal(tools.getCommands!().length, 1);
});

test("a child inherits shell approval and its failed turn cannot hide executed commands", windows, async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  let approved = 0;
  const base = await createTools(workspace, "ask", undefined, { permission: "ask", approve: async () => { approved++; return true; } });
  const child: Model = async (messages) => {
    if (messages.at(-1)?.role === "user") return call("shell", { command: "'child-command-evidence'" });
    throw new HarnessError("MODEL_HTTP", "Expected child failure.");
  };
  const tools = createSubagentTools(base, child, 3);
  const parent: Model = async (messages) => {
    if (messages.at(-1)?.role === "user") return call("delegate_task", { task: "Run verification" });
    assert.match(String(messages.at(-1)?.content), /SUBAGENT_FAILED/);
    assert.ok(messages.some((message) => String(message.content).includes("child-command-evidence")));
    return answer("Child command completed before its model failed.");
  };
  await new Session({ model: parent, tools, maxIterations: 2 }).run("Delegate");
  assert.equal(approved, 1);
  assert.equal(tools.getCommands!()[0]!.exitCode, 0);
  const deniedBase = await createTools(workspace);
  const denied = createSubagentTools(deniedBase, async (messages) => {
    if (messages.at(-1)?.role === "user") return call("shell", { command: "exit 0" });
    assert.match(String(messages.at(-1)?.content), /PERMISSION_DENIED/);
    return answer("Denied");
  }, 3);
  await denied.execute("delegate_task", '{"task":"Try shell"}');
  assert.deepEqual(denied.getCommands!(), []);
});
