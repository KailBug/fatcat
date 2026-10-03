import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createAgent } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import { automationCommandPrompt, runInteractiveCommand } from "../src/commands.js";
import { ConversationAutomations } from "../src/automation/conversations.js";
import type { Message, ModelTurn } from "../src/model.js";
import { SessionManager } from "../src/session/manager.js";
import { SessionStore } from "../src/session/store.js";
import { createTools } from "../src/tools.js";
import { temporaryWorkspace } from "./fixtures/workspace.js";

const answer = (content = "Ready"): ModelTurn => ({ message: { role: "assistant", content }, toolCalls: [] });
function tool(args: unknown): ModelTurn {
  const toolCalls = [{ id: "schedule", type: "function" as const, function: { name: "automation", arguments: JSON.stringify(args) } }];
  return { message: { role: "assistant", content: null, tool_calls: toolCalls }, toolCalls };
}
const task = { prompt: "Review changes", trigger: { type: "interval", seconds: 60 }, maxRuns: 3 };

test("SDK scheduling tool binds to current saved session and recurring turns retain that history", async (t) => {
  const { base, workspace } = await temporaryWorkspace(t);
  const store = new SessionStore({ root: join(base, "sessions") });
  const seen: Message[][] = [];
  const agent = createAgent(loadConfig({ DEEPSEEK_API_KEY: "offline-schedule-only", HARNESS_MAX_ITERATIONS: "3" }),
    await createTools(workspace), async (input, init) => {
      const body = await new Request(input, init).json() as { messages: Message[]; tools: { function: { name: string } }[] };
      seen.push(body.messages);
      assert.ok(body.tools.some((item) => item.function.name === "automation"));
      const latest = body.messages.at(-1);
      const response = latest?.role === "user" && latest.content === "Check every minute"
        ? tool({ action: "create", ...task }) : answer();
      return Response.json({ choices: [{ finish_reason: response.toolCalls.length ? "tool_calls" : "stop", message: response.message }] });
    });
  const session = await SessionManager.open(agent, { workspace, store });
  const id = session.current.id;
  await session.run("Check every minute");
  const bound = (await session.listAutomations())[0]!;
  assert.equal(bound.sessionId, id);
  assert.equal(session.current.automationCount, 1);
  for (let index = 1; index <= 2; index++) await session.runAutomation(id, bound.id, Date.now() + index, []);
  assert.equal(session.current.id, id);
  assert.equal(session.current.turnCount, 3);
  assert.equal((await store.list(workspace)).length, 1);
  assert.equal((await session.listAutomations())[0]!.runs, 2);
  assert.ok(!JSON.stringify(session.history).includes("Automation trigger metadata"));
  assert.match(String(seen.at(-1)?.[0]?.content), /Automation trigger metadata/);
  assert.ok(seen.at(-1)!.some((message) => message.role === "user" && message.content === "Check every minute"));
  const restored = await SessionManager.open(agent, { workspace, store, selection: { resume: id } });
  assert.equal((await restored.listAutomations())[0]!.runs, 2);
  assert.equal(restored.current.turnCount, 3);
});

test("background automation updates its bound conversation without switching the selected session", async (t) => {
  const { base, workspace } = await temporaryWorkspace(t);
  const store = new SessionStore({ root: join(base, "sessions") });
  const agent = { maxIterations: 1, model: async () => answer() };
  const session = await SessionManager.open(agent, { workspace, store, selection: { name: "scheduled" } });
  await session.manageAutomation({ action: "create", ...task });
  const bound = (await session.listAutomations())[0]!;
  await session.newSession("ordinary");
  const selected = session.current.id;
  await session.run("Keep ordinary history");
  await session.runAutomation(bound.sessionId, bound.id, Date.now(), []);
  assert.equal(session.current.id, selected);
  assert.equal(session.current.turnCount, 1);
  assert.ok(!JSON.stringify(session.history).includes("Review changes"));
  const saved = await store.load(workspace, bound.sessionId);
  assert.equal(saved.history.filter((message) => message.role === "user").length, 1);
  assert.equal(saved.automations?.[0]?.runs, 1);
  await session.fork("ordinary-copy", bound.sessionId);
  assert.equal(session.current.automationCount, undefined);
});

