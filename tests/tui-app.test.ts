import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { Terminal } from "@earendil-works/pi-tui";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { HarnessError } from "../src/errors.js";
import type { Model, Message } from "../src/model.js";
import { Session } from "../src/session/session.js";
import { SessionManager } from "../src/session/manager.js";
import { SessionStore } from "../src/session/store.js";
import type { SkillDescriptor } from "../src/skills.js";
import { createSubagentTools } from "../src/subagent.js";
import { createTools } from "../src/tools.js";
import { TuiApp } from "../tui/app.js";
import { metricSections, statusText } from "../tui/metrics.js";
import { createTuiTelemetry } from "../tui/telemetry.js";
import { temporaryWorkspace } from "./fixtures/workspace.js";

class FakeTerminal implements Terminal {
  columns = 120;
  rows = 36;
  kittyProtocolActive = false;
  output = "";
  stopped = false;
  drained = false;
  drainedBeforeStop = false;
  input: (data: string) => void = () => {};
  resize: () => void = () => {};
  start(input: (data: string) => void, resize: () => void) { this.input = input; this.resize = resize; }
  stop() { this.drainedBeforeStop = this.drained; this.stopped = true; }
  write(data: string) { this.output += data; }
  async drainInput() { this.drained = true; }
  moveBy() {}
  hideCursor() {}
  showCursor() {}
  clearLine() {}
  clearFromCursor() {}
  clearScreen() {}
  setTitle() {}
  setProgress() {}
  type(text: string) { for (const character of text) this.input(character); }
  submit(text: string) { this.type(text); this.input("\r"); }
  get plain() { return stripTerminalSequences(this.output); }
}

const settings = {
  config: { provider: "deepseek" as const, region: "global" as const, model: "offline-model",
    maxIterations: 8, requestTimeoutMs: 60000, maxRequestBytes: 262144 },
  workspace: "D:\\fixture", permission: "ask" as const, shellPermission: "ask" as const, skills: 4,
};
const answer = (content = "Answer") => ({ message: { role: "assistant" as const, content }, toolCalls: [] });
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail("TUI did not reach the expected state.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("TUI preserves real session history, local commands, reported consumption and terminal cleanup", async (t) => {
  const terminal = new FakeTerminal();
  const app = new TuiApp({ ...settings, terminal, color: false });
  const requests: Message[][] = [];
  const model: Model = async (messages, _signal, observe) => {
    requests.push(structuredClone(messages));
    observe?.({ type: "model_input", bytes: 800, limitBytes: 262144, accepted: true });
    observe?.({ type: "model_usage", usage: { promptTokens: 80, completionTokens: 20, totalTokens: 100, cachedPromptTokens: 40 } });
    return answer("**Ready** to code.");
  };
  const sigintBefore = process.listenerCount("SIGINT");
  const done = app.run(new Session({ model, maxIterations: 8 }));
  t.after(async () => { terminal.input("\x04"); await done; });
  terminal.submit("Hello");
  await until(() => app.telemetry.snapshot().turn.status === "answered");
  terminal.submit("Continue");
  await until(() => app.telemetry.snapshot().session.answered === 2);
  assert.equal(requests[1]?.length, 4);
  terminal.submit("/status");
  await until(() => terminal.plain.includes("Usage is process-local"));
  assert.equal(requests.length, 2);
  assert.equal(app.telemetry.snapshot().session.tokenUsage.total.totals?.totalTokens, 200);
  terminal.submit("/reset");
  assert.equal(app.telemetry.snapshot().conversation.completedTurns, 0);
  assert.equal(app.telemetry.snapshot().session.tokenUsage.total.totals?.totalTokens, 200);
  terminal.submit("After reset");
  await until(() => app.telemetry.snapshot().session.answered === 3);
  assert.equal(requests[2]?.length, 2);
  terminal.submit("/exit");
  assert.equal(await done, 0);
  assert.equal(terminal.stopped, true);
  assert.equal(terminal.drainedBeforeStop, true);
  assert.equal(process.listenerCount("SIGINT"), sigintBefore);
  assert.ok(terminal.output.includes("\x1b[?1049h"));
  assert.ok(terminal.output.includes("\x1b[?1049l"));
});

