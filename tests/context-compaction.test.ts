import assert from "node:assert/strict";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createAgent } from "../src/agent.js";
import { runChat } from "../src/chat.js";
import { loadConfig } from "../src/config.js";
import { prepareCompaction } from "../src/context/compaction.js";
import { contextBytes, decodeCompaction, projectHistory } from "../src/context/manager.js";
import { HarnessError } from "../src/errors.js";
import { createTurnReporter } from "../src/execution-report.js";
import type { ReportEvent } from "../src/execution-report.js";
import type { Message, Model, ModelTurn } from "../src/model.js";
import { Session } from "../src/session/session.js";
import { SessionManager } from "../src/session/manager.js";
import { SessionStore } from "../src/session/store.js";
import { systemPrompt } from "../src/system-prompt.js";
import { WebUiController } from "../webui/controller.js";
import { temporaryWorkspace } from "./fixtures/workspace.js";

const answer = (content = "Retain the amber requirement; inspect src/cart.ts before editing."): ModelTurn => ({
	message: { role: "assistant", content }, toolCalls: [],
});
const code = (expected: string) => (error: unknown) => error instanceof HarnessError && error.code === expected;
function history(size = 6000): Message[] {
	return [
		{ role: "system", content: systemPrompt },
		{ role: "user", content: "Keep amber. " + "historical ".repeat(size / 10) },
		{ role: "assistant", content: null, tool_calls: [{ id: "read-1", type: "function",
			function: { name: "read", arguments: '{"path":"src/cart.ts"}' } }] },
		{ role: "tool", tool_call_id: "read-1", content: '{"ok":true,"result":{"kind":"skill","content":"Preserve user edits"}}' },
		{ role: "assistant", content: "Old work completed" },
		{ role: "user", content: "Recent request" },
		{ role: "assistant", content: "Recent answer" },
	];
}

test("compaction preserves raw history, recent tool groups, current prompt and repeated boundaries", async () => {
	const original = history();
	const requests: Message[][] = [];
	const summaries: Message[][] = [];
	const session = new Session({ maxIterations: 4, model: async (messages) => {
		requests.push(structuredClone(messages)); return answer("New answer");
	}, compactionModel: async (messages, _signal, _observe, options) => {
		assert.deepEqual(options, { toolChoice: "none", purpose: "compaction" });
		summaries.push(structuredClone(messages)); return answer();
	} }, original);
	const first = await session.compact({ instructions: "Keep the color requirement" });
	assert.ok(first.projectedBytes < first.historyBytes);
	assert.equal(first.summarizedMessages, 4);
	assert.deepEqual(session.messages, original);
	assert.match(JSON.stringify(summaries), /Preserve user edits/);
	await assert.rejects(session.compact(), code("CONTEXT_COMPACTION_EMPTY"));
	await session.run("Continue with amber. " + "new-data ".repeat(600));
	assert.equal(requests[0]!.at(-1)?.role, "user");
	assert.ok(!JSON.stringify(requests[0]).includes("historical historical"));
	assert.match(JSON.stringify(requests[0]), /amber/);
	assert.deepEqual(requests[0]!.slice(-3, -1), original.slice(-2));
	await session.compact();
	assert.match(JSON.stringify(summaries[1]), /previousSummary/);
	assert.match(JSON.stringify(summaries[1]), /Recent request/);
	assert.ok(!JSON.stringify(summaries[1]).includes("historical historical"));
	assert.equal(session.messages.length, original.length + 2);
	session.reset();
	assert.equal(session.context.summarizedMessages, 0);
});

