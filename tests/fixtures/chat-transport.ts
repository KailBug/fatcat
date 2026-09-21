import assert from "node:assert/strict";
import type { Message } from "../../src/model.js";

// Loaded only by CLI tests through Node's --import flag. No request reaches a network.
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  assert.equal(request.url, "https://api.deepseek.com/chat/completions");
  const { messages, tools } = await request.json() as { messages: Message[]; tools: { function: { name: string } }[] };
  const prompt = messages.findLast((message) => message.role === "user")?.content;
  if (prompt === "delegate") {
    assert.ok(tools.some((tool) => tool.function.name === "delegate_task"));
    const last = messages.at(-1);
    if (last?.role === "user") {
      const task = tools.some((tool) => tool.function.name === "read_file") ? "workspace" : "add";
      return Response.json({ choices: [{ finish_reason: "tool_calls", message: {
        role: "assistant", content: null, tool_calls: [{ id: "delegated", type: "function",
          function: { name: "delegate_task", arguments: JSON.stringify({ task }) } }],
      } }] });
    }
    const value = JSON.parse(String(last?.content)) as { ok: boolean; result: { answer: string } };
    assert.equal(value.ok, true);
    return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: value.result.answer } }] });
  }
  if (prompt === "workspace" || prompt === "workspace blocked") {
    assert.deepEqual(tools.map((tool) => tool.function.name), ["sum", "list_directory", "read_file"]);
    const last = messages.at(-1);
    const list = prompt === "workspace" && last?.role === "user";
    if (last?.role === "user" || (last?.role === "tool" && last.tool_call_id === "list")) {
      const name = list ? "list_directory" : "read_file";
      const path = list ? "." : prompt === "workspace blocked" ? ".env" : "notes.txt";
      return Response.json({ choices: [{ finish_reason: "tool_calls", message: {
        role: "assistant", content: null,
        tool_calls: [{ id: list ? "list" : "read", type: "function", function: { name, arguments: JSON.stringify({ path }) } }],
      } }] });
    }
    assert.equal(last?.role, "tool");
    return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: last?.content } }] });
  }
  if (prompt === "fail") {
    return Response.json({ error: { message: "private-provider-secret" } }, { status: 500 });
  }
  if (prompt === "add" && messages.at(-1)?.role !== "tool") {
    return Response.json({ choices: [{ finish_reason: "tool_calls", message: {
      role: "assistant", content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "sum", arguments: '{"numbers":[17,25]}' } }],
    } }] });
  }
  const content = prompt === "history" ? JSON.stringify(messages.slice(1, -1)) : prompt === "add" ? "42" : String(prompt);
  return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] });
};
