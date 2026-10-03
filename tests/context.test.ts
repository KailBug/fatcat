import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createAgent } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import { prepareRequestContext } from "../src/context.js";
import { createTurnReporter } from "../src/execution-report.js";
import type { ExecutionReport, ReportEvent } from "../src/execution-report.js";
import { createDeepSeekModel } from "../src/model.js";
import type { Message, ModelObservation } from "../src/model.js";
import { Session } from "../src/session/session.js";
import { createTools } from "../src/tools.js";
import { temporaryWorkspace } from "./fixtures/workspace.js";

const user = (content: string): Message => ({ role: "user", content });
const answer = (content = "Done"): Message => ({ role: "assistant", content });
function call(id: string, name = "read", args = { path: "notes.txt" }): Message {
  return { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] };
}
const result = (id: string, value: unknown): Message => ({ role: "tool", tool_call_id: id, content: JSON.stringify(value) });
const file = (text: string) => ({ ok: true, result: { kind: "file", path: "notes.txt", content: text,
  offset: 0, totalLines: 1, startLine: 1, endLine: 1, truncated: false, nextOffset: null } });
const hasOmission = (messages: Message[]) => messages.some((message) => message.role === "tool"
  && typeof message.content === "string" && JSON.parse(message.content)?.result?.kind === "context_omitted");
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
function history(): Message[] {
  return [{ role: "system", content: "System rules" }, user("Keep user requirement A"), call("repeat"),
    result("repeat", file("old-private-text-" + "\"\\\u4e2d\u6587".repeat(1000))), answer("Earlier claim"),
    user("Keep recent requirement B"), call("repeat"), result("repeat", file("recent-content")), answer(), user("Current requirement C")];
}
function capture() {
  const events: ReportEvent[] = [];
  const onEvent = createTurnReporter((event) => events.push(event));
  return { events, onEvent, report(): ExecutionReport {
    const reports = events.filter((event) => event.type === "execution_report");
    assert.equal(reports.length, 1);
    return reports[0]!.report;
  } };
}
const config = loadConfig({ DEEPSEEK_API_KEY: "offline-context-only" });
const response = (content = "Done") => Response.json({ choices: [{ finish_reason: "stop", message: answer(content) }] });
const responseCall = (id: string, args: { path: string; offset?: number; limit?: number }) =>
  Response.json({ choices: [{ finish_reason: "tool_calls", message: call(id, "read", args) }] });

test("under-budget bodies keep exact content and references without unnecessary reduction", () => {
  const body = { model: "fixture", messages: history(), tools: [{ definition: "x".repeat(500) }] };
  const snapshot = structuredClone(body);
  const prepared = prepareRequestContext(body, bytes(body));
  assert.equal(prepared.body, body);
  assert.equal(prepared.omittedReadResults, 0);
  assert.equal(prepared.bytes, bytes(body));
  assert.deepEqual(body, snapshot);
});

test("over-budget projection preserves requirements, recent/current turns and call association without mutating history", () => {
  const body = { messages: [...history(), call("current"), result("current", file("current-content"))], extra: "Keep settings" };
  const snapshot = structuredClone(body);
  for (const message of body.messages) Object.freeze(message);
  Object.freeze(body.messages);
  Object.freeze(body);
  const prepared = prepareRequestContext(body, 1);
  assert.equal(prepared.omittedReadResults, 1);
  assert.equal(prepared.beforeBytes, bytes(snapshot));
  assert.equal(prepared.bytes, bytes(prepared.body));
  assert.ok(prepared.bytes < prepared.beforeBytes);
  assert.deepEqual(body, snapshot);
  assert.deepEqual(prepared.body.messages.filter((message) => message.role !== "tool"), body.messages.filter((message) => message.role !== "tool"));
  const outputs = prepared.body.messages.filter((message) => message.role === "tool");
  assert.deepEqual(outputs.map((message) => message.tool_call_id), ["repeat", "repeat", "current"]);
  assert.match(String(outputs[0]!.content), /context_omitted/);
  assert.ok(!String(outputs[0]!.content).includes("old-private-text"));
  assert.equal(outputs[1], body.messages[7]);
  assert.equal(outputs[2], body.messages.at(-1));
});