test("planning splits oversized transcripts without dropping Unicode or spending an excessive request budget", async () => {
	const raw = history();
	raw[1] = { role: "user", content: "Keep amber " + "中文🐈\\\"\n".repeat(800) };
	const plan = prepareCompaction(raw, undefined, 16384, 8);
	assert.ok(plan.chunks.length > 1);
	assert.equal(plan.chunks.join(""), raw.slice(1, 5).map((message) => JSON.stringify(message)).join("\n"));
	assert.ok(plan.chunks.every((chunk) => !chunk.includes("\ufffd")));
	assert.throws(() => prepareCompaction(raw, undefined, 16384, 1), code("CONTEXT_COMPACTION_LIMIT"));
	const summaryRequests: Message[][] = [];
	const session = new Session({ maxIterations: 8, maxRequestBytes: 16384,
		model: async () => answer(), compactionModel: async (messages) => {
			summaryRequests.push(structuredClone(messages));
			assert.ok(contextBytes(messages) < 16384 - 2048);
			return answer();
		} }, raw);
	const result = await session.compact();
	assert.equal(result.requests, plan.chunks.length);
	for (const request of summaryRequests.slice(1)) assert.match(String(request[1]?.content), /Retain the amber requirement/);
});

test("malformed saved boundaries and summaries are rejected; projected values are isolated", () => {
	const raw = history();
	const state = { version: 1 as const, summary: "Keep amber", firstKeptMessage: 5, createdAt: new Date().toISOString() };
	for (const firstKeptMessage of [0, 1, 2, 3, 4, 7, 999, 5.5]) {
		assert.throws(() => decodeCompaction({ ...state, firstKeptMessage }, raw), code("SESSION_CORRUPT"));
	}
	for (const patch of [{ summary: " " }, { summary: "x".repeat(8193) }, { version: 2 }, { createdAt: "invalid" }]) {
		assert.throws(() => decodeCompaction({ ...state, ...patch }, raw), code("SESSION_CORRUPT"));
	}
	const projected = projectHistory(raw, state);
	assert.equal(projected[0]!.content, systemPrompt);
	projected.at(-1)!.content = "Mutation";
	assert.equal(raw.at(-1)!.content, "Recent answer");
});

test("invalid, ineffective, failed and cancelled summaries retain prior context and report actual usage", async () => {
	for (const failure of ["empty", "oversize", "tools", "cancelled", "network"] as const) {
		const abort = new AbortController();
		const events: ReportEvent[] = [];
		const session = new Session({ maxIterations: 4, model: async () => answer(), compactionModel: async (_messages, _signal, observe) => {
			observe?.({ type: "model_usage", usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 } });
			if (failure === "network") throw new HarnessError("MODEL_CONNECTION", "Injected failure");
			if (failure === "cancelled") abort.abort();
			if (failure === "empty") return answer(" ");
			if (failure === "oversize") return answer("x".repeat(8193));
			if (failure === "tools") {
				const call = { id: "bad", type: "function" as const, function: { name: "shell", arguments: "{}" } };
				return { message: { role: "assistant", content: null, tool_calls: [call] }, toolCalls: [call] };
			}
			return answer();
		} }, history());
		const before = session.context;
		await assert.rejects(session.compact({ signal: abort.signal, onEvent: createTurnReporter((event) => events.push(event)) }));
		assert.deepEqual(session.context, before);
		assert.deepEqual(session.messages, history());
		const report = events.find((event) => event.type === "execution_report");
		assert.equal(report?.report.outcome, "stopped");
		assert.ok(events.some((event) => event.type === "model_usage"));
	}
	const tiny = new Session({ model: async () => answer("x".repeat(1000)), maxIterations: 1 }, history(10));
	await assert.rejects(tiny.compact(), code("CONTEXT_COMPACTION_INEFFECTIVE"));
});