test("TUI skills shows catalog metadata locally and keeps the conversation usable after invalid arguments", async () => {
  const terminal = new FakeTerminal();
  terminal.rows = 60;
  const skillCatalog: SkillDescriptor[] = [
    { name: "fixture-review", description: "Review the local fixture.", uri: "skill://fixture-review/SKILL.md", scope: "workspace" },
    { name: "workspace-editing", description: "Edit workspace files.", uri: "skill://workspace-editing/SKILL.md", scope: "builtin", subsystem: "tools" },
  ];
  const prompts: string[] = [];
  const session = new Session({ maxIterations: 1, model: async (messages) => {
    prompts.push(String(messages.at(-1)?.content));
    assert.ok(!JSON.stringify(messages).includes("/skills"));
    return answer("Saved answer.");
  } });
  await session.run("Before the interface");
  const saved = session.messages;
  const app = new TuiApp({ ...settings, skills: skillCatalog.length, skillCatalog, terminal, color: false });
  const done = app.run(session);
  try {
    terminal.submit("/skills");
    await until(() => terminal.plain.includes("Review the local fixture."));
    assert.deepEqual(prompts, ["Before the interface"]);
    assert.deepEqual(session.messages, saved);
    assert.equal(app.telemetry.snapshot().session.turns, 0);
    for (const skill of skillCatalog) {
      assert.ok(terminal.plain.includes(skill.name));
      assert.ok(terminal.plain.includes(skill.description));
      assert.ok(terminal.plain.includes(skill.uri));
      assert.ok(terminal.plain.includes(skill.scope));
    }
    terminal.submit("/skills unexpected");
    await until(() => terminal.plain.includes("Error [USAGE]"));
    assert.deepEqual(session.messages, saved);
    assert.equal(app.telemetry.snapshot().session.turns, 0);
    terminal.submit("Continue");
    await until(() => app.telemetry.snapshot().turn.status === "answered");
    assert.deepEqual(prompts, ["Before the interface", "Continue"]);
    assert.equal(session.messages.length, saved.length + 2);
    terminal.submit("/exit");
    assert.equal(await done, 0);
  } finally {
    terminal.input("\x04");
    await done;
  }
});