test("the oldest eligible reads are reduced only until the exact full-body budget is met", () => {
  const messages: Message[] = [{ role: "system", content: "Rules" }, user("Old task")];
  for (const id of ["first", "second", "third"]) messages.push(call(id), result(id, file("x".repeat(2000))));
  messages.push(answer(), user("Recent"), answer(), user("Current"));
  const body = { messages, tools: [{ description: "schema".repeat(100) }] };
  const smallest = prepareRequestContext(body, 1);
  assert.equal(smallest.omittedReadResults, 3);
  const target = { ...body, messages: [...messages] };
  target.messages[3] = smallest.body.messages[3]!;
  const prepared = prepareRequestContext(body, bytes(target));
  assert.equal(prepared.omittedReadResults, 1);
  assert.equal(prepared.bytes, bytes(target));
  assert.deepEqual(prepared.body, target);
});

test("only paired successful reads with known payload forms can be omitted", () => {
  const messages: Message[] = [user("Old task")];
  for (const [id, name, value] of [
    ["write", "write", file("x".repeat(2000))], ["shell", "shell", file("x".repeat(2000))],
    ["error", "read", { ok: false, error: { message: "x".repeat(2000) } }],
    ["unknown", "read", { ok: true, result: { kind: "other", path: "notes.txt", content: "x".repeat(2000) } }],
    ["malformed", "read", { ok: true, result: { kind: ["file"], path: "notes.txt", content: "x".repeat(2000) } }],
    ["missing", "read", { ok: true, result: { kind: "file", path: "notes.txt", text: "x".repeat(2000) } }],
    ["small", "read", file("tiny")],
  ] as const) messages.push(call(id, name), result(id, value));
  messages.push(result("unpaired", file("x".repeat(2000))), answer(), user("Recent"), answer(), user("Current"));
  const body = { messages };
  assert.deepEqual(prepareRequestContext(body, 1), { body, beforeBytes: bytes(body), bytes: bytes(body), omittedReadResults: 0 });
  // Reused IDs are resolved against their local call, never against a global name lookup.
  messages.splice(1, 0, call("shell"), result("shell", file("old read".repeat(500))));
  assert.equal(prepareRequestContext(body, 1).omittedReadResults, 1);
});

test("directory and search payloads can be omitted while transient execution records remain intact", () => {
  const facts = user("Harness command records: " + "facts".repeat(500));
  const messages: Message[] = [{ role: "system", content: "Rules" }, facts, user("Old"), call("directory"),
    result("directory", { ok: true, result: { kind: "directory", path: ".", entries: [{ name: "x".repeat(1500), type: "file" }] } }),
    call("search"), result("search", { ok: true, result: { kind: "search", path: ".", matches: [{ path: "notes.txt", line: 1, text: "x".repeat(1500) }], complete: false } }),
    answer(), user("Recent"), answer(), user("Current")];
  const prepared = prepareRequestContext({ messages }, 1);
  assert.equal(prepared.omittedReadResults, 2);
  assert.equal(prepared.body.messages[1], facts);
  const outputs = prepared.body.messages.filter((message) => message.role === "tool");
  for (const output of outputs) assert.equal(JSON.parse(String(output.content)).result.kind, "context_omitted");
});

test("single-turn children, the latest completed turn and incomplete old boundaries are protected", () => {
  for (const messages of [
    [user("Current"), call("a"), result("a", file("x".repeat(5000)))],
    [user("Recent"), call("a"), result("a", file("x".repeat(5000))), answer(), user("Current")],
    [user("Old incomplete"), call("a"), result("a", file("x".repeat(5000))), user("Recent"), answer(), user("Current")],
  ]) assert.equal(prepareRequestContext({ messages }, 1).omittedReadResults, 0);
  const controller = new AbortController();
  controller.abort();
  assert.throws(() => prepareRequestContext({ messages: history() }, 1, controller.signal), { code: "CANCELLED" });
});