test("durable compaction survives restart, fork and continued raw checkpoints without changing permissions or attempts", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const agent = { model: async () => answer(), maxIterations: 4 };
	const session = await SessionManager.open(agent, { workspace, store });
	await session.run("Keep amber " + "old data ".repeat(1000));
	await session.run("Recent prompt");
	const id = session.current.id;
	const raw = session.history;
	let completed = false;
	await session.compact({ onEvent: (event) => {
		if (event.type === "completed") { completed = true; assert.equal(session.isBusy, false); }
	} });
	assert.equal(completed, true);
	assert.deepEqual(session.history, raw);
	const saved = await store.load(workspace, id);
	assert.ok(saved.compaction);
	assert.equal(saved.attempt, null);
	const resumed = await SessionManager.open(agent, { workspace, store, selection: { resume: id } });
	assert.deepEqual(resumed.context, session.context);
	await resumed.fork("compacted fork");
	assert.deepEqual(resumed.context, session.context);
	await resumed.run("Continue");
	assert.equal(resumed.current.turnCount, 3);
	assert.deepEqual(resumed.history.slice(0, raw.length), raw);
	assert.equal((await store.load(workspace, id)).history.length, raw.length);
	await resumed.newSession();
	assert.equal(resumed.context.summarizedMessages, 0);
});

test("preflight conflicts avoid model calls and final save failure leaves the old projection active", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	class FailingStore extends SessionStore {
		fail = false;
		override async save(record: Parameters<SessionStore["save"]>[0], revision: number) {
			if (this.fail && record.compaction) throw new HarnessError("SESSION_STORAGE", "Injected save failure");
			return super.save(record, revision);
		}
	}
	const store = new FailingStore({ root: join(base, "sessions") });
	let calls = 0;
	const agent = { model: async () => answer(), compactionModel: async () => { calls++; return answer(); }, maxIterations: 4 };
	const session = await SessionManager.open(agent, { workspace, store });
	await session.run("old ".repeat(2000));
	await session.run("Recent");
	const stale = await SessionManager.open(agent, { workspace, store, selection: { resume: session.current.id } });
	await session.rename("changed");
	await assert.rejects(stale.compact(), code("SESSION_CONFLICT"));
	assert.equal(calls, 0);
	const before = session.context;
	store.fail = true;
	const events: ReportEvent[] = [];
	await assert.rejects(session.compact({ onEvent: createTurnReporter((event) => events.push(event)) }), code("SESSION_STORAGE"));
	assert.equal(calls, 1);
	assert.deepEqual(session.context, before);
	assert.equal((await store.load(workspace, session.current.id)).compaction, undefined);
	assert.ok(!events.some((event) => event.type === "completed"));
	assert.equal(events.find((event) => event.type === "execution_report")?.report.stopCode, "SESSION_STORAGE");
});

test("busy guards and cancellation apply throughout summary generation", async () => {
	let entered!: () => void;
	const ready = new Promise<void>((resolve) => { entered = resolve; });
	const abort = new AbortController();
	const session = new Session({ model: async () => answer(), maxIterations: 4,
		compactionModel: async (_messages, signal) => {
			entered();
			await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
			return answer();
		} }, history());
	const pending = session.compact({ signal: abort.signal });
	await ready;
	assert.throws(() => session.reset(), code("SESSION_BUSY"));
	await assert.rejects(session.run("Concurrent"), code("SESSION_BUSY"));
	await assert.rejects(session.compact(), code("SESSION_BUSY"));
	abort.abort();
	await assert.rejects(pending, code("CANCELLED"));
	assert.equal(session.context.summarizedMessages, 0);
	await session.run("After cancellation");
});

test("a concurrent durable update during compaction wins without losing its history", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	let entered!: () => void;
	let finish!: (turn: ModelTurn) => void;
	const ready = new Promise<void>((resolve) => { entered = resolve; });
	const ordinary = { model: async () => answer(), maxIterations: 4 };
	const session = await SessionManager.open({ ...ordinary, compactionModel: async () => {
		entered(); return new Promise<ModelTurn>((resolve) => { finish = resolve; });
	} }, { workspace, store });
	await session.run("old content ".repeat(1000));
	await session.run("Recent");
	const previous = session.context;
	const pending = session.compact();
	await ready;
	await assert.rejects(session.fork(), code("SESSION_BUSY"));
	const other = await SessionManager.open(ordinary, { workspace, store, selection: { resume: session.current.id } });
	await other.run("Concurrent new turn");
	finish(answer());
	await assert.rejects(pending, code("SESSION_CONFLICT"));
	assert.deepEqual(session.context, previous);
	const saved = await store.load(workspace, session.current.id);
	assert.ok(saved.history.some((message) => message.content === "Concurrent new turn"));
	assert.equal(saved.compaction, undefined);
});

