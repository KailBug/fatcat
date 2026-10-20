import type { ChatMessage } from "../support/chat-protocol.js";
import assert from "node:assert/strict";
import { join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";
import { createAgent } from "@fatcat/runtime/agent";
import { runChat } from "@fatcat/cli/internal/chat";
import { loadConfig } from "@fatcat/runtime/config";
import { HarnessError } from "@fatcat/runtime/errors";
import { createTurnReporter } from "@fatcat/runtime/execution-report";
import type { ReportEvent } from "@fatcat/runtime/execution-report";
import type { Message, Model, ModelObservation, ModelTurn } from "@fatcat/runtime/model-types";
import { Session } from "@fatcat/runtime/session/session";
import { SessionManager } from "@fatcat/runtime/session/manager";
import { SessionStore } from "@fatcat/runtime/session/store";
import { systemPrompt } from "@fatcat/runtime/internal/system-prompt";
import { createTuiTelemetry } from "@fatcat/tui/internal/telemetry";
import { WebUiController } from "@fatcat/webui/internal/controller";
import { temporaryWorkspace } from "../support/workspace.js";

function answer(content = "Keep amber. Verify current files."): ModelTurn {
	return { message: { role: "assistant", content }, toolCalls: [] };
}

function history(size = 10000): Message[] {
	return [{ role: "system", content: systemPrompt },
		{ role: "user", content: "Keep amber. " + "x".repeat(size) }, answer("Old answer").message,
		{ role: "user", content: "Recent requirement" }, answer("Recent answer").message];
}

const code = (expected: string) => (error: unknown) => error instanceof HarnessError && error.code === expected;

function rejectRequest(observe?: (event: ModelObservation) => void): never {
	observe?.({ type: "model_input", bytes: 40000, limitBytes: 32768, accepted: false });
	throw new HarnessError("MODEL_CONTEXT_LIMIT", "Injected local rejection; request was not sent.");
}

for (const [provider, key] of [["deepseek", "DEEPSEEK_API_KEY"], ["kimi", "MOONSHOT_API_KEY"],
	["mimo", "MIMO_API_KEY"], ["qwen", "DASHSCOPE_API_KEY"]]) {
	test(`${provider}: local SDK rejection compacts once within the turn budget and preserves raw history`, async (t) => {
		const config = loadConfig({ HARNESS_PROVIDER: provider!, [key!]: "offline-auto-compaction",
			HARNESS_MAX_REQUEST_BYTES: "32768", HARNESS_MAX_ITERATIONS: "8" });
		let summaries = 0;
		let ordinary = 0;
		const agent = createAgent(config, undefined, async (input, init) => {
			const request = await new Request(input, init).text();
			assert.ok(Buffer.byteLength(request) <= config.maxRequestBytes);
			const body = JSON.parse(request) as { messages: ChatMessage[]; tools?: unknown[] };
			const summary = String(body.messages[0]?.content).startsWith("Summarize historical");
			if (summary) {
				summaries++;
				assert.equal(body.tools, undefined);
				assert.ok(!request.includes("Recent requirement"));
			} else {
				ordinary++;
				assert.match(request, /Keep amber/);
				assert.match(request, /Recent requirement/);
				assert.equal(body.messages.at(-1)?.content, "Continue");
				assert.ok(!request.includes("x".repeat(500)));
			}
			return Response.json({ choices: [{ finish_reason: "stop", message: answer(summary ? "Keep amber." : "Continued").message }],
				usage: { prompt_tokens: summary ? 700 : 50, completion_tokens: 10, total_tokens: summary ? 710 : 60 } });
		});
		const { base, workspace } = await temporaryWorkspace(t);
		const store = new SessionStore({ root: join(base, "sessions") });
		const seed = await SessionManager.open({ model: async (messages) => answer(messages.at(-1)?.content === "Recent requirement"
			? "Recent answer" : "Old answer"), maxIterations: 8 }, { workspace, store });
		await seed.run("Keep amber. " + "x".repeat(45000));
		await seed.run("Recent requirement");
		const original = seed.history;
		const session = await SessionManager.open(agent, { workspace, store, selection: { resume: seed.current.id } });
		const events: ReportEvent[] = [];
		const telemetry = createTuiTelemetry();
		telemetry.beginTurn();
		assert.equal(await session.run("Continue", { onEvent: createTurnReporter((event) => {
			events.push(event);
			telemetry.observe(event);
			if (event.type === "compaction_end") {
				assert.equal(telemetry.snapshot().parentPromptTokens, null);
				assert.equal(session.contextUsage?.lastReportedInput, null, "Summary usage must not replace the main observation");
				assert.equal(session.contextUsage?.estimate.status, "pending");
			}
		}) }), "Continued");
		telemetry.finishTurn("answered");
		assert.ok(summaries > 1 && summaries <= 6);
		assert.equal(ordinary, 1);
		assert.deepEqual(session.history.slice(0, original.length), original);
		assert.equal(events.filter((event) => event.type === "compaction_start").length, 1);
		assert.equal(events.filter((event) => event.type === "completed").length, 1);
		assert.equal(events.filter((event) => event.type === "stopped").length, 0);
		assert.equal(events.find((event) => event.type === "execution_report")?.report.modelRequests.parent, summaries + 2);
		assert.equal(telemetry.snapshot().conversation.completedTurns, 1);
		assert.equal(telemetry.snapshot().parentPromptTokens, 50);
		await session.previewContext();
		assert.equal(session.contextUsage?.lastReportedInput?.inputTokens, 50);
		assert.equal(session.contextUsage?.consumption.tokens?.totalTokens, summaries * 710 + 60);
		assert.notEqual(session.contextUsage?.estimate.inputTokens, 50, "Current occupancy is not the last reported input");
		assert.equal(telemetry.snapshot().session.tokenUsage.total.totals?.totalTokens, summaries * 710 + 60);
	});
}

test("mid-turn recovery retains tool batches and never replays an executed operation", async () => {
	let calls = 0;
	let executions = 0;
	const checkpoints: Message[][] = [];
	const call = { id: "effect", name: "write", arguments: "{}" };
	const session = new Session({ maxIterations: 4, tools: {
		definitions: [], execute: async () => { executions++; return { ok: true, result: "effect recorded" }; },
	}, compactionModel: async () => answer(), model: async (messages, _signal, observe, options) => {
		calls++;
		if (calls === 1) return { message: { role: "assistant", content: null, toolCalls: [call] }, toolCalls: [call] };
		if (calls === 2) return rejectRequest(observe);
		assert.equal(options?.toolChoice, "none");
		assert.match(String(messages[0]?.content), /request 4 of 4/);
		assert.equal(messages.at(-1)?.role, "tool");
		assert.match(JSON.stringify(messages.at(-1)), /effect recorded/);
		return answer("Finished without repeating the write");
	} }, history());
	await session.run("Write once", { onCheckpoint: async (messages) => { checkpoints.push(structuredClone([...messages])); } });
	assert.equal(executions, 1);
	assert.equal(calls, 3);
	assert.ok(checkpoints.every((messages) => JSON.stringify(messages).includes("x".repeat(500))));
	assert.equal(session.messages.filter((message) => message.role === "tool").length, 1);
});

test("automatic compaction does not retry provider errors, disabled sessions, exhausted budgets or already compacted history", async () => {
	for (const mode of ["provider", "disabled", "budget", "no-observation", "no-history", "already-compacted"] as const) {
		let calls = 0;
		let summaries = 0;
		const raw = history();
		const session = new Session({ maxIterations: mode === "budget" ? 2 : 8,
			autoCompaction: mode !== "disabled", compactionModel: async () => { summaries++; return answer(); },
			model: async (_messages, _signal, observe) => {
				calls++;
				if (mode === "provider") throw new HarnessError("MODEL_HTTP", "Injected provider failure");
				if (mode === "no-observation") throw new HarnessError("MODEL_CONTEXT_LIMIT", "No local rejection evidence");
				return rejectRequest(observe);
			} }, mode === "no-history" ? raw.slice(0, 3) : raw,
			mode === "already-compacted" ? { version: 1, summary: "Keep amber", firstKeptMessage: 3, createdAt: new Date().toISOString() } : undefined);
		await assert.rejects(session.run("Continue"), code(mode === "provider" ? "MODEL_HTTP" : "MODEL_CONTEXT_LIMIT"));
		assert.equal(summaries, 0, mode);
		assert.equal(calls, 1, mode);
	}
});

test("summary planning spends nothing when it cannot fit the remaining turn allowance", async () => {
	let summaries = 0;
	const session = new Session({ maxIterations: 3, maxRequestBytes: 16384,
		model: async (_messages, _signal, observe) => rejectRequest(observe),
		compactionModel: async () => { summaries++; return answer(); },
	}, history(40000));
	await assert.rejects(session.run("Continue"), code("CONTEXT_COMPACTION_LIMIT"));
	assert.equal(summaries, 0);
	assert.equal(session.context.summarizedMessages, 0);
});

test("a rejected continuation stops after one compaction and keeps the successfully published summary", async () => {
	let summaries = 0;
	let calls = 0;
	const raw = history();
	const session = new Session({ maxIterations: 8, compactionModel: async () => { summaries++; return answer(); },
		model: async (_messages, _signal, observe) => { calls++; return rejectRequest(observe); } }, raw);
	await assert.rejects(session.run("Still too large"), code("MODEL_CONTEXT_LIMIT"));
	assert.equal(calls, 2);
	assert.equal(summaries, 1);
	assert.ok(session.context.summarizedMessages > 0);
	assert.deepEqual(session.messages, raw);
});

test("durable auto-compaction saves before continuation, survives failed turns and resume, and excludes recovery notices", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const seed = await SessionManager.open({ maxIterations: 8, model: async () => answer() }, { workspace, store });
	await seed.run("old data ".repeat(2000));
	await seed.run("Recent requirement");
	const raw = seed.history;
	let calls = 0;
	const session = await SessionManager.open({ maxIterations: 8, compactionModel: async (messages) => {
		assert.ok(!JSON.stringify(messages).includes("CURRENT_PROMPT"));
		return answer();
	}, model: async (_messages, _signal, observe) => {
		calls++;
		if (calls === 1) return rejectRequest(observe);
		const saved = await store.load(workspace, seed.current.id);
		assert.ok(saved.compaction);
		assert.equal(saved.attempt?.status, "running");
		assert.equal(saved.attempt?.prompt, "CURRENT_PROMPT");
		assert.deepEqual(saved.history, raw);
		throw new HarnessError("MODEL_CONNECTION", "Injected continuation failure");
	} }, { workspace, store, selection: { resume: seed.current.id } });
	await assert.rejects(session.run("CURRENT_PROMPT"), code("MODEL_CONNECTION"));
	const saved = await store.load(workspace, seed.current.id);
	assert.ok(saved.compaction);
	assert.equal(saved.attempt?.status, "failed");
	assert.deepEqual(saved.history, raw);
	const resumed = await SessionManager.open({ maxIterations: 8, model: async (messages) => {
		assert.match(JSON.stringify(messages), /CURRENT_PROMPT/);
		assert.match(JSON.stringify(messages), /Do not automatically replay/);
		assert.match(JSON.stringify(messages), /Keep amber/);
		return answer();
	} }, { workspace, store, selection: { resume: seed.current.id } });
	await resumed.run("Inspect current state");
	assert.equal(resumed.current.turnCount, 3);
	await resumed.fork();
	assert.ok(resumed.context.summarizedMessages > 0);
});

