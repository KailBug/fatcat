import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runChat } from "../src/chat.js";
import { HarnessError } from "../src/errors.js";
import type { Model, ModelTurn } from "../src/model.js";
import { Session } from "../src/session/session.js";
import { createSubagentTools } from "../src/subagent.js";
import { createTerminalInput } from "../src/terminal.js";
import { createTools } from "../src/tools.js";
import { temporaryWorkspace } from "./fixtures/workspace.js";

function terminalFixture(interactive = true, env: NodeJS.ProcessEnv = {}) {
  const input = Object.assign(new PassThrough(), { isTTY: interactive });
  const error = Object.assign(new PassThrough(), { isTTY: interactive });
  let text = "";
  error.on("data", (chunk: Buffer) => { text += chunk.toString(); });
  const terminal = createTerminalInput(input, error, undefined, env);
  async function waitFor(needle: string) {
    while (!text.includes(needle)) await once(error, "data", { signal: AbortSignal.timeout(5000) });
  }
  return { input, error, terminal, text: () => text, waitFor };
}
const final = (content: string): ModelTurn => ({ message: { role: "assistant", content }, toolCalls: [] });
function toolCall(name: string, args: unknown): ModelTurn {
  const toolCalls = [{ id: "write-call", type: "function" as const, function: { name, arguments: JSON.stringify(args) } }];
  return { message: { role: "assistant", content: null, tool_calls: toolCalls }, toolCalls };
}

test("chat approves one edit without sending the confirmation to the model", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await writeFile(join(workspace, "notes.txt"), "before");
  const io = terminalFixture();
  t.after(io.terminal.close);
  const tools = await createTools(workspace, "ask", io.terminal.approveWrite);
  const prompts: unknown[] = [];
  const model: Model = async (messages) => {
    prompts.push(messages.filter((message) => message.role === "user").map((message) => message.content));
    if (messages.at(-1)?.role === "user") return toolCall("write", { path: "notes.txt", oldText: "before", newText: "after" });
    assert.match(String(messages.at(-1)?.content), /"ok":true/);
    return final("Edited.");
  };
  const output = new PassThrough();
  let answer = "";
  output.on("data", (chunk: Buffer) => { answer += chunk.toString(); });
  const pending = runChat(new Session({ model, tools, maxIterations: 2 }), {
    input: io.input, output, error: io.error, terminal: io.terminal,
  });
  io.input.write("Edit the file\n");
  await io.waitFor("Allow this write? [yes/no]");
  assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "before");
  assert.deepEqual(await readdir(workspace), ["notes.txt"]);
  assert.equal(tools.getWrites!().length, 0);
  io.input.write("maybe\n");
  await io.waitFor("Please type yes or no.");
  assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "before");
  io.input.write("yes\n/exit\n");
  assert.equal(await pending, 0);
  assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "after");
  assert.equal(answer, "Edited.\n");
  assert.equal(prompts.length, 2);
  assert.ok(!prompts.flat().includes("yes"));
  assert.ok(!prompts.flat().includes("maybe"));
  assert.match(io.text(), /\x1b\[92mYou>\x1b\[0m/);
  assert.match(io.text(), /Replace: "before"/);
  assert.match(io.text(), /With: "after"/);
});

test("no denies the requested write and earlier queued text cannot grant approval", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const io = terminalFixture();
  t.after(io.terminal.close);
  io.input.write("yes\n");
  const tools = await createTools(workspace, "ask", io.terminal.approveWrite);
  const pending = tools.execute("write", '{"path":"new.txt","content":"new"}');
  await io.waitFor("Allow this write? [yes/no]");
  io.input.write("no\n");
  const result = await pending;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "PERMISSION_DENIED");
  assert.deepEqual(await readdir(workspace), []);
  assert.deepEqual(tools.getWrites!(), []);
  assert.equal(await io.terminal.readTask(), "yes");
});

test("every write needs fresh approval and changes made while waiting cause conflict", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await writeFile(join(workspace, "notes.txt"), "before");
  const io = terminalFixture();
  t.after(io.terminal.close);
  const tools = await createTools(workspace, "ask", io.terminal.approveWrite);
  const first = tools.execute("write", '{"path":"new.txt","content":"new"}');
  await io.waitFor("Allow this write? [yes/no]");
  io.input.write("yes\n");
  assert.equal((await first).ok, true);
  const second = tools.execute("write", '{"path":"notes.txt","oldText":"before","newText":"after"}');
  await io.waitFor('Replace: "before"');
  await writeFile(join(workspace, "notes.txt"), "user change while waiting");
  io.input.write("yes\n");
  const result = await second;
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "WRITE_CONFLICT");
  assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "user change while waiting");
  assert.deepEqual((await readdir(workspace)).sort(), ["new.txt", "notes.txt"]);
  assert.equal(tools.getWrites!().length, 1);
});