test("compacting after an interrupted turn preserves recovery evidence outside the summary", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const requests: Message[][] = [];
	const session = await SessionManager.open({ maxIterations: 4, compactionModel: async (messages) => {
		assert.ok(!JSON.stringify(messages).includes("INTERRUPTED_PROMPT"));
		return answer();
	}, model: async (messages) => {
		requests.push(structuredClone(messages));
		if (messages.at(-1)?.content === "INTERRUPTED_PROMPT") throw new HarnessError("MODEL_CONNECTION", "Injected failure");
		return answer();
	} }, { workspace, store });
	await session.run("old content ".repeat(1000));
	await session.run("Recent");
	await assert.rejects(session.run("INTERRUPTED_PROMPT"), code("MODEL_CONNECTION"));
	const attempt = (await store.load(workspace, session.current.id)).attempt;
	await session.compact();
	assert.deepEqual((await store.load(workspace, session.current.id)).attempt, attempt);
	await session.run("Inspect before continuing");
	assert.match(JSON.stringify(requests.at(-1)), /INTERRUPTED_PROMPT/);
	assert.match(JSON.stringify(requests.at(-1)), /Do not automatically replay/);
});

for (const [provider, key] of [["deepseek", "DEEPSEEK_API_KEY"], ["kimi", "MOONSHOT_API_KEY"], ["mimo", "MIMO_API_KEY"], ["qwen", "DASHSCOPE_API_KEY"]]) {
	test(`${provider}: summary requests use the current provider and exact byte guard without tool or agent guidance`, async () => {
		const config = loadConfig({ HARNESS_PROVIDER: provider!, [key!]: "offline-compaction", HARNESS_MAX_REQUEST_BYTES: "16384" });
		const agent = createAgent(config, undefined, async (input, init) => {
			const text = await new Request(input, init).text();
			assert.ok(Buffer.byteLength(text) <= 16384);
			const body = JSON.parse(text);
			assert.equal(body.model, config.model);
			assert.equal(body.tools, undefined);
			assert.equal(body.tool_choice, undefined);
			assert.ok(!text.includes("delegate_task"));
			return Response.json({ choices: [{ finish_reason: "stop", message: answer().message }],
				usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } });
		});
		const session = new Session(agent, history());
		const events: ReportEvent[] = [];
		await session.compact({ onEvent: createTurnReporter((event) => events.push(event)) });
		assert.ok(events.some((event) => event.type === "model_input" && event.accepted));
		assert.ok(events.some((event) => event.type === "model_usage" && event.usage?.totalTokens === 120));
	});
}

test("chat context commands produce reports without inserting commands or summaries into raw history", async () => {
	const session = new Session({ model: async () => answer(), maxIterations: 4 }, history());
	const output = new PassThrough();
	const error = new PassThrough();
	let log = "";
	error.on("data", (chunk) => { log += String(chunk); });
	const result = await runChat(session, { input: Readable.from(["/context\n/compact Keep amber\n/context\n/exit\n"]), output, error });
	assert.equal(result, 0);
	assert.match(log, /Context compacted/);
	assert.match(log, /"operation":"compaction"/);
	assert.match(log, /"type":"execution_report"/);
	assert.deepEqual(session.messages, history());
});

