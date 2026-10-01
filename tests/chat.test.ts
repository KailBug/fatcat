import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import { runChat } from "../src/chat.js";
import { HarnessError } from "../src/errors.js";
import type { Model } from "../src/model.js";
import { Session } from "../src/session/session.js";
import type { SkillDescriptor } from "../src/skills.js";

function capture() {
  const stream = new PassThrough();
  let text = "";
  stream.on("data", (chunk: Buffer) => { text += chunk.toString(); });
  return { stream, text: () => text };
}

test("local commands and blank lines do not call the model", async () => {
  const session = new Session({ maxIterations: 1, model: async () => { assert.fail("Unexpected model call"); } });
  const output = capture();
  const error = capture();
  const status = await runChat(session, {
    input: Readable.from(["\r\n/help\r\n/reset\r\n/unknown\r\n/exit\r\nIgnored after exit\r\n"]),
    output: output.stream, error: error.stream,
  });
  assert.equal(status, 0);
  assert.equal(output.text(), "");
  assert.match(error.text(), /History cleared/);
  assert.match(error.text(), /Unknown command/);
});

test("skills lists local metadata without model calls or history changes and rejects arguments", async () => {
  const skills: SkillDescriptor[] = [
    { name: "fixture-review", description: "Review the local fixture.", uri: "skill://fixture-review/SKILL.md", scope: "workspace" },
    { name: "workspace-editing", description: "Edit workspace files.", uri: "skill://workspace-editing/SKILL.md", scope: "builtin", subsystem: "tools" },
  ];
  const prompts: string[] = [];
  const session = new Session({ maxIterations: 1, model: async (messages) => {
    const prompt = String(messages.at(-1)?.content);
    prompts.push(prompt);
    assert.ok(!JSON.stringify(messages).includes("/skills"));
    return { message: { role: "assistant", content: "Done" }, toolCalls: [] };
  } });
  await session.run("First");
  const saved = session.messages;
  const output = capture();
  const error = capture();
  const localStatus = await runChat(session, {
    input: Readable.from(["/skills\n/skills unexpected\n/help\n/exit\n"]),
    output: output.stream, error: error.stream, skills,
  });
  assert.equal(localStatus, 0);
  assert.deepEqual(prompts, ["First"]);
  assert.deepEqual(session.messages, saved);
  assert.equal(output.text(), "");
  for (const skill of skills) {
    assert.ok(error.text().includes(skill.name));
    assert.ok(error.text().includes(skill.description));
    assert.ok(error.text().includes(skill.uri));
    assert.ok(error.text().includes(skill.scope));
  }
  assert.match(error.text(), /Error \[USAGE\]/);
  assert.match(error.text(), /\/skills/);
  assert.ok(!error.text().includes('"type":"execution_report"'));
  assert.equal(await runChat(session, {
    input: Readable.from(["Next\n/exit\n"]), output: output.stream, error: error.stream, skills,
  }), 0);
  assert.deepEqual(prompts, ["First", "Next"]);
  assert.equal(session.messages.length, saved.length + 2);
});

test("queued input survives a slow turn and failures allow later lines through EOF", async () => {
  const prompts: unknown[] = [];
  const model: Model = async (messages) => {
    const prompt = messages.at(-1)?.content;
    prompts.push(prompt);
    await new Promise((resolve) => setImmediate(resolve));
    if (prompt === "Fail") throw new Error("private provider information");
    assert.ok(!JSON.stringify(messages).includes("Fail"));
    return { message: { role: "assistant", content: "Done" }, toolCalls: [] };
  };
  const output = capture();
  const error = capture();
  const status = await runChat(new Session({ model, maxIterations: 1 }), {
    input: Readable.from(["First\nFail\nThird"]), output: output.stream, error: error.stream,
  });
  assert.equal(status, 1);
  assert.deepEqual(prompts, ["First", "Fail", "Third"]);
  assert.equal(output.text(), "Done\nDone\n");
  assert.match(error.text(), /Error \[INTERNAL\]/);
  assert.ok(!error.text().includes("private provider information"));
  assert.match(error.text(), /"turn":3,"type":"completed"/);
});

test("cancellation closes an idle chat and releases its input listener", async () => {
  const input = new PassThrough();
  const controller = new AbortController();
  const output = capture();
  const session = new Session({ maxIterations: 1, model: async () => { assert.fail("Unexpected model call"); } });
  const pending = runChat(session, { input, output: output.stream, error: output.stream, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof HarnessError && error.code === "CANCELLED");
  assert.equal(input.listenerCount("data"), 0);
  await assert.rejects(runChat(session, {
    input, output: output.stream, error: output.stream, signal: controller.signal,
  }), /cancelled/);
});

test("cancellation during a model request exits without consuming later queued tasks", async () => {
  const controller = new AbortController();
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  let calls = 0;
  const session = new Session({ maxIterations: 1, model: async (_messages, signal) => {
    calls++;
    started();
    return new Promise((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new HarnessError("CANCELLED", "Run cancelled.")), { once: true });
    });
  } });
  const output = capture();
  const error = capture();
  const pending = runChat(session, {
    input: Readable.from(["First\nNever run\n"]), output: output.stream, error: error.stream, signal: controller.signal,
  });
  await ready;
  controller.abort();
  await assert.rejects(pending, /cancelled/);
  assert.equal(calls, 1);
  assert.equal(output.text(), "");
  const reports = error.text().split("\n").filter((line) => line.includes('"type":"execution_report"'));
  assert.equal(reports.length, 1);
  assert.equal(JSON.parse(reports[0]!).report.stopCode, "CANCELLED");
  session.reset();
});

test("readline handles the terminal Ctrl+C byte as cancellation", async () => {
  const rawModes: boolean[] = [];
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: (enabled: boolean) => rawModes.push(enabled) });
  const error = Object.assign(new PassThrough(), { isTTY: true });
  const session = new Session({ maxIterations: 1, model: async () => { assert.fail("Unexpected model call"); } });
  const pending = runChat(session, { input, output: new PassThrough(), error });
  input.write("\x03");
  await assert.rejects(pending, /cancelled/);
  assert.equal(input.listenerCount("keypress"), 0);
  assert.deepEqual(rawModes, [true, false]);
  assert.equal(input.isPaused(), true);
});