test("SDK sends a reduced projection once, keeps full request limits, and reports metadata only", async () => {
  let sent = 0;
  const observations: ModelObservation[] = [];
  const messages = history();
  const snapshot = structuredClone(messages);
  const model = createDeepSeekModel({ ...config, maxRequestBytes: 3500 }, async (input, init) => {
    const text = await new Request(input, init).text();
    assert.ok(Buffer.byteLength(text) <= 3500);
    assert.match(text, /context_omitted/);
    assert.ok(!text.includes("old-private-text"));
    sent++;
    return response();
  });
  await model(messages, undefined, (event) => observations.push(event));
  assert.equal(sent, 1);
  assert.deepEqual(messages, snapshot);
  const reduction = observations.find((event) => event.type === "context_reduction")!;
  const measured = observations.find((event) => event.type === "model_input")!;
  assert.equal(reduction.afterBytes, measured.bytes);
  assert.equal(reduction.omittedReadResults, 1);
  assert.ok(!JSON.stringify(observations).includes("notes.txt"));
  assert.ok(!JSON.stringify(observations).includes("old-private-text"));
  const failed: ModelObservation[] = [];
  await assert.rejects(createDeepSeekModel({ ...config, maxRequestBytes: 1 }, async () => { throw new Error("Must not send"); })(messages, undefined,
    (event) => failed.push(event)), { code: "MODEL_CONTEXT_LIMIT" });
  assert.equal(failed.find((event) => event.type === "model_input")!.accepted, false);
  assert.equal(failed.find((event) => event.type === "context_reduction")!.omittedReadResults, 1);
});

test("a multi-turn session rereads changed content after omission and reset removes historical reduction", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const source = "old-first-line\n" + "x".repeat(12000);
  await writeFile(join(workspace, "notes.txt"), source);
  const tools = await createTools(workspace);
  let thirdRequests = 0;
  const agent = createAgent({ ...config, maxRequestBytes: 28000 }, tools, async (input, init) => {
    const payload = await new Request(input, init).text();
    assert.ok(Buffer.byteLength(payload) <= 28000);
    const body = JSON.parse(payload) as { messages: Message[] };
    const prompt = String(body.messages.findLast((message) => message.role === "user")?.content);
    const last = body.messages.at(-1)!;
    if (prompt === "first") return last.role === "user" ? responseCall("shared-id", { path: "notes.txt" }) : response("Loaded");
    if (prompt === "second: preserve this constraint") return response("Understood");
    if (prompt === "fresh") {
      assert.equal(hasOmission(body.messages), false);
      return response("Fresh");
    }
    thirdRequests++;
    assert.equal(hasOmission(body.messages), true);
    assert.match(payload, /preserve this constraint/);
    if (last.role === "user") return responseCall("shared-id", { path: "notes.txt", limit: 1 });
    assert.match(String(last.content), /new-first-line/);
    return response("new-first-line");
  });
  const session = new Session(agent);
  await session.run("first");
  await session.run("second: preserve this constraint");
  await writeFile(join(workspace, "notes.txt"), "new-first-line\n" + "x".repeat(12000));
  const captureTurn = capture();
  assert.equal(await session.run("third " + "padding ".repeat(875), { onEvent: captureTurn.onEvent }), "new-first-line");
  assert.equal(thirdRequests, 2);
  assert.equal(captureTurn.report().contextReduction.parent.requests, 2);
  assert.equal(captureTurn.report().contextReduction.parent.omittedReadResults, 2);
  assert.ok(captureTurn.report().contextReduction.parent.bytesSaved > 20000);
  assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "new-first-line\n" + "x".repeat(12000));
  session.reset();
  const fresh = capture();
  await session.run("fresh", { onEvent: fresh.onEvent });
  assert.equal(fresh.report().contextReduction.parent.requests, 0);
  assert.deepEqual(tools.getWrites!(), []);
  assert.deepEqual(tools.getCommands!(), []);
});

test("failed requests cannot persist omitted markers into later session history", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await writeFile(join(workspace, "notes.txt"), "original-body\n" + "x".repeat(12000));
  let fail = false;
  const agent = createAgent({ ...config, maxRequestBytes: 28000 }, await createTools(workspace), async (input, init) => {
    const body = await new Request(input, init).json() as { messages: Message[] };
    const prompt = String(body.messages.findLast((message) => message.role === "user")?.content);
    if (fail) {
      assert.equal(hasOmission(body.messages), true);
      return Response.json({ error: { message: "private" } }, { status: 500 });
    }
    if (prompt === "read") return body.messages.at(-1)?.role === "user" ? responseCall("read", { path: "notes.txt" }) : response("Loaded");
    assert.match(JSON.stringify(body.messages), /original-body/);
    assert.equal(hasOmission(body.messages), false);
    return response();
  });
  const session = new Session(agent);
  await session.run("read");
  await session.run("recent");
  fail = true;
  const failed = capture();
  await assert.rejects(session.run("padding ".repeat(875), { onEvent: failed.onEvent }), { code: "MODEL_HTTP" });
  assert.equal(failed.report().contextReduction.parent.requests, 1);
  fail = false;
  await session.run("short follow-up");
});