test("TUI switches saved sessions, restores conversation counts and keeps usage process local", async (t) => {
  const { base, workspace } = await temporaryWorkspace(t);
  const terminal = new FakeTerminal();
  const requests: Message[][] = [];
  const model: Model = async (messages, _signal, observe) => {
    requests.push(structuredClone(messages));
    observe?.({ type: "model_usage", usage: { promptTokens: 8, completionTokens: 2, totalTokens: 10 } });
    return answer("Saved fixture answer.");
  };
  const store = new SessionStore({ root: join(base, "sessions") });
  const initial = await SessionManager.open({ model, maxIterations: 8 }, { workspace, store, selection: { name: "first" } });
  await initial.run("Before restart");
  const manager = await SessionManager.open({ model, maxIterations: 8 }, { workspace, store, selection: { resume: "first" } });
  const app = new TuiApp({ ...settings, workspace, terminal, color: false });
  const done = app.run(manager);
  try {
    assert.equal(app.telemetry.snapshot().conversation.completedTurns, 1);
    assert.equal(app.telemetry.snapshot().session.tokenUsage.total.totals, null);
    await until(() => terminal.plain.includes("Before restart"));
    terminal.submit("/new second");
    await until(() => manager.current.name === "second" && app.telemetry.snapshot().conversation.completedTurns === 0);
    terminal.submit("Second task");
    await until(() => app.telemetry.snapshot().turn.status === "answered");
    assert.equal(requests.at(-1)?.length, 2);
    assert.equal(app.telemetry.snapshot().session.tokenUsage.total.totals?.totalTokens, 10);
    terminal.submit("/resume first");
    await until(() => manager.current.name === "first" && app.telemetry.snapshot().turn.status === "idle");
    assert.equal(app.telemetry.snapshot().conversation.completedTurns, 1);
    assert.equal(app.telemetry.snapshot().session.tokenUsage.total.totals?.totalTokens, 10);
    terminal.submit("/rename renamed");
    await until(() => manager.current.name === "renamed");
    terminal.submit("/fork copied");
    await until(() => manager.current.name === "copied");
    assert.equal(app.telemetry.snapshot().conversation.completedTurns, 1);
    terminal.submit("Follow-up");
    await until(() => app.telemetry.snapshot().session.answered === 2);
    assert.equal(requests.at(-1)?.length, 4);
    assert.equal(app.telemetry.snapshot().session.tokenUsage.total.totals?.totalTokens, 20);
    terminal.submit("/clear");
    await until(() => manager.current.name === null && app.telemetry.snapshot().conversation.completedTurns === 0);
    assert.equal(app.telemetry.snapshot().session.tokenUsage.total.totals?.totalTokens, 20);
    const sessions = await manager.list();
    assert.equal(sessions.find((session) => session.name === "renamed")?.turnCount, 1);
    assert.equal(sessions.find((session) => session.name === "copied")?.turnCount, 2);
    assert.equal(requests.length, 3);
    terminal.submit("/exit");
    assert.equal(await done, 0);
  } finally {
    terminal.input("\x04");
    await done;
  }
});

test("TUI approvals require fresh input and keep pending draft separate from yes/no", async () => {
  const terminal = new FakeTerminal();
  const app = new TuiApp({ ...settings, terminal, color: false });
  let requestApproval: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { requestApproval = resolve; });
  let allowed: boolean | undefined;
  let calls = 0;
  const model: Model = async (_messages, signal) => {
    calls++;
    await gate;
    allowed = await app.approveShell({ command: "Write-Output 'fixture'", cwd: ".", timeoutMs: 1000 }, signal);
    return answer();
  };
  const done = app.run(new Session({ model, maxIterations: 8 }));
  terminal.submit("Run the fixture");
  terminal.type("yes");
  terminal.input("\r");
  assert.equal(calls, 1);
  requestApproval!();
  await until(() => terminal.plain.includes("COMMAND APPROVAL"));
  assert.equal(allowed, undefined);
  terminal.input("\r");
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(allowed, undefined);
  terminal.submit("maybe");
  assert.equal(allowed, undefined);
  terminal.submit("no");
  await until(() => app.telemetry.snapshot().turn.status === "answered");
  assert.equal(allowed, false);
  assert.equal(calls, 1);
  terminal.input("\x15");
  terminal.submit("/exit");
  assert.equal(await done, 0);
});

test("a real child write waits for approval and appears once in the shared execution feed", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const terminal = new FakeTerminal();
  terminal.rows = 60;
  const app = new TuiApp({ ...settings, workspace, terminal, color: false });
  const call = (name: string, args: unknown) => {
    const toolCalls = [{ id: name, type: "function" as const, function: { name, arguments: JSON.stringify(args) } }];
    return { message: { role: "assistant" as const, content: null, tool_calls: toolCalls }, toolCalls };
  };
  let childRequests = 0;
  let parentRequests = 0;
  const tools = createSubagentTools(await createTools(workspace, "ask", app.approveWrite),
    async () => ++childRequests === 1 ? call("write", { path: "approved.txt", content: "approved content" }) : answer(), 8);
  const done = app.run(new Session({ tools, maxIterations: 8,
    model: async () => ++parentRequests === 1 ? call("delegate_task", { task: "Create approved.txt" }) : answer() }));
  try {
    terminal.submit("Delegate the file creation");
    await until(() => terminal.plain.includes("WRITE APPROVAL"));
    await assert.rejects(readFile(join(workspace, "approved.txt")), { code: "ENOENT" });
    terminal.submit("yes");
    await until(() => app.telemetry.snapshot().turn.status === "answered");
    assert.equal(await readFile(join(workspace, "approved.txt"), "utf8"), "approved content");
    assert.equal(app.telemetry.snapshot().turn.writes, 1);
    terminal.output = "";
    terminal.submit("/exit");
    assert.equal(await done, 0);
    assert.equal(terminal.plain.split("create approved.txt: committed").length - 1, 1);
  } finally {
    terminal.input("\x04");
    await done;
  }
});