for (const failure of ["cancelled", "invalid", "storage"] as const) {
	test(`automatic compaction ${failure} preserves old projection and does not continue`, async (t) => {
		const { base, workspace } = await temporaryWorkspace(t);
		class FailingStore extends SessionStore {
			override async save(...args: Parameters<SessionStore["save"]>) {
				const [record] = args;
				if (failure === "storage" && record.compaction) throw new HarnessError("SESSION_STORAGE", "Injected storage failure");
				return super.save(...args);
			}
		}
		const store = new FailingStore({ root: join(base, "sessions") });
		const seed = await SessionManager.open({ maxIterations: 8, model: async () => answer() }, { workspace, store });
		await seed.run("old data ".repeat(2000));
		await seed.run("Recent");
		const abort = new AbortController();
		let calls = 0;
		const session = await SessionManager.open({ maxIterations: 8,
			model: async (_messages, _signal, observe) => { calls++; return rejectRequest(observe); },
			compactionModel: async () => {
				await assert.rejects(session.newSession(), code("SESSION_BUSY"));
				if (failure === "cancelled") abort.abort();
				return answer(failure === "invalid" ? " " : "Keep amber");
			} }, { workspace, store, selection: { resume: seed.current.id } });
		const before = session.context;
		const events: ReportEvent[] = [];
		await assert.rejects(session.run("Continue", { signal: abort.signal, onEvent: createTurnReporter((event) => events.push(event)) }),
			code({ cancelled: "CANCELLED", invalid: "CONTEXT_COMPACTION_RESPONSE", storage: "SESSION_STORAGE" }[failure]));
		assert.equal(calls, 1);
		assert.deepEqual(session.context, before);
		assert.equal(events.filter((event) => event.type === "execution_report").length, 1);
		assert.ok(!events.some((event) => event.type === "completed" || event.type === "compaction_end"));
		const saved = await store.load(workspace, seed.current.id);
		assert.equal(saved.compaction, undefined);
	});
}

