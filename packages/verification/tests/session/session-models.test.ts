import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createAgent } from "@fatcat/runtime/agent";
import { loadConfig } from "@fatcat/runtime/config";
import { defaultModelSelection } from "@fatcat/runtime/model-catalog";
import { ModelConnections } from "@fatcat/runtime/model-connections";
import { createModel } from "@fatcat/runtime/model";
import type { Message } from "@fatcat/runtime/model";
import { prepareCompaction } from "@fatcat/runtime/context/compaction";
import { validateHistory } from "@fatcat/runtime/internal/session/history";
import { systemPrompt } from "@fatcat/runtime/internal/system-prompt";
import { SessionManager } from "@fatcat/runtime/session/manager";
import { SessionStore } from "@fatcat/runtime/session/store";
import { workspaceKey } from "@fatcat/runtime/session/record";
import { createTools } from "@fatcat/runtime/tools";
import { temporaryWorkspace } from "../support/workspace.js";

const config = loadConfig({ DEEPSEEK_API_KEY: "offline-startup" });
const kimi = defaultModelSelection("kimi", "cn", "kimi-k3");
const response = (message: Record<string, unknown> = { role: "assistant", content: "Done" }) => Response.json({
	choices: [{ finish_reason: message.tool_calls ? "tool_calls" : "stop", message }],
	usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
});
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