test("EOF and terminal Ctrl+C during approval cannot publish a file", async (t) => {
  for (const ending of ["eof", "cancel"]) {
    const { workspace } = await temporaryWorkspace(t);
    const io = terminalFixture();
    t.after(io.terminal.close);
    const tools = await createTools(workspace, "ask", io.terminal.approveWrite);
    const pending = tools.execute("write", '{"path":"new.txt","content":"new"}', io.terminal.signal);
    const outcome = ending === "cancel"
      ? assert.rejects(pending, (error: unknown) => error instanceof HarnessError && error.code === "CANCELLED")
      : pending.then((result) => { assert.equal(result.ok, false); });
    await io.waitFor("Allow this write? [yes/no]");
    if (ending === "cancel") io.input.write("\x03");
    else io.input.end();
    await outcome;
    assert.deepEqual(await readdir(workspace), []);
    assert.deepEqual(tools.getWrites!(), []);
    assert.equal(io.input.listenerCount("keypress"), 0);
  }
});

test("pipes cannot approve writes or receive colored prompts", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const io = terminalFixture(false);
  t.after(io.terminal.close);
  const tools = await createTools(workspace, "ask", io.terminal.approveWrite);
  io.input.write("yes\n");
  io.terminal.prompt();
  const result = await tools.execute("write", '{"path":"new.txt","content":"new"}');
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.error.message, /interactive terminal/);
  assert.deepEqual(await readdir(workspace), []);
  assert.equal(await io.terminal.readTask(), "yes");
  assert.equal(io.text(), "");
});

test("NO_COLOR and dumb terminals keep the chat prompt plain", (t) => {
  for (const env of [{ NO_COLOR: "" }, { TERM: "dumb" }]) {
    const io = terminalFixture(true, env);
    t.after(io.terminal.close);
    io.terminal.prompt();
    assert.ok(io.text().includes("You> "));
    assert.ok(!io.text().includes("\x1b[92m"));
  }
});

test("approval previews bound content and escape terminal controls", async (t) => {
  const io = terminalFixture();
  t.after(io.terminal.close);
  const pending = io.terminal.approveWrite({ path: "safe.txt", operation: "create", bytes: 3000,
    newText: "\x1b[31m\u009b" + "x".repeat(3000) });
  await io.waitFor("Allow this write? [yes/no]");
  assert.match(io.text(), /preview truncated/);
  assert.ok(io.text().includes("\\u001b[31m\\u009b"));
  assert.ok(!io.text().includes("\x1b[31m"));
  assert.ok(io.text().length < 1800);
  io.input.write("no\n");
  assert.equal(await pending, false);
});

test("invalid requests never prompt and explicit read-only cannot use an approval callback", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const approval = async () => { assert.fail("Invalid or forbidden writes must not request approval"); };
  const ask = await createTools(workspace, "ask", approval);
  for (const args of ['{"path":"../outside/new.txt","content":"bad"}', '{"path":"new.txt","content":1}']) {
    assert.equal((await ask.execute("write", args)).ok, false);
  }
  const readOnly = await createTools(workspace, "read-only", approval);
  assert.equal((await readOnly.execute("write", '{"path":"new.txt","content":"bad"}')).ok, false);
  assert.deepEqual(await readdir(workspace), []);
});

test("child writes use the same terminal approval without elevating permissions", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const io = terminalFixture();
  t.after(io.terminal.close);
  const base = await createTools(workspace, "ask", io.terminal.approveWrite);
  const child: Model = async (messages) => {
    if (messages.at(-1)?.role === "user") return toolCall("write", { path: "child.txt", content: "child" });
    assert.match(String(messages.at(-1)?.content), /"ok":true/);
    return final("Created after approval.");
  };
  const tools = createSubagentTools(base, child, 3);
  const pending = tools.execute("delegate_task", '{"task":"Create a file"}', io.terminal.signal);
  await io.waitFor("Allow this write? [yes/no]");
  assert.deepEqual(await readdir(workspace), []);
  io.input.write("yes\n");
  assert.equal((await pending).ok, true);
  assert.equal(await readFile(join(workspace, "child.txt"), "utf8"), "child");
});