test("manual compaction lets an over-budget conversation continue through the SDK while preserving raw history", async () => {
	const config = loadConfig({ DEEPSEEK_API_KEY: "offline-compaction-workflow", HARNESS_MAX_REQUEST_BYTES: "32768" });
	let summaries = 0;
	let ordinary = 0;
	const agent = createAgent(config, undefined, async (input, init) => {
		const body = await new Request(input, init).json() as { messages: Message[]; tools?: unknown[] };
		if (!body.tools) {
			summaries++;
			return Response.json({ choices: [{ finish_reason: "stop", message: answer().message }] });
		}
		ordinary++;
		assert.match(JSON.stringify(body.messages), /Retain the amber requirement/);
		assert.match(JSON.stringify(body.messages), /Recent request/);
		assert.ok(!JSON.stringify(body.messages).includes("historical historical"));
		assert.equal(body.messages.at(-1)?.content, "Continue with the retained constraint");
		return Response.json({ choices: [{ finish_reason: "stop", message: answer("Continued with amber").message }] });
	});
	const session = new Session(agent, history(45000));
	const original = session.messages;
	await assert.rejects(session.run("Too large before compaction"), code("MODEL_CONTEXT_LIMIT"));
	assert.equal(ordinary + summaries, 0);
	await session.compact();
	assert.ok(summaries > 1 && summaries <= 8);
	assert.equal(await session.run("Continue with the retained constraint"), "Continued with amber");
	assert.equal(ordinary, 1);
	assert.deepEqual(session.messages.slice(0, original.length), original);
});

test("Web UI compaction uses shared cancellation and context without presenting summary tokens as conversation usage", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const session = await SessionManager.open({ model: async () => answer(), maxIterations: 4 }, { workspace, store });
	await session.run("Old content ".repeat(800));
	await session.run("Recent request");
	const controller = await WebUiController.create({ provider: "deepseek", model: "offline", workspace,
		permission: "ask", shellPermission: "ask", webPermission: "deny", maxIterations: 4,
		maxRequestBytes: 262144, skills: 0, warnings: [] }, session);
	t.after(() => controller.close());
	controller.submit("/compact Keep amber");
	const deadline = performance.now() + 10000;
	while (controller.snapshot().busy && performance.now() < deadline) await delay(10);
	assert.equal(controller.snapshot().busy, false);
	assert.match(controller.snapshot().turns.at(-1)!.answer!, /Context compacted/);
	assert.equal(controller.snapshot().contextUsage.promptTokens, null);
	assert.equal(session.current.turnCount, 2);
	assert.ok(session.context.summarizedMessages > 0);
	await controller.resume(session.current.id);
	assert.equal(controller.snapshot().turns.length, 2);
});

test("Web UI Stop cancels compaction and maintenance commands do not consume the conversation limit", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	let entered!: () => void;
	const ready = new Promise<void>((resolve) => { entered = resolve; });
	const session = await SessionManager.open({ model: async () => answer(), maxIterations: 4,
		compactionModel: async (_messages, signal) => {
			entered();
			await new Promise<void>((resolve) => signal!.addEventListener("abort", () => resolve(), { once: true }));
			return answer();
		} }, { workspace, store: new SessionStore({ root: join(base, "sessions") }) });
	await session.run("old data ".repeat(1000));
	await session.run("Recent");
	const controller = await WebUiController.create({ provider: "deepseek", model: "offline", workspace,
		permission: "ask", shellPermission: "ask", webPermission: "deny", maxIterations: 4,
		maxRequestBytes: 262144, skills: 0, warnings: [] }, session);
	t.after(() => controller.close());
	const before = session.context;
	controller.submit("/compact");
	await ready;
	controller.stop();
	const settle = async () => {
		const deadline = performance.now() + 10000;
		while (controller.snapshot().busy && performance.now() < deadline) await delay(5);
		assert.equal(controller.snapshot().busy, false);
	};
	await settle();
	assert.deepEqual(session.context, before);
	assert.equal(controller.snapshot().turns.at(-1)?.status, "stopped");
	assert.match(controller.snapshot().turns.at(-1)?.error ?? "", /CANCELLED/);
	for (let index = 0; index < 22; index++) {
		controller.submit("/context");
		await settle();
	}
	assert.equal(controller.snapshot().turns.filter((turn) => turn.contextOperation).length, 20);
	assert.equal(session.current.turnCount, 2);
	controller.submit("Continue after context commands");
	await settle();
	assert.equal(session.current.turnCount, 3);
});