describe("session-owned model selection", () => {
	it("persists selection, restores and forks it, and gives a new session the startup default", async (t) => {
		const { base, workspace } = await temporaryWorkspace(t);
		const store = new SessionStore({ root: join(base, "sessions") });
		const requests: Record<string, unknown>[] = [];
		const transport: typeof fetch = async (input, init) => {
			const request = new Request(input, init);
			const body = await request.json() as Record<string, unknown>;
			requests.push(body);
			assert.equal(request.headers.get("authorization"), body.model === kimi.model ? "Bearer offline-kimi" : "Bearer offline-startup");
			return response();
		};
		const agent = createAgent(config, await createTools(workspace), transport, undefined, undefined, undefined, undefined,
			new ModelConnections(config, { MOONSHOT_API_KEY: "offline-kimi" }));
		const manager = await SessionManager.open(agent, { workspace, store });
		const first = manager.current.id;
		await manager.setModel(kimi);
		assert.equal(requests.length, 0);
		await manager.run("First");
		assert.equal(requests.at(-1)?.model, kimi.model);
		assert.equal(requests.at(-1)?.reasoning_effort, "max");
		const disk = await readFile(join(store.root, workspaceKey(workspace), `${first}.json`), "utf8");
		assert.equal(JSON.parse(disk).version, 3);
		assert.ok(!disk.includes("offline-kimi"));
		await manager.fork("alternative");
		assert.deepEqual(manager.current.modelSelection, kimi);
		await manager.newSession();
		assert.deepEqual(manager.current.modelSelection, defaultModelSelection("deepseek"));
		await manager.resume(first);
		assert.deepEqual(manager.current.modelSelection, kimi);
		const reopened = await SessionManager.open(agent, { workspace, store, selection: { resume: first } });
		await reopened.run("Continue");
		assert.equal(requests.at(-1)?.model, kimi.model);
		assert.equal(reopened.current.turnCount, 2);
		assert.ok(!JSON.stringify(requests).includes("modelContext"));
		const copy = reopened.current.modelSelection!;
		copy.model = "mutated";
		assert.equal(reopened.current.modelSelection?.model, kimi.model);
	});

	it("keeps a draft unpublished and preserves state on invalid selection, missing credentials and save failure", async (t) => {
		const { base, workspace } = await temporaryWorkspace(t);
		const store = new SessionStore({ root: join(base, "sessions") });
		const agent = createAgent(config, await createTools(workspace), async () => response());
		const manager = await SessionManager.open(agent, { workspace, store, deferEmptySessions: true });
		await manager.setModel({ ...defaultModelSelection("deepseek"), thinking: "ultra" });
		assert.equal(manager.current.revision, 0);
		assert.equal((await manager.list()).length, 0);
		const before = manager.current;
		await assert.rejects(manager.setModel(kimi), { code: "MODEL_UNAVAILABLE" });
		await assert.rejects(manager.setModel({ ...kimi, thinking: "off" }), { code: "MODEL_SELECTION" });
		assert.deepEqual(manager.current, before);
		await manager.run("Publish");
		const saved = manager.current;
		const history = manager.history;
		const original = store.save;
		store.save = async () => { throw new Error("Injected save failure"); };
		await assert.rejects(manager.setModel(defaultModelSelection("deepseek")), /Injected save failure/);
		store.save = original;
		assert.deepEqual(manager.current, saved);
		assert.deepEqual(manager.history, history);
		assert.equal((await store.loadAny(saved.id)).modelSelection?.thinking, "ultra");
	});

	it("refuses switching during a turn and after a competing revision", async (t) => {
		const { base, workspace } = await temporaryWorkspace(t);
		const store = new SessionStore({ root: join(base, "sessions") });
		const gate = deferred();
		const entered = deferred();
		const agent = createAgent(config, await createTools(workspace), async () => {
			entered.resolve(); await gate.promise; return response();
		});
		const manager = await SessionManager.open(agent, { workspace, store });
		const running = manager.run("Wait");
		await entered.promise;
		await assert.rejects(manager.setModel({ ...defaultModelSelection("deepseek"), thinking: "high" }), { code: "SESSION_BUSY" });
		gate.resolve();
		await running;
		const competitor = await SessionManager.open(agent, { workspace, store, selection: { resume: manager.current.id } });
		await competitor.setModel({ ...defaultModelSelection("deepseek"), thinking: "high" });
		await assert.rejects(manager.setModel(defaultModelSelection("deepseek")), { code: "SESSION_CONFLICT" });
		assert.equal(manager.current.modelSelection?.thinking, "medium");
	});

	it("reads a saved unavailable model without fallback and can explicitly recover", async (t) => {
		const { base, workspace } = await temporaryWorkspace(t);
		const store = new SessionStore({ root: join(base, "sessions") });
		const tools = await createTools(workspace);
		let calls = 0;
		const transport: typeof fetch = async () => { calls++; return response(); };
		const configured = createAgent(config, tools, transport, undefined, undefined, undefined, undefined,
			new ModelConnections(config, { MOONSHOT_API_KEY: "offline-kimi" }));
		const first = await SessionManager.open(configured, { workspace, store });
		await first.setModel(kimi);
		await first.run("Keep this transcript");
		const second = await SessionManager.open(createAgent(config, tools, transport),
			{ workspace, store, selection: { resume: first.current.id } });
		assert.deepEqual(second.current.modelSelection, kimi);
		assert.equal(second.current.turnCount, 1);
		await assert.rejects(second.run("Do not fall back"), { code: "MODEL_UNAVAILABLE" });
		assert.equal(calls, 1);
		await second.setModel(defaultModelSelection("deepseek"));
		await second.run("Recover explicitly");
		assert.equal(calls, 2);
	});

	it("adopts the startup identity for legacy records without rewriting on read", async (t) => {
		const { base, workspace } = await temporaryWorkspace(t);
		const store = new SessionStore({ root: join(base, "sessions") });
		const legacy = await SessionManager.open({ model: async () => ({ message: { role: "assistant", content: "Old" }, toolCalls: [] }),
			maxIterations: 1 }, { workspace, store });
		const path = join(store.root, workspaceKey(workspace), `${legacy.current.id}.json`);
		const before = await readFile(path, "utf8");
		assert.equal(JSON.parse(before).version, 2);
		const manager = await SessionManager.open(createAgent(config, await createTools(workspace), async () => response()),
			{ workspace, store, selection: { resume: legacy.current.id } });
		assert.deepEqual(manager.current.modelSelection, defaultModelSelection("deepseek"));
		assert.equal(await readFile(path, "utf8"), before);
		await manager.run("Upgrade on write");
		assert.equal(JSON.parse(await readFile(path, "utf8")).version, 3);
	});
});

