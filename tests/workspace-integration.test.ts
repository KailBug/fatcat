import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { createDeepSeekModel } from "../src/model.js";
import type { Message, Model } from "../src/model.js";
import { Session } from "../src/session.js";
import { createTools } from "../src/tools.js";
import { temporaryWorkspace } from "./fixtures/workspace.js";

test("SDK and Session return correlated workspace errors, recover, and retain file results", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await writeFile(join(workspace, "notes.txt"), "fixture-success");
  const tools = await createTools(workspace);
  let requests = 0;
  const model = createDeepSeekModel(loadConfig({ DEEPSEEK_API_KEY: "offline-only" }), async (input, init) => {
    const body = await new Request(input, init).json() as { messages: Message[]; tools: unknown[] };
    assert.deepEqual(body.tools, tools.definitions);
    requests++;
    if (requests === 2) {
      assert.deepEqual(body.messages.at(-1), { role: "tool", tool_call_id: "read-1", content: JSON.stringify({
        ok: false, error: { code: "NOT_FOUND", message: "The requested path does not exist." },
      }) });
    }
    if (requests <= 2) {
      return Response.json({ choices: [{ finish_reason: "tool_calls", message: {
        role: "assistant", content: null, tool_calls: [{ id: `read-${requests}`, type: "function",
          function: { name: "read", arguments: JSON.stringify({ path: requests === 1 ? "missing.txt" : "notes.txt" }) },
        }],
      } }] });
    }
    const result = body.messages.find((message) => message.role === "tool" && message.tool_call_id === "read-2");
    assert.deepEqual(result, { role: "tool", tool_call_id: "read-2", content: JSON.stringify({
      ok: true, result: { kind: "file", path: "notes.txt", offset: 0, totalLines: 1, startLine: 1, endLine: 1, content: "fixture-success", truncated: false, nextOffset: null },
    }) });
    return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "fixture-success" } }] });
  }, tools);
  const session = new Session({ model, tools, maxIterations: 3 });
  assert.equal(await session.run("Read my notes"), "fixture-success");
  assert.equal(await session.run("Repeat the value from before"), "fixture-success");
  assert.equal(requests, 4);
});

test("each Session keeps its own workspace, including after reset", async (t) => {
  const { workspace, outside } = await temporaryWorkspace(t);
  await writeFile(join(workspace, "notes.txt"), "first");
  await writeFile(join(outside, "notes.txt"), "second");
  const model: Model = async (messages) => {
    if (messages.at(-1)?.role === "user") {
      const toolCalls = [{ id: "read", type: "function" as const, function: { name: "read", arguments: '{"path":"notes.txt"}' } }];
      return { message: { role: "assistant", content: null, tool_calls: toolCalls }, toolCalls };
    }
    const result = JSON.parse(String(messages.at(-1)?.content)) as { result: { content: string } };
    return { message: { role: "assistant", content: result.result.content }, toolCalls: [] };
  };
  const first = new Session({ model, tools: await createTools(workspace), maxIterations: 2 });
  const second = new Session({ model, tools: await createTools(outside), maxIterations: 2 });
  assert.equal(await first.run("Read"), "first");
  assert.equal(await second.run("Read"), "second");
  first.reset();
  assert.equal(await first.run("Read again"), "first");
});

test("SDK and Session follow read continuations and preserve every correlated page", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await writeFile(join(workspace, "pages.txt"), "first\nsecond\nlast");
  const tools = await createTools(workspace);
  let requests = 0;
  const model = createDeepSeekModel(loadConfig({ DEEPSEEK_API_KEY: "offline-only" }), async (input, init) => {
    const body = await new Request(input, init).json() as { messages: Message[]; tools: unknown[] };
    assert.deepEqual(body.tools, tools.definitions);
    requests++;
    const pages = body.messages.filter((message) => message.role === "tool").map((message) => {
      assert.equal(message.role, "tool");
      return { id: message.tool_call_id, value: JSON.parse(String(message.content)).result };
    });
    if (pages.length === 3) {
      assert.deepEqual(pages.map((page) => page.id), ["page-0", "page-1", "page-2"]);
      assert.deepEqual(pages.map((page) => page.value.nextOffset), [1, 2, null]);
      assert.equal(pages.map((page) => page.value.content).join(""), "first\nsecond\nlast");
      return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "last" } }] });
    }
    const offset = pages.at(-1)?.value.nextOffset ?? 0;
    return Response.json({ choices: [{ finish_reason: "tool_calls", message: {
      role: "assistant", content: null, tool_calls: [{ id: `page-${offset}`, type: "function",
        function: { name: "read", arguments: JSON.stringify({ path: "pages.txt", offset, limit: 1 }) },
      }],
    } }] });
  }, tools);
  const session = new Session({ model, tools, maxIterations: 4 });
  assert.equal(await session.run("Read the final line one page at a time"), "last");
  assert.equal(await session.run("Repeat the last line"), "last");
  assert.equal(requests, 5);
});