test("cancelling an approval rejects it, discards failed history and allows the next turn", async () => {
  const terminal = new FakeTerminal();
  const app = new TuiApp({ ...settings, terminal, color: false });
  const requests: Message[][] = [];
  let approved = false;
  const model: Model = async (messages, signal) => {
    requests.push(structuredClone(messages));
    if (requests.length === 1) approved = await app.approveWrite({ operation: "create", path: "file.txt", newText: "data", bytes: 4 }, signal);
    return answer();
  };
  const done = app.run(new Session({ model, maxIterations: 8 }));
  terminal.submit("Create a file");
  await until(() => terminal.plain.includes("WRITE APPROVAL"));
  terminal.input("\x1b");
  await until(() => app.telemetry.snapshot().turn.status === "stopped");
  assert.equal(approved, false);
  assert.equal(app.telemetry.snapshot().turn.stopCode, "CANCELLED");
  terminal.submit("Continue safely");
  await until(() => app.telemetry.snapshot().turn.status === "answered");
  assert.equal(requests[1]?.length, 2);
  terminal.submit("/exit");
  assert.equal(await done, 1);
  assert.equal(terminal.stopped, true);
});

test("Ctrl+D aborts a model request and waits for cleanup before restoring terminal", async () => {
  const terminal = new FakeTerminal();
  const app = new TuiApp({ ...settings, terminal, color: false });
  let cleaned = false;
  const model: Model = async (_messages, signal) => {
    await new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => {
      cleaned = true;
      reject(new HarnessError("CANCELLED", "The task was cancelled."));
    }, { once: true }));
    return answer();
  };
  const done = app.run(new Session({ model, maxIterations: 8 }));
  terminal.submit("Wait");
  terminal.input("\x04");
  assert.equal(await done, 1);
  assert.equal(cleaned, true);
  assert.equal(terminal.stopped, true);
});

test("application PageUp and PageDown navigate the full status through the terminal input path", async () => {
  const terminal = new FakeTerminal();
  terminal.rows = 24;
  const app = new TuiApp({ ...settings, terminal, color: false });
  const done = app.run(new Session({ model: async () => answer(), maxIterations: 8 }));
  try {
    terminal.submit("/status");
    await until(() => terminal.plain.includes("Usage is process-local"));
    assert.doesNotMatch(terminal.plain, /CONFIGURATION/);
    terminal.output = "";
    for (let page = 0; page < 20; page++) terminal.input("\x1b[5~");
    await until(() => terminal.plain.includes("CONFIGURATION"));
    assert.match(terminal.plain, /offline-model/);
    terminal.output = "";
    for (let page = 0; page < 20; page++) terminal.input("\x1b[6~");
    await until(() => terminal.plain.includes("Usage is process-local"));
  } finally {
    terminal.submit("/exit");
    await done;
  }
});

