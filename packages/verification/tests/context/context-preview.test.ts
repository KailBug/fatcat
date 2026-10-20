import { preparedChatRequest, type ChatRequest } from "../support/chat-protocol.js";
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createAgent } from "@fatcat/runtime/agent";
import { loadConfig } from "@fatcat/runtime/config";
import { createModel } from "@fatcat/runtime/model";
import type { Message } from "@fatcat/runtime/model-types";
import { defaultModelSelection } from "@fatcat/runtime/model-catalog";
import { ModelConnections } from "@fatcat/runtime/model-connections";
import { SessionManager } from "@fatcat/runtime/session/manager";
import { SessionStore } from "@fatcat/runtime/session/store";
import { workspaceKey } from "@fatcat/runtime/session/record";
import { createTools } from "@fatcat/runtime/tools";
import { estimateRequest } from "@fatcat/runtime/internal/context/estimate";
import type { InputTokenCounter } from "@fatcat/runtime/internal/context/estimate";
import type { PreparedModelRequest } from "@fatcat/runtime/internal/model-preparation";
import { prepareRequestContext } from "@fatcat/runtime/internal/context/request";
import { MetadataTransactions } from "@fatcat/runtime/internal/metadata/transaction";
import { MemoryStore } from "@fatcat/runtime/internal/memory/store";
import { addUsage, cacheHitRate, decodeConsumption, decodeObservation, emptyConsumption } from "@fatcat/runtime/internal/context/accounting";
import { parseTokenUsage } from "@fatcat/runtime/model-usage";
import { temporaryWorkspace } from "../support/workspace.js";

const config = loadConfig({ DEEPSEEK_API_KEY: "offline-context-preview" });
const response = (content = "Completed", input = 800) => Response.json({
	choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
	usage: { prompt_tokens: input, completion_tokens: 20, total_tokens: input + 20,
		prompt_tokens_details: { cached_tokens: input / 2 }, completion_tokens_details: { reasoning_tokens: 10 } },
});
function counter(capture: (request: PreparedModelRequest) => void = () => {}): InputTokenCounter {
	return { supports: () => true, count: async (request) => {
		capture(request);
		return { inputTokens: JSON.stringify(preparedChatRequest(request).messages).length, method: "fixture character counter",
			approximate: true, limitations: ["Injected fixture, not a production tokenizer."] };
	} };
}
function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

