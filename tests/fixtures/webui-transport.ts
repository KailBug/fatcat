// Offline CLI/browser fixture. No model request reaches the network.
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  if (request.url !== "https://api.deepseek.com/chat/completions") throw new Error("Unexpected fixture endpoint.");
  const body = await request.json() as { messages: { role: string; content: string }[] };
  const prompt = body.messages.findLast((message) => message.role === "user")?.content ?? "";
  if (prompt === "Wait for cancellation") {
    await new Promise<void>((_resolve, reject) => {
      if (request.signal.aborted) { reject(new Error("Aborted")); return; }
      request.signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
    });
  }
  let message: unknown = { role: "assistant", content: "## Ready to build\nThis is an **offline preview** of Fatcat.\n\n- Workspace tools use the existing Agent Loop.\n- File changes and commands need your approval.\n\n```typescript\nconst message = 'Hello, \u4e16\u754c 👋';\nconsole.log(message);\n```\n\n<script>alert('untrusted')</script>\n[Unsafe link](javascript:alert)\n[Documentation](https://example.com)" };
  let finishReason = "stop";
  if (prompt === "Propose a file" && body.messages.at(-1)?.role === "user") {
    finishReason = "tool_calls";
    message = { role: "assistant", content: null, tool_calls: [{ id: "preview-write", type: "function", function: {
      name: "write", arguments: JSON.stringify({ path: "webui-preview.txt", content: "Offline approval preview\n" }),
    } }] };
  }
  return Response.json({ choices: [{ finish_reason: finishReason, message }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } });
};