test("long approval details can be paged in both directions before a fresh answer", async () => {
  const terminal = new FakeTerminal();
  terminal.rows = 24;
  const app = new TuiApp({ ...settings, terminal, color: false });
  let allowed: boolean | undefined;
  const model: Model = async (_messages, signal) => {
    allowed = await app.approveShell({ command: "APPROVAL_BEGIN " + "review-command ".repeat(160) + " APPROVAL_END",
      cwd: ".", timeoutMs: 1000 }, signal);
    return answer();
  };
  const done = app.run(new Session({ model, maxIterations: 8 }));
  try {
    terminal.submit("Review the full command");
    await until(() => terminal.plain.includes("APPROVAL_END"));
    assert.doesNotMatch(terminal.plain, /APPROVAL_BEGIN/);
    terminal.output = "";
    for (let page = 0; page < 20; page++) terminal.input("\x1b[5~");
    await until(() => terminal.plain.includes("APPROVAL_BEGIN"));
    assert.equal(allowed, undefined);
    terminal.output = "";
    for (let page = 0; page < 20; page++) terminal.input("\x1b[6~");
    await until(() => terminal.plain.includes("APPROVAL_END"));
    assert.equal(allowed, undefined);
    terminal.submit("no");
    await until(() => app.telemetry.snapshot().turn.status === "answered");
    assert.equal(allowed, false);
  } finally {
    terminal.input("\x04");
    await done;
  }
});

test("a Kitty Ctrl+C release cannot exit the session after its press cancelled a turn", async () => {
  const terminal = new FakeTerminal();
  const app = new TuiApp({ ...settings, terminal, color: false });
  let requests = 0;
  const model: Model = async (_messages, signal) => {
    if (++requests === 1) await new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => {
      reject(new HarnessError("CANCELLED", "The task was cancelled."));
    }, { once: true }));
    return answer();
  };
  const done = app.run(new Session({ model, maxIterations: 8 }));
  try {
    terminal.submit("Wait for cancellation");
    terminal.input("\x1b[99;5:1u");
    await until(() => app.telemetry.snapshot().turn.status === "stopped");
    terminal.input("\x1b[99;5:3u");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(terminal.stopped, false);
    terminal.submit("Continue after release");
    await until(() => app.telemetry.snapshot().turn.status === "answered");
    assert.equal(requests, 2);
  } finally {
    terminal.input("\x04");
    await done;
  }
});

test("terminal startup errors restore lifecycle listeners and stop the terminal", async () => {
  const terminal = new FakeTerminal();
  terminal.start = () => { throw new Error("Fake start failure"); };
  const before = process.listenerCount("SIGINT");
  const app = new TuiApp({ ...settings, terminal });
  await assert.rejects(app.run(new Session({ model: async () => answer(), maxIterations: 1 })), /Fake start failure/);
  assert.equal(terminal.stopped, true);
  assert.equal(process.listenerCount("SIGINT"), before);
});

test("terminal restoration still runs if draining pending keyboard input fails", async () => {
  const terminal = new FakeTerminal();
  terminal.drainInput = async () => { throw new Error("Fake drain failure"); };
  const before = process.listenerCount("SIGINT");
  const app = new TuiApp({ ...settings, terminal, color: false });
  const done = app.run(new Session({ model: async () => answer(), maxIterations: 1 }));
  terminal.submit("/exit");
  await assert.rejects(done, /Fake drain failure/);
  assert.equal(terminal.stopped, true);
  assert.equal(process.listenerCount("SIGINT"), before);
});

test("status distinguishes provider tokens, unknown model capacity, local bytes and credentials", () => {
  const telemetry = createTuiTelemetry();
  telemetry.beginTurn();
  telemetry.observe({ type: "model_request", iteration: 1 });
  telemetry.observe({ type: "model_input", iteration: 1, bytes: 1024, limitBytes: 262144, accepted: true });
  telemetry.observe({ type: "model_usage", iteration: 1, usage: { promptTokens: 800, completionTokens: 20, totalTokens: 820, cachedPromptTokens: 200 } });
  const status = statusText(telemetry.snapshot(), settings);
  assert.match(status, /Session hit: 25.0%/);
  assert.match(status, /JSON body: 1,024 B/);
  assert.match(status, /Parent input: 800 tokens/);
  assert.match(status, /Model limit: N\/A/);
  assert.match(status, /API key: configured \(hidden\)/);
  assert.equal(metricSections(telemetry.snapshot(), settings)[2]?.meter?.ratio, 1024 / 262144);
});