test("cron commands create model prompts, list bindings and manage pause/resume/delete locally", async (t) => {
  const { base, workspace } = await temporaryWorkspace(t);
  const session = await SessionManager.open({ model: async () => answer(), maxIterations: 1 }, { workspace, store: new SessionStore({ root: join(base, "sessions") }) });
  assert.match(automationCommandPrompt("/cron every five minutes check tests")!, /every five minutes/);
  assert.equal(automationCommandPrompt("/cron list"), undefined);
  assert.match((await runInteractiveCommand(session, "/cron"))!.text, /No automation/);
  await session.manageAutomation({ action: "create", ...task });
  const bound = (await session.listAutomations())[0]!;
  assert.match((await runInteractiveCommand(session, "/sessions"))!.text, /\[clock\]/);
  await runInteractiveCommand(session, `/cron pause ${bound.id}`);
  await assert.rejects(session.runAutomation(bound.sessionId, bound.id, Date.now(), []), /eligible/);
  await runInteractiveCommand(session, `/cron resume ${bound.id}`);
  assert.match((await runInteractiveCommand(session, "/cron list"))!.text, /enabled/);
  await runInteractiveCommand(session, `/cron delete ${bound.id}`);
  assert.equal(session.current.automationCount, undefined);
  assert.equal(session.current.turnCount, 0);
});

test("automated turns cannot create schedules, failed attempts count, and stale claims cannot execute twice", async (t) => {
  const { base, workspace } = await temporaryWorkspace(t);
  const store = new SessionStore({ root: join(base, "sessions") });
  const agent = { maxIterations: 2, model: async (messages: Message[]) => messages.at(-1)?.role === "user"
    ? tool({ action: "create", ...task }) : answer(String(messages.at(-1)?.content)) };
  const session = await SessionManager.open(agent, { workspace, store });
  await session.manageAutomation({ action: "create", ...task });
  const bound = (await session.listAutomations())[0]!;
  const stale = await SessionManager.open(agent, { workspace, store, selection: { resume: session.current.id } });
  const due = Date.now();
  assert.match(await session.runAutomation(bound.sessionId, bound.id, due, []), /AUTOMATION_DENIED/);
  assert.equal((await session.listAutomations()).length, 1);
  await assert.rejects(stale.runAutomation(bound.sessionId, bound.id, due, []), /eligible/);
  const fresh = await SessionManager.open(agent, { workspace, store, selection: { resume: session.current.id } });
  await assert.rejects(fresh.runAutomation(bound.sessionId, bound.id, due, []), /eligible/);
  const failing = await SessionManager.open({ model: async () => { throw new Error("offline"); }, maxIterations: 1 }, { workspace, store, selection: { resume: session.current.id } });
  await assert.rejects(failing.runAutomation(bound.sessionId, bound.id, due + 1, []));
  assert.equal((await failing.listAutomations())[0]?.runs, 2);
  assert.equal((await failing.listAutomations())[0]?.lastStatus, "failed");
});

test("conversation trigger service observes files and continues the bound session with normal permissions", async (t) => {
  let service: ConversationAutomations | undefined;
  t.after(() => service?.close());
  const { base, workspace } = await temporaryWorkspace(t);
  const path = join(workspace, "notes.txt"); await writeFile(path, "initial");
  const session = await SessionManager.open({ model: async () => answer(), maxIterations: 1 },
    { workspace, store: new SessionStore({ root: join(base, "sessions") }) });
  await session.manageAutomation({ action: "create", prompt: "Read notes", trigger: { type: "file_changed", paths: ["notes.txt"] } });
  let runs = 0;
  service = new ConversationAutomations(session, { idle: () => true, changed: () => {}, error: (message) => { throw new Error(message); },
    run: async (bound, activation) => { runs++; await session.runAutomation(bound.sessionId, bound.id, activation.scheduledAt, activation.paths ?? []); await writeFile(path, "automated"); } });
  await service.tick();
  await writeFile(path, "external");
  await service.tick(); await delay(1050); await service.tick();
  assert.equal(runs, 1);
  await delay(1050); await service.tick();
  assert.equal(runs, 1);
  assert.equal(session.current.turnCount, 1);
  assert.equal(await readFile(path, "utf8"), "automated");
});

test("invalid watched files pause their task and memory-only sessions cannot save schedules", async (t) => {
  let service: ConversationAutomations | undefined;
  t.after(() => service?.close());
  const { base, workspace } = await temporaryWorkspace(t);
  const agent = { model: async () => answer(), maxIterations: 1 };
  const memory = await SessionManager.open(agent, { workspace, persistence: false });
  await assert.rejects(memory.manageAutomation({ action: "create", ...task }), /saved session/);
  const session = await SessionManager.open(agent, { workspace, store: new SessionStore({ root: join(base, "sessions") }) });
  await writeFile(join(workspace, "notes.txt"), "initial");
  await session.manageAutomation({ action: "create", prompt: "Review", trigger: { type: "file_changed", paths: ["notes.txt"] } });
  const errors: string[] = [];
  service = new ConversationAutomations(session, { idle: () => true, changed: () => {}, error: (message) => { errors.push(message); }, run: async () => { assert.fail("Invalid files must not trigger a model run."); } });
  await service.tick();
  await writeFile(join(workspace, "notes.txt"), Buffer.from([0, 1, 2]));
  await service.tick();
  assert.equal((await session.listAutomations())[0]?.enabled, false);
  assert.match(errors[0]!, /was paused/);
});