test("automatic compaction keeps the turn claim while refusing another writer", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const seed = await SessionManager.open({ maxIterations: 8, model: async () => answer() }, { workspace, store });
	await seed.run("old data ".repeat(2000));
	await seed.run("Recent");
	const original = seed.history;
	let calls = 0;
	const session = await SessionManager.open({ maxIterations: 8,
		model: async (_messages, _signal, observe) => {
			if (++calls === 1) return rejectRequest(observe);
			return answer("Continued");
		},
		compactionModel: async () => {
			const concurrent = await store.load(workspace, seed.current.id);
			assert.equal(concurrent.attempt?.status, "running");
			await assert.rejects(store.save({ ...concurrent, name: "Concurrent revision" }, concurrent.revision), code("SESSION_BUSY"));
			return answer("Keep amber");
		} }, { workspace, store, selection: { resume: seed.current.id } });
	assert.equal(await session.run("Continue"), "Continued");
	const saved = await store.load(workspace, seed.current.id);
	assert.equal(calls, 2);
	assert.equal(saved.name, null);
	assert.equal(saved.attempt, null);
	assert.ok(saved.compaction);
	assert.deepEqual(saved.history.slice(0, original.length), original);
});

test("chat and Web UI expose automatic compaction inside the original conversation turn", async (t) => {
	const model: Model = async (messages, _signal, observe) => {
		if (JSON.stringify(messages).includes("x".repeat(500))) return rejectRequest(observe);
		return answer("Continued");
	};
	const options = { model, maxIterations: 8, compactionModel: async () => answer() };
	const chat = new Session(options, history());
	const output = new PassThrough();
	const error = new PassThrough();
	let log = "";
	error.on("data", (chunk) => { log += String(chunk); });
	assert.equal(await runChat(chat, { input: Readable.from(["Continue\n/exit\n"]), output, error }), 0);
	assert.match(log, /compaction_start/);
	assert.equal(chat.messages.length, 7);
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const seed = await SessionManager.open({ model: async () => answer(), maxIterations: 8 }, { workspace, store });
	await seed.run("x".repeat(10000));
	await seed.run("Recent");
	const session = await SessionManager.open(options, { workspace, store, selection: { resume: seed.current.id } });
	const controller = await WebUiController.create({ provider: "deepseek", model: "offline", workspace,
		permission: "ask", shellPermission: "ask", webPermission: "deny", maxIterations: 8,
		maxRequestBytes: 32768, skills: 0, warnings: [] }, session);
	t.after(() => controller.close());
	controller.submit("Continue");
	const deadline = performance.now() + 10000;
	while (controller.snapshot().busy && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(controller.snapshot().busy, false);
	const turn = controller.snapshot().turns.at(-1)!;
	assert.equal(turn.answer, "Continued");
	assert.ok(turn.activity.some((activity) => activity.includes("compacting older turns")));
	assert.equal(session.current.turnCount, 3);
});

test("background automation compacts only its bound session and claims a single run", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	let reject = false;
	const model: Model = async (messages, _signal, observe) => {
		if (reject && JSON.stringify(messages).includes("x".repeat(500))) return rejectRequest(observe);
		if (reject) assert.match(String(messages[0]?.content), /Automation trigger metadata/);
		return answer();
	};
	const session = await SessionManager.open({ model, maxIterations: 8, compactionModel: async (messages) => {
		assert.ok(!JSON.stringify(messages).includes("Automation trigger metadata"));
		return answer();
	} }, { workspace, store });
	await session.run("x".repeat(10000));
	await session.run("Recent requirement");
	await session.manageAutomation({ action: "create", prompt: "Review current files",
		trigger: { type: "interval", seconds: 60 }, maxRuns: 3 });
	const bound = (await session.listAutomations())[0]!;
	await session.newSession("Selected conversation");
	const selected = session.current.id;
	reject = true;
	await session.runAutomation(bound.sessionId, bound.id, Date.now(), []);
	assert.equal(session.current.id, selected);
	assert.equal(session.context.summarizedMessages, 0);
	const saved = await store.load(workspace, bound.sessionId);
	assert.ok(saved.compaction);
	assert.equal(saved.automations?.[0]?.runs, 1);
	assert.equal(saved.automations?.[0]?.lastStatus, "completed");
	assert.equal(saved.history.filter((message) => message.role === "user").length, 3);
});