describe("provider reasoning history projection", () => {
	const tool = { id: "sum-call", type: "function", function: { name: "sum", arguments: '{"numbers":[1,2]}', provider_tag: "preserve" } };
	const raw = { role: "assistant", content: null, reasoning_content: "PRIVATE_REASONING", tool_calls: [tool], opaque_state: { signature: "opaque" } };

	it("round trips the full K3 assistant through tools and persistence, but isolates foreign models and summaries", async (t) => {
		const { base, workspace } = await temporaryWorkspace(t);
		const store = new SessionStore({ root: join(base, "sessions") });
		const bodies: { model: string; messages: Record<string, unknown>[] }[] = [];
		const transport: typeof fetch = async (input, init) => {
			const body = await new Request(input, init).json() as typeof bodies[number];
			bodies.push(body);
			return response(bodies.length === 1 ? raw : { role: "assistant", content: "3", reasoning_content: "PRIVATE_FINAL" });
		};
		const agent = createAgent({ ...config, ...kimi, apiKey: "offline-kimi" }, await createTools(workspace), transport);
		const manager = await SessionManager.open(agent, { workspace, store });
		await manager.run("Add one and two");
		assert.deepEqual(bodies[1]!.messages.find((message) => message.role === "assistant"), raw);
		assert.equal(bodies[1]!.messages.at(-1)?.role, "tool");
		const resumed = await SessionManager.open(agent, { workspace, store, selection: { resume: manager.current.id } });
		await resumed.run("Continue");
		assert.deepEqual(bodies[2]!.messages.find((message) => message.role === "assistant"), raw);
		assert.ok(!JSON.stringify(bodies).includes("modelContext"));
		const plan = prepareCompaction(resumed.history, undefined);
		assert.ok(!plan.chunks.join("").includes("PRIVATE_"));
		assert.ok(!plan.chunks.join("").includes("opaque_state"));
		assert.ok(plan.chunks.join("").includes("sum-call"));
		for (const destination of [defaultModelSelection("deepseek"), defaultModelSelection("kimi", "global", "kimi-k3"),
			defaultModelSelection("kimi", "cn", "kimi-k2.7-code")]) {
			await createModel({ ...config, ...destination }, async (input, init) => {
				const body = await new Request(input, init).text();
				assert.ok(!body.includes("PRIVATE_"));
				assert.ok(!body.includes("opaque_state"));
				assert.ok(!body.includes("modelContext"));
				assert.ok(body.includes("sum-call"));
				return response();
			})(resumed.history);
		}
	});

	it("removes reasoning when disabled or auxiliary, includes its real wire bytes when enabled, and rejects altered tool facts", async () => {
		const selection = { ...defaultModelSelection("deepseek"), thinking: "high" as const };
		const first = await createModel({ ...config, ...selection }, async () => response(raw))([{ role: "user", content: "Add" }]);
		const history: Message[] = [{ role: "system", content: systemPrompt }, { role: "user", content: "Add" }, first.message,
			{ role: "tool", tool_call_id: "sum-call", content: "3" }, { role: "assistant", content: "3" }];
		assert.deepEqual(validateHistory(history), history);
		const invalid = structuredClone(history);
		const assistant = invalid[2];
		if (assistant?.role !== "assistant") throw new Error("Missing fixture assistant");
		assistant.modelContext!.message.tool_calls![0]!.id = "changed";
		assert.throws(() => validateHistory(invalid), { code: "SESSION_CORRUPT" });
		let calls = 0;
		let inputBytes = 0;
		const model = createModel({ ...config, ...selection }, async (input, init) => {
			const text = await new Request(input, init).text();
			assert.equal(Buffer.byteLength(text), inputBytes);
			assert.equal(text.includes("PRIVATE_REASONING"), calls++ === 0);
			assert.ok(!text.includes("modelContext"));
			return response();
		});
		const observe = (event: { type: string; bytes?: number }) => { if (event.type === "model_input") inputBytes = event.bytes!; };
		await model(history, undefined, observe);
		await model(history, undefined, observe, { toolChoice: "none", purpose: "compaction" });
		await createModel({ ...config, thinking: "off" }, async (input, init) => {
			assert.ok(!(await new Request(input, init).text()).includes("PRIVATE_REASONING"));
			return response();
		})(history);
		let sent = false;
		await assert.rejects(createModel({ ...config, ...selection, maxRequestBytes: 32 }, async () => {
			sent = true; return response();
		})(history), { code: "MODEL_CONTEXT_LIMIT" });
		assert.equal(sent, false);
	});
});
