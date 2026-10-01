import assert from "node:assert/strict";
import type { Message } from "../../src/model.js";

// Loaded only by CLI tests through Node's --import flag. No request reaches a network.
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  assert.equal(request.url, "https://api.deepseek.com/chat/completions");
  const { messages, tools } = await request.json() as { messages: Message[]; tools: { function: { name: string; description: string } }[] };
  const webPrompt = messages.findLast((message) => message.role === "user")?.content;
  if (webPrompt === "web permission" || webPrompt === "web denied") {
    const web = tools.find((tool) => tool.function.name === "web");
    assert.ok(web);
    if (webPrompt === "web permission") return Response.json({ choices: [{ finish_reason: "stop", message: {
      role: "assistant", content: web.function.description.includes("Web permission: allow") ? "WEB_ALLOWED" : "WEB_DENIED",
    } }] });
    if (messages.at(-1)?.role === "user") return Response.json({ choices: [{ finish_reason: "tool_calls", message: {
      role: "assistant", content: null, tool_calls: [{ id: "web-denied", type: "function", function: {
        name: "web", arguments: JSON.stringify({ action: "search", query: "public news" }),
      } }],
    } }] });
    assert.match(String(messages.at(-1)?.content), /PERMISSION_DENIED/);
    return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "WEB_DENIED" } }] });
  }
  if (process.env.FATCAT_TEST_WORKSPACE_ROOT !== undefined) {
    const rootPrefix = "Workspace root (JSON string): ";
    const rootLines = String(messages[0]?.content).split("\n").filter((line) => line.startsWith(rootPrefix));
    assert.deepEqual(rootLines, [rootPrefix + JSON.stringify(process.env.FATCAT_TEST_WORKSPACE_ROOT)]);
    assert.ok(messages.slice(1).every((message) => !String(message.content).includes(rootPrefix)));
  }
  const prompt = messages.findLast((message) => message.role === "user")?.content;
  if (prompt === "workspace location") {
    assert.deepEqual(tools.filter((tool) => tool.function.name !== "delegate_task").map((tool) => tool.function.name), ["sum", "read", "write", "shell", "web"]);
    const prefix = "Workspace root (JSON string): ";
    const rootLines = String(messages[0]?.content).split("\n").filter((line) => line.startsWith(prefix));
    assert.equal(rootLines.length, 1);
    const root = JSON.parse(rootLines[0]!.slice(prefix.length));
    return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(root) } }] });
  }
  if (prompt === "skill load" || prompt === "skill recall") {
    assert.ok(String(messages[0]?.content).includes("skill://review-fixture/SKILL.md"));
    assert.ok(!String(messages[0]?.content).includes("PRIVATE_SKILL_BODY"));
    if (prompt === "skill load" && messages.at(-1)?.role === "user") return Response.json({ choices: [{ finish_reason: "tool_calls", message: {
      role: "assistant", content: null, tool_calls: [{ id: "skill-read", type: "function", function: {
        name: "read", arguments: JSON.stringify({ path: "skill://review-fixture/SKILL.md" }),
      } }],
    } }] });
    const loaded = messages.some((message) => message.role === "tool" && String(message.content).includes("PRIVATE_SKILL_BODY"));
    if (prompt === "skill load") assert.ok(loaded);
    return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant",
      content: prompt === "skill load" ? "SKILL_LOADED" : loaded ? "SKILL_PRESENT" : "SKILL_ABSENT" } }] });
  }
  if (prompt === "context load") {
    if (messages.at(-1)?.role === "user") return Response.json({ choices: [{ finish_reason: "tool_calls", message: {
      role: "assistant", content: null, tool_calls: [{ id: "context-load", type: "function", function: {
        name: "read", arguments: JSON.stringify({ path: "notes.txt" }),
      } }],
    } }] });
    return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Loaded" } }] });
  }
  if (typeof prompt === "string" && prompt.startsWith("context recall ")) {
    const omitted = messages.find((message) => message.role === "tool"
      && JSON.parse(String(message.content))?.result?.kind === "context_omitted");
    assert.ok(omitted);
    assert.ok(messages.some((message) => message.role === "user" && message.content === "keep-context-rule"));
    const last = messages.at(-1)!;
    if (last.role === "user") return Response.json({ choices: [{ finish_reason: "tool_calls", message: {
      role: "assistant", content: null, tool_calls: [{ id: "context-read", type: "function", function: {
        name: "read", arguments: JSON.stringify({ path: "notes.txt", limit: 1 }),
      } }],
    } }] });
    const content = JSON.parse(String(last.content)).result.content;
    return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] });
  }
  if (prompt === "usage fixture") return Response.json({
    usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 },
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Usage recorded." } }],
  });
  if (prompt === "shell fixture" || prompt === "shell cwd" || prompt === "dangerous shell fixture") {
    const last = messages.at(-1);
    if (last?.role === "user") return Response.json({ choices: [{ finish_reason: "tool_calls", message: {
      role: "assistant", content: null, tool_calls: [{ id: "shell-1", type: "function",
        function: { name: "shell", arguments: JSON.stringify({ command: prompt === "shell cwd" ? "(Get-Location).Path"
          : prompt === "dangerous shell fixture" ? "Invoke-Expression" : "'CLI_COMMAND_READY'" }) } }],
    } }] });
    return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: String(last?.content) } }] });
  }
  if (prompt === "write fixture" || prompt === "write then fail") {
    const last = messages.at(-1);
    if (last?.role === "user" || (last?.role === "tool" && last.tool_call_id === "inspect")) {
      const reading = last?.role === "user";
      const args = reading ? { path: "notes.txt" } : { path: "notes.txt", oldText: "before", newText: "after" };
      return Response.json({ choices: [{ finish_reason: "tool_calls", message: {
        role: "assistant", content: null, tool_calls: [{ id: reading ? "inspect" : "edit", type: "function",
          function: { name: reading ? "read" : "write", arguments: JSON.stringify(args) } }],
      } }] });
    }
    if (prompt === "write then fail") return Response.json({ error: { message: "offline failure" } }, { status: 500 });
    return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: String(last?.content) } }] });
  }
  if (prompt === "write records") {
    const record = messages.find((message) => String(message.content).startsWith("Harness workspace write records"));
    assert.ok(record);
    assert.match(String(record.content), /committed/);
    return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Earlier write is recorded." } }] });
  }
  if (prompt === "delegate" || prompt === "delegate write" || prompt === "delegate workspace") {
    assert.ok(tools.some((tool) => tool.function.name === "delegate_task"));
    const last = messages.at(-1);
    if (last?.role === "user") {
      const task = prompt === "delegate write" ? "write fixture" : prompt === "delegate workspace" ? "workspace" : "add";
      return Response.json({ choices: [{ finish_reason: "tool_calls", message: {
        role: "assistant", content: null, tool_calls: [{ id: "delegated", type: "function",
          function: { name: "delegate_task", arguments: JSON.stringify({ task }) } }],
      } }] });
    }
    const value = JSON.parse(String(last?.content)) as { ok: boolean; result: { answer: string } };
    assert.equal(value.ok, true);
    return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: value.result.answer } }] });
  }
  if (prompt === "workspace pages") {
    assert.deepEqual(tools.filter((tool) => tool.function.name !== "delegate_task").map((tool) => tool.function.name), ["sum", "read", "write", "shell", "web"]);
    const last = messages.at(-1);
    const previous = last?.role === "tool" ? JSON.parse(String(last.content)).result : undefined;
    if (previous?.nextOffset === null) {
      const content = messages.filter((message) => message.role === "tool")
        .map((message) => JSON.parse(String(message.content)).result.content).join("");
      return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] });
    }
    const offset = previous?.nextOffset ?? 0;
    return Response.json({ choices: [{ finish_reason: "tool_calls", message: {
      role: "assistant", content: null, tool_calls: [{ id: `page-${offset}`, type: "function",
        function: { name: "read", arguments: JSON.stringify({ path: "notes.txt", offset, limit: 1 }) },
      }],
    } }] });
  }
  if (prompt === "workspace search") {
    const last = messages.at(-1);
    const previous = last?.role === "tool" ? JSON.parse(String(last.content)).result : undefined;
    if (previous?.nextOffset === null) {
      const matches = messages.filter((message) => message.role === "tool")
        .flatMap((message) => JSON.parse(String(message.content)).result.matches);
      return Response.json({ choices: [{ finish_reason: "stop", message: {
        role: "assistant", content: JSON.stringify(matches),
      } }] });
    }
    const offset = previous?.nextOffset ?? 0;
    return Response.json({ choices: [{ finish_reason: "tool_calls", message: {
      role: "assistant", content: null, tool_calls: [{ id: `search-${offset}`, type: "function",
        function: { name: "read", arguments: JSON.stringify({ path: ".", query: "SEARCH_TOKEN", offset, limit: 1 }) },
      }],
    } }] });
  }
  if (prompt === "workspace" || prompt === "workspace blocked") {
    assert.deepEqual(tools.filter((tool) => tool.function.name !== "delegate_task").map((tool) => tool.function.name), ["sum", "read", "write", "shell", "web"]);
    const last = messages.at(-1);
    const list = prompt === "workspace" && last?.role === "user";
    if (last?.role === "user" || (last?.role === "tool" && last.tool_call_id === "list")) {
      const name = "read";
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