describe("read-only request preparation", () => {
	it("estimates real Chinese replies, punctuation, emoji and Unicode tool results without dropping the entire context", async () => {
		let sent = 0;
		const model = createModel(config, async () => { sent++; return response(); });
		const history: Message[] = [{ role: "system", content: "Rules" }, { role: "user", content: "\u4f60\u597d" }];
		const before = await estimateRequest(await model.prepare!(history), 1);
		for (const content of ["\u4f60\u597d\uff01\u6709\u4ec0\u4e48\u9700\u8981\u6211\u5e2e\u5fd9\u7684\u5417\uff1f", "\u201c\u4e2d\u6587\u201d\uff0c\u6587\u4ef6\u8def\u5f84\uff1aD:\\work\u3002", "\ud83d\udc08 caf\u00e9 e\u0301 \u65e5\u672c\u8a9e\u3067\u3059"]) {
			const prepared = await model.prepare!([...history, { role: "assistant", content }]);
			const current = await estimateRequest(prepared, 2);
			assert.equal(current.status, "ready");
			if (current.status !== "ready" || before.status !== "ready") throw new Error("Expected text estimates");
			assert.ok(current.inputTokens > before.inputTokens);
			assert.equal(current.approximate, true);
			assert.match(current.method, /Unicode.*fallback/);
			assert.match(current.limitations.join(" "), /not an exact tokenizer/);
		}
		const tools: Message[] = [...history, { role: "assistant", content: null, toolCalls: [
			{ id: "read", name: "read", arguments: "{}" },
		] }, { role: "tool", callId: "read", content: "\u7ed3\u679c\uff1a\u5b8c\u6210\u3002 \u2713" }];
		assert.equal((await estimateRequest(await model.prepare!(tools), 3)).status, "ready");
		assert.equal(sent, 0);
	});

	it("weights DeepSeek cache hits by covered input, derives hits from misses, and does not add reasoning twice", () => {
		let consumption = emptyConsumption(true);
		assert.equal(cacheHitRate(consumption), null);
		for (const raw of [
			{ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100 },
			{ prompt_tokens: 300, completion_tokens: 20, total_tokens: 320, prompt_cache_miss_tokens: 60, completion_tokens_details: { reasoning_tokens: 15 } },
			{ prompt_tokens: 500, completion_tokens: 20, total_tokens: 520 },
		]) consumption = addUsage({ ...consumption, requests: consumption.requests + 1 }, parseTokenUsage(raw)!);
		assert.deepEqual(consumption.cache, { requests: 2, inputTokens: 400, hitTokens: 240 });
		assert.equal(cacheHitRate(consumption), 0.6);
		assert.deepEqual(consumption.tokens, { promptTokens: 900, completionTokens: 60, totalTokens: 960 });
		const zero = addUsage({ ...emptyConsumption(true), requests: 1 },
			{ promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedPromptTokens: 0 });
		assert.equal(cacheHitRate(zero), null);
		assert.equal(cacheHitRate({ ...consumption, cache: null }), null);
	});

	it("prepares exactly the SDK body without calling transport or mutating inputs", async () => {
		let sent: unknown;
		const model = createModel(config, async (input, init) => {
			sent = await new Request(input, init).json(); return response();
		});
		const messages: Message[] = [{ role: "system", content: "Rules" }, { role: "user", content: "Hello" }];
		const before = structuredClone(messages);
		const prepared = await model.prepare!(messages);
		assert.equal(sent, undefined);
		await model(messages);
		assert.deepEqual(preparedChatRequest(prepared), sent);
		assert.equal(prepared.bytes, Buffer.byteLength(JSON.stringify(sent)));
		assert.deepEqual(messages, before);
	});

	it("uses the same clipping boundary with completed history and an actual new turn", () => {
		const messages: Message[] = [{ role: "system", content: "Rules" }, { role: "user", content: "Old" },
			{ role: "assistant", content: null, toolCalls: [{ id: "read", name: "read", arguments: "{}" }] },
			{ role: "tool", callId: "read", content: JSON.stringify({ ok: true, result: { kind: "file", path: "a", content: "x".repeat(5000) } }) },
			{ role: "assistant", content: "Old answer" }, { role: "user", content: "Latest" }, { role: "assistant", content: "Latest answer" }];
		const preview = prepareRequestContext({ messages }, 1000, undefined, 1);
		const real = prepareRequestContext({ messages: [...messages, { role: "user", content: "New" } as Message] }, 1000);
		assert.equal(preview.omittedReadResults, 1);
		assert.deepEqual(preview.body.messages, real.body.messages.slice(0, -1));
		assert.match(String(messages[3]!.content), /xxxxx/);
	});

	it("keeps byte limits separate, marks approximation, prioritizes matching counters, and never maps unknown to zero", async () => {
		let sent = 0;
		const model = createModel({ ...config, maxRequestBytes: 1 }, async () => { sent++; return response(); });
		const prepared = await model.prepare!([{ role: "user", content: "Hello中文" }]);
		const estimate = await estimateRequest(prepared, 1);
		assert.equal(estimate.status, "ready");
		if (estimate.status !== "ready") return;
		assert.equal(estimate.approximate, true);
		assert.notEqual(estimate.inputTokens, prepared.bytes);
		assert.match(estimate.limitations.join(" "), /byte limit/);
		assert.equal(sent, 0);
		const exact: InputTokenCounter = { supports: () => true, count: async () => ({ inputTokens: 17,
			method: "fixture exact tokenizer", approximate: false, limitations: [] }) };
		assert.equal((await estimateRequest(prepared, 1, exact)).inputTokens, 17);
		for (const selection of [defaultModelSelection("kimi"), defaultModelSelection("deepseek", "global", "unknown")]) {
			const unknown = await estimateRequest({ ...prepared, selection }, 1);
			assert.equal(unknown.status, "unknown"); assert.equal(unknown.inputTokens, null);
		}
		const malformed = { ...exact, count: async () => ({ inputTokens: NaN, method: "invalid", approximate: false, limitations: [] }) };
		assert.equal((await estimateRequest(prepared, 1, malformed)).inputTokens, null);
		assert.equal((await estimateRequest({ ...prepared, json: JSON.stringify({ ...preparedChatRequest(prepared),
			messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }] }] }) }, 1)).inputTokens, null);
	});

	it("does not create absent storage, recover journals, or remove stale locks", async (t) => {
		const { base, workspace } = await temporaryWorkspace(t);
		const root = join(base, "unpublished");
		let sent = 0;
		const tools = await createTools(workspace);
		const agent = { ...createAgent(config, tools, async () => { sent++; return response(); }), inputCounter: counter() };
		const manager = await SessionManager.open(agent, { workspace, store: new SessionStore({ root }), deferEmptySessions: true });
		const before = manager.current;
		assert.equal((await manager.previewContext())?.estimate.status, "ready");
		assert.deepEqual(manager.current, before);
		assert.equal(sent, 0);
		await assert.rejects(stat(root), { code: "ENOENT" });
		await mkdir(join(root, "attachments"), { recursive: true });
		const journal = join(root, "attachments", "pending.json");
		await writeFile(journal, "{}");
		const unavailable = await manager.previewContext();
		assert.equal(unavailable?.estimate.status, "unknown");
		assert.equal(await readFile(journal, "utf8"), "{}");
		assert.deepEqual(await readdir(root), ["attachments"]);
		const locks = join(base, "locks");
		await mkdir(locks);
		await writeFile(join(locks, "metadata.lock"), JSON.stringify({ pid: 2147483647 }));
		const transactions = new MetadataTransactions(locks);
		await assert.rejects(transactions.withLock(async () => assert.fail("Must not enter"), false, true));
		assert.match(await readFile(join(locks, "metadata.lock"), "utf8"), /2147483647/);
		const memories = new MemoryStore(locks);
		await mkdir(memories.root!);
		await writeFile(join(memories.root!, "store.lock"), JSON.stringify({ pid: 2147483647 }));
		await assert.rejects(memories.list([{ kind: "session", id: manager.current.id }], undefined, true));
		assert.match(await readFile(join(memories.root!, "store.lock"), "utf8"), /2147483647/);
	});
});

