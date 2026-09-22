import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { HarnessError } from "../src/errors.js";
import type { LoopEvent } from "../src/loop.js";
import type { Model, ModelTurn } from "../src/model.js";
import { Session } from "../src/session.js";
import { createSubagentTools } from "../src/subagent.js";
import { createTools } from "../src/tools.js";
import { temporaryWorkspace } from "./fixtures/workspace.js";

function call(name: string, args: unknown, id = "call-1"): ModelTurn {
  const toolCalls = [{ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }];
  return { message: { role: "assistant", content: null, tool_calls: toolCalls }, toolCalls };
}
const answer = (content: string): ModelTurn => ({ message: { role: "assistant", content }, toolCalls: [] });

test("failed, cancelled and exhausted turns retain writes without keeping broken tool history", async (t) => {
  for (const failureCode of ["MODEL_HTTP", "CANCELLED", "MAX_ITERATIONS"]) {
    const { workspace } = await temporaryWorkspace(t);
    const tools = await createTools(workspace, "workspace-write");
    const controller = new AbortController();
    const events: LoopEvent[] = [];
    const model: Model = async (messages) => {
      const prompt = messages.findLast((message) => message.role === "user")?.content;
      if (prompt === "Continue") {
        assert.ok(messages.some((message) => String(message.content).includes('"status":"committed"')));
        assert.ok(!messages.some((message) => message.content === "Create then fail"));
        assert.ok(!messages.some((message) => message.role === "tool"));
        return answer("The earlier write remains committed.");
      }
      if (messages.at(-1)?.role === "user") return call("write", { path: "created.txt", content: "written-once" });
      if (failureCode === "MAX_ITERATIONS") return call("write", { path: "not-created.txt", content: "no" }, "call-2");
      throw new HarnessError(failureCode, "Expected model failure.");
    };
    const session = new Session({ model, tools, maxIterations: 2 });
    await assert.rejects(session.run("Create then fail", { signal: controller.signal, onEvent(event) {
      events.push(event);
      if (event.type === "write_record" && failureCode === "CANCELLED") controller.abort();
    } }), (error: unknown) => error instanceof HarnessError && error.code === failureCode);
    assert.equal(await readFile(join(workspace, "created.txt"), "utf8"), "written-once");
    assert.deepEqual(await readdir(workspace), ["created.txt"]);
    assert.equal(events.filter((event) => event.type === "write_record").length, 1);
    assert.equal(tools.getWrites!()[0]!.status, "committed");
    assert.equal(await session.run("Continue"), "The earlier write remains committed.");
    session.reset();
    assert.equal(await session.run("Continue"), "The earlier write remains committed.");
    assert.equal(tools.getWrites!().length, 1);
  }
});

test("a failed child write turn remains visible to its parent", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const base = await createTools(workspace, "workspace-write");
  const child: Model = async (messages) => {
    if (messages.at(-1)?.role === "user") return call("write", { path: "child.txt", content: "child-change" });
    throw new HarnessError("MODEL_HTTP", "Expected child failure after committing.");
  };
  const tools = createSubagentTools(base, child, 3);
  const parent: Model = async (messages) => {
    if (messages.at(-1)?.role === "user") return call("delegate_task", { task: "Create the child file" });
    assert.match(String(messages.at(-1)?.content), /SUBAGENT_FAILED/);
    const records = messages.find((message) => String(message.content).startsWith("Harness workspace write records"));
    assert.ok(records);
    assert.match(String(records.content), /child.txt/);
    assert.match(String(records.content), /committed/);
    return answer("The child failed after its file change was committed.");
  };
  assert.match(await new Session({ model: parent, tools, maxIterations: 2 }).run("Delegate"), /committed/);
  assert.equal(await readFile(join(workspace, "child.txt"), "utf8"), "child-change");
  assert.equal(tools.getWrites!().length, 1);
});

test("child tools cannot elevate a parent's read-only permission", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const base = await createTools(workspace);
  const child: Model = async (messages) => {
    if (messages.at(-1)?.role === "user") return call("write", { path: "blocked.txt", content: "blocked" });
    assert.match(String(messages.at(-1)?.content), /PERMISSION_DENIED/);
    return answer("Writing was denied.");
  };
  const tools = createSubagentTools(base, child, 3);
  const result = await tools.execute("delegate_task", '{"task":"Try writing a file"}');
  assert.equal(result.ok, true);
  assert.deepEqual(await readdir(workspace), []);
  assert.deepEqual(tools.getWrites!(), []);
});

test("separate workspace tool instances do not share write records", async (t) => {
  const { workspace, outside } = await temporaryWorkspace(t);
  const first = await createTools(workspace, "workspace-write");
  const second = await createTools(outside, "workspace-write");
  await first.execute("write", '{"path":"first.txt","content":"first"}');
  assert.deepEqual(second.getWrites!(), []);
});
