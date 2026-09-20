import assert from "node:assert/strict";
import type { Message } from "../../src/model.js";

// Loaded only by CLI tests through Node's --import flag. No request reaches a network.
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  assert.equal(request.url, "https://api.deepseek.com/chat/completions");
  const { messages } = await request.json() as { messages: Message[] };
  const prompt = messages.findLast((message) => message.role === "user")?.content;
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