describe("session context lifecycle", () => {
	it("does not infer legacy consumption and keeps cancelled or unsupported previews unknown", async (t) => {
		const { base, workspace } = await temporaryWorkspace(t);
		const store = new SessionStore({ root: join(base, "sessions") });
		const agent = createAgent(config, await createTools(workspace), async () => response());
		const original = await SessionManager.open(agent, { workspace, store });
		await original.run("Old conversation");
		const { consumption: _usage, lastReportedInput: _observation, ...legacy } = await store.loadAny(original.current.id);
		await store.save(legacy, legacy.revision);
		const restored = await SessionManager.open(agent, { workspace, store, selection: { resume: legacy.id } });
		const restoredBefore = restored.contextUsage;
		assert.equal(restoredBefore?.consumption.completeHistory, false);
		assert.equal(restoredBefore?.consumption.tokens, null);
		await restored.run("Only this request has coverage");
		assert.equal(restored.contextUsage?.consumption.completeHistory, false);
		assert.equal(restored.contextUsage?.consumption.tokens?.totalTokens, 820);
		const unsupported = await SessionManager.open({ model: async () => assert.fail("Preview cannot generate"), maxIterations: 3,
			modelSelection: defaultModelSelection("deepseek") }, { workspace, persistence: false });
		assert.equal((await unsupported.previewContext())?.estimate.status, "unknown");
		assert.equal(unsupported.contextUsage?.estimate.inputTokens, null);
		const waiting = gate(); const entered = gate();
		const counted = counter();
		const cancellable = await SessionManager.open({ ...agent, inputCounter: { ...counted, count: async (request: PreparedModelRequest) => {
			entered.resolve(); await waiting.promise; return counted.count(request);
		} } }, { workspace, persistence: false });
		const controller = new AbortController();
		const preview = cancellable.previewContext(controller.signal); await entered.promise;
		controller.abort(); waiting.resolve();
		await assert.rejects(preview, { code: "CANCELLED" });
		assert.equal(cancellable.contextUsage?.estimate.status, "pending");
		assert.deepEqual(cancellable.history, []);
	});

	it("refreshes current Memory, drops delayed results after a turn, and preserves usage from failed responses", async (t) => {
		const { base, workspace } = await temporaryWorkspace(t);
		const store = new SessionStore({ root: join(base, "sessions") });
		let prepared!: PreparedModelRequest; let calls = 0; let pause = false;
		const waiting = gate(); const entered = gate();
		const counted = counter((value) => { prepared = value; });
		const agent = { ...createAgent(config, await createTools(workspace), async () => {
			calls++;
			if (calls === 1) return response();
			if (calls === 2) return Response.json({ choices: [{ finish_reason: "length", message: { role: "assistant", content: "Incomplete" } }],
				usage: { prompt_tokens: 900, completion_tokens: 100, total_tokens: 1000 } });
			return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "No usage" } }] });
		}), inputCounter: { ...counted, count: async (request: PreparedModelRequest) => {
			if (pause) { entered.resolve(); await waiting.promise; }
			return counted.count(request);
		} } };
		const manager = await SessionManager.open(agent, { workspace, store });
		await manager.changeMemory({ action: "add", scope: "session", content: "Fresh preference" }, "Remember preference");
		assert.equal(manager.contextUsage?.estimate.status, "pending");
		await manager.previewContext();
		assert.match(JSON.stringify(preparedChatRequest(prepared).messages), /Fresh preference/);
		assert.match(JSON.stringify(preparedChatRequest(prepared).messages), new RegExp(manager.current.id));
		const before = manager.current;
		pause = true;
		const preview = manager.previewContext(); await entered.promise;
		await manager.run("Commit a new answer");
		waiting.resolve(); await preview; pause = false;
		assert.equal(manager.contextUsage?.estimate.status, "pending");
		assert.ok(manager.current.revision > before.revision);
		await assert.rejects(manager.run("Truncate"), { code: "MODEL_TRUNCATED" });
		assert.equal(manager.contextUsage?.consumption.tokens?.totalTokens, 1820);
		await manager.previewContext();
		assert.match(JSON.stringify(preparedChatRequest(prepared).messages), /Harness session recovery notice/);
		const onDisk = await store.loadAny(manager.current.id);
		assert.equal(onDisk.consumption?.tokens?.totalTokens, 1820);
		await manager.run("Missing usage");
		assert.equal(manager.contextUsage?.lastReportedInput?.inputTokens, null);
		assert.equal(manager.contextUsage?.consumption.tokens?.totalTokens, 1820);
		assert.equal(manager.contextUsage?.consumption.requests, 3);
		assert.equal(manager.contextUsage?.consumption.reportedRequests, 2);
		const unknown = manager.contextUsage!.lastReportedInput!;
		assert.equal(decodeObservation(unknown).inputTokens, null);
		assert.equal((await store.loadAny(manager.current.id)).lastReportedInput?.inputTokens, null);
	});

	it("keeps overflow unknown and validates persisted accounting instead of trusting malformed counters", () => {
		const first = addUsage({ ...emptyConsumption(true), requests: 1 },
			{ promptTokens: Number.MAX_SAFE_INTEGER, completionTokens: 0, totalTokens: Number.MAX_SAFE_INTEGER, cachedPromptTokens: Number.MAX_SAFE_INTEGER });
		const overflow = addUsage({ ...first, requests: 2 }, { promptTokens: 10, completionTokens: 1, totalTokens: 11, cachedPromptTokens: 10 });
		assert.equal(overflow.tokens, null); assert.equal(overflow.cache, null);
		assert.deepEqual(decodeConsumption(overflow), overflow);
		const later = addUsage({ ...overflow, requests: 3 }, { promptTokens: 1, completionTokens: 1, totalTokens: 2 });
		assert.equal(later.tokens, null);
		assert.throws(() => decodeConsumption({ ...first, reportedRequests: 2 }), { code: "SESSION_CORRUPT" });
		assert.throws(() => decodeConsumption({ ...first, cache: { requests: 1, inputTokens: 1, hitTokens: 2 } }), { code: "SESSION_CORRUPT" });
	});
	it("distinguishes accumulated charges, reported input and current projection; preserves them across compaction and restore", async (t) => {
		t.mock.timers.enable({ apis: ["Date"], now: Date.parse("2026-10-19T00:00:00Z") });
		const { base, workspace } = await temporaryWorkspace(t);
		const store = new SessionStore({ root: join(base, "sessions") });
		const sent: ChatRequest[] = [];
		let prepared!: PreparedModelRequest;
		const tools = await createTools(workspace);
		const agent = { ...createAgent(config, tools, async (input, init) => {
			const body = await new Request(input, init).json() as ChatRequest;
			sent.push(body); return response(body.tools ? "Answer " + "x".repeat(1000) : "Summary", 100000);
		}), inputCounter: counter((request) => { prepared = request; }) };
		const manager = await SessionManager.open(agent, { workspace, store });
		const path = join(store.root, workspaceKey(workspace), `${manager.current.id}.json`);
		const original = await readFile(path, "utf8");
		const initial = await manager.previewContext();
		assert.equal(initial?.lastReportedInput, null);
		assert.equal(initial?.consumption.tokens, null);
		assert.equal(await readFile(path, "utf8"), original);
		assert.equal(sent.length, 0);
		const draft = "Never submitted draft";
		assert.ok(!JSON.stringify(preparedChatRequest(prepared)).includes(draft));
		assert.equal(preparedChatRequest(prepared).messages.filter((message) => message.role === "user").length, 0);
		await manager.run("First");
		assert.equal(manager.contextUsage?.estimate.status, "pending");
		const first = await manager.previewContext();
		assert.equal(first?.estimate.status, "ready");
		assert.equal(first?.lastReportedInput?.inputTokens, 100000);
		assert.equal(first?.consumption.tokens?.totalTokens, 100020);
		assert.notEqual(first?.estimate.inputTokens, first?.lastReportedInput?.inputTokens);
		const beforeSecond = structuredClone(preparedChatRequest(prepared));
		await manager.run("Second");
		// Identical assembly, apart from the deliberately excluded new user message.
		assert.deepEqual(beforeSecond, { ...sent[1]!, messages: sent[1]!.messages.slice(0, -1) });
		const second = await manager.previewContext();
		assert.equal(second?.consumption.tokens?.totalTokens, 200040);
		assert.equal(second?.consumption.cache?.hitTokens, 100000);
		assert.equal(second?.consumption.cache?.inputTokens, 200000);
		assert.ok(second!.estimate.inputTokens! > first!.estimate.inputTokens!);
		assert.notEqual(second!.estimate.inputTokens! - first!.estimate.inputTokens!, 100000);
		const observed = second!.lastReportedInput;
		await manager.compact();
		assert.equal(manager.contextUsage?.estimate.status, "pending");
		const compacted = await manager.previewContext();
		assert.equal(compacted?.consumption.tokens?.totalTokens, 300060);
		assert.deepEqual(compacted?.lastReportedInput, observed);
		assert.ok(compacted!.estimate.inputTokens! < second!.estimate.inputTokens!);
		assert.match(JSON.stringify(preparedChatRequest(prepared).messages), /Summary/);
		const reopened = await SessionManager.open(agent, { workspace, store, selection: { resume: manager.current.id } });
		assert.equal(reopened.contextUsage?.estimate.status, "pending");
		assert.deepEqual(reopened.contextUsage?.consumption, compacted?.consumption);
		assert.deepEqual(reopened.contextUsage?.lastReportedInput, observed);
		await reopened.fork();
		assert.equal(reopened.contextUsage?.consumption.tokens, null);
		assert.equal(reopened.contextUsage?.lastReportedInput, null);
	});

	it("invalidates on tool results and does not execute tools from preview", async (t) => {
		const { workspace } = await temporaryWorkspace(t);
		const waiting = gate(); const entered = gate();
		let turns = 0; let executions = 0; let request!: PreparedModelRequest;
		const base = await createTools(workspace);
		const tools = { ...base, execute: async (...args: Parameters<typeof base.execute>) => { executions++; return base.execute(...args); } };
		const agent = { ...createAgent(config, tools, async () => {
			if (++turns === 1) return Response.json({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null,
				tool_calls: [{ id: "sum", type: "function", function: { name: "sum", arguments: '{"numbers":[5,7]}' } }] } }],
				usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
			entered.resolve(); await waiting.promise; return response("The result is 12");
		}), inputCounter: counter((value) => { request = value; }) };
		const manager = await SessionManager.open(agent, { workspace, persistence: false });
		await manager.previewContext();
		const revision = manager.contextUsage!.contextRevision;
		assert.equal(executions, 0);
		const running = manager.run("Calculate");
		await entered.promise;
		assert.equal((await manager.previewContext())?.estimate.status, "pending");
		assert.ok(manager.contextUsage!.contextRevision > revision);
		assert.equal(executions, 1);
		waiting.resolve(); await running;
		await manager.previewContext();
		assert.ok(preparedChatRequest(request).messages.some((message) => message.role === "tool" && String(message.content).includes("12")));
		assert.match(JSON.stringify(preparedChatRequest(request).messages), /The result is 12/);
		assert.equal(executions, 1); assert.equal(turns, 2);
	});

	it("discards delayed counts on model/thinking switch and session activation, without reusing old observed input", async (t) => {
		const { workspace } = await temporaryWorkspace(t);
		const waiting = gate(); const entered = gate();
		let pause = false;
		const counted = counter();
		const agent = { ...createAgent(config, await createTools(workspace), async () => response(), undefined, undefined, undefined, undefined,
			new ModelConnections(config, { MOONSHOT_API_KEY: "offline-kimi" })), inputCounter: { ...counted,
			count: async (request: PreparedModelRequest) => { if (pause) { entered.resolve(); await waiting.promise; } return counted.count(request); } } };
		const manager = await SessionManager.open(agent, { workspace, persistence: false });
		await manager.run("Establish observation");
		const old = manager.contextUsage!.lastReportedInput;
		pause = true;
		const preview = manager.previewContext(); await entered.promise;
		const selected = defaultModelSelection("kimi", "cn", "kimi-k3");
		await manager.setModel(selected);
		waiting.resolve(); await preview;
		assert.equal(manager.contextUsage?.estimate.status, "pending");
		assert.deepEqual(manager.contextUsage?.estimate.selection, selected);
		assert.deepEqual(manager.contextUsage?.lastReportedInput, old);
		pause = false;
		const fresh = await manager.previewContext();
		assert.equal(fresh?.estimate.status, "ready");
		assert.notEqual(fresh?.windowCapacityTokens, 1048576);
		const first = manager.current.id;
		await manager.setModel({ ...selected, thinking: "high" });
		assert.equal(manager.contextUsage?.estimate.status, "pending");
		await manager.previewContext();
		await manager.newSession();
		assert.equal(manager.contextUsage?.lastReportedInput, null);
		await manager.resume(first);
		assert.equal(manager.contextUsage?.estimate.status, "pending");
		assert.equal(manager.contextUsage?.estimate.selection.thinking, "high");
		assert.deepEqual(manager.contextUsage?.lastReportedInput, old);
	});
});
