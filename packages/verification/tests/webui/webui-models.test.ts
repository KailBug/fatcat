import assert from "node:assert/strict";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { TestContext } from "node:test";
import { createAgent } from "@fatcat/runtime/agent";
import { loadConfig } from "@fatcat/runtime/config";
import { defaultModelSelection } from "@fatcat/runtime/model-catalog";
import { ModelConnections } from "@fatcat/runtime/model-connections";
import { SessionManager } from "@fatcat/runtime/session/manager";
import { SessionStore } from "@fatcat/runtime/session/store";
import { createTools } from "@fatcat/runtime/tools";
import { WebUiController } from "@fatcat/webui/internal/controller";
import { startWebUiServer } from "@fatcat/webui/internal/server";
import { temporaryWorkspace } from "../support/workspace.js";

async function fixture(t: TestContext, wait?: Promise<void>) {
	const { base, workspace } = await temporaryWorkspace(t);
	const config = { ...loadConfig({ DEEPSEEK_API_KEY: "offline-private-deepseek" }), thinking: "off" as const };
	const connections = new ModelConnections(config, { MOONSHOT_API_KEY: "offline-private-kimi" });
	let requests = 0;
	const agent = { ...createAgent(config, await createTools(workspace), async () => {
		requests++; await wait;
		return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Completed answer" } }],
			usage: { prompt_tokens: 900, completion_tokens: 20, total_tokens: 920 } });
	}, undefined, undefined, undefined, undefined, connections), inputCounter: {
		supports: () => true,
		count: async () => ({ inputTokens: 123, method: "injected fixture", approximate: true, limitations: [] }),
	} };
	const store = new SessionStore({ root: join(base, "sessions") });
	const manager = await SessionManager.open(agent, { workspace, store, deferEmptySessions: true });
	const controller = await WebUiController.create({ workspace, provider: config.provider, model: config.model,
		permission: "ask", shellPermission: "ask", webPermission: "deny", maxIterations: 3, maxRequestBytes: config.maxRequestBytes,
		skills: 0, warnings: [] }, manager);
	const server = await startWebUiServer(controller, 0);
	t.after(() => server.close());
	const token = new URL(server.url).hash.slice("#token=".length);
	const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${server.origin}/api/${path}`, {
		method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
	});
	const change = (selection = { ...defaultModelSelection("deepseek"), thinking: "medium" as const }) => ({
		sessionId: manager.current.id, revision: manager.current.revision, previous: manager.current.modelSelection, selection,
	});
	return { manager, controller, store, post, change, requests: () => requests, server };
}

test("Web model API validates authentication, shape, supported choices and stale draft selections", async (t) => {
	const f = await fixture(t);
	const original = f.manager.current;
	const request = f.change();
	assert.equal((await f.post("model", request, { Authorization: "" })).status, 401);
	assert.equal((await f.post("model", request, { Origin: "https://untrusted.invalid" })).status, 403);
	for (const body of [{ ...request, extra: true }, { ...request, revision: -1 }, { ...request, selection: null },
		{ ...request, selection: { ...request.selection, thinking: "unsupported" } }]) {
		assert.equal((await f.post("model", body)).status, 400);
	}
	assert.equal((await f.post("model", { ...request, selection: { ...request.selection, thinking: "on" } })).status, 400);
	assert.equal((await f.post("model", { ...request, selection: defaultModelSelection("mimo") })).status, 400);
	assert.deepEqual(f.manager.current, original);
	assert.equal((await f.post("model", request)).status, 202);
	assert.equal(f.manager.current.modelSelection?.thinking, "medium");
	assert.equal(f.manager.current.revision, 0, "Changing a draft does not publish it");
	assert.equal((await f.post("model", request)).status, 409, "Previous selection detects stale drafts at the same revision");
	assert.equal((await f.post("model", { ...f.change(), sessionId: "other-session" })).status, 409);
	assert.equal((await f.post("model", { ...f.change(), revision: 1 })).status, 409);
	assert.equal(f.requests(), 0, "Switch and preview never generate");
	const state = f.controller.snapshot();
	assert.ok(state.modelChoices.some((choice) => !choice.available && choice.reason));
	assert.ok(state.modelChoices.some((choice) => choice.available && choice.selection.provider === "kimi"));
	assert.ok(!JSON.stringify(state).includes("offline-private"));
	assert.ok(!JSON.stringify(state.modelChoices).includes("apiKey"));
	assert.deepEqual(state.contextUsage, f.manager.contextUsage, "Web forwards the runtime snapshot");
	assert.equal(state.contextUsage?.estimate.inputTokens, 123);
	assert.equal((await f.post("context/refresh", { draft: "excluded" })).status, 400);
	assert.equal((await f.post("context/refresh", {})).status, 202);
	assert.equal(f.requests(), 0);
});

test("Web snapshots separate current estimate, reported input and restored cumulative usage across model changes", async (t) => {
	const f = await fixture(t);
	for (const prompt of ["First", "Second"]) {
		f.controller.submit(prompt);
		const deadline = Date.now() + 10_000;
		while (f.controller.snapshot().busy && Date.now() < deadline) await delay(5);
		assert.equal(f.controller.snapshot().busy, false);
	}
	const before = f.controller.snapshot();
	assert.equal(before.contextUsage?.consumption.tokens?.totalTokens, 1840);
	assert.equal(before.contextUsage?.lastReportedInput?.inputTokens, 900);
	assert.equal(before.contextUsage?.estimate.inputTokens, 123);
	const kimi = defaultModelSelection("kimi", "cn", "kimi-k2.6");
	assert.equal((await f.post("model", { ...f.change(), selection: kimi })).status, 202);
	const switched = f.controller.snapshot().contextUsage!;
	assert.deepEqual(switched.estimate.selection, kimi);
	assert.equal(switched.windowCapacityTokens, 262144);
	assert.deepEqual(switched.lastReportedInput, before.contextUsage?.lastReportedInput);
	assert.deepEqual(switched.consumption, before.contextUsage?.consumption);
	assert.deepEqual((await f.store.loadAny(before.current.id)).modelSelection, kimi);
	await f.controller.newSession();
	assert.equal(f.controller.snapshot().contextUsage?.lastReportedInput, null);
	await f.controller.resume(before.current.id);
	assert.deepEqual(f.controller.snapshot().current.modelSelection, kimi);
	assert.equal(f.controller.snapshot().contextUsage?.estimate.inputTokens, 123);
	assert.deepEqual(f.controller.snapshot().contextUsage?.consumption, switched.consumption);
	assert.equal(f.requests(), 2);
});

test("Web busy model requests are rejected and context refresh cannot run tools or generate", async (t) => {
	let release!: () => void;
	const pending = new Promise<void>((resolve) => { release = resolve; });
	const f = await fixture(t, pending);
	try {
		f.controller.submit("Wait");
		assert.equal((await f.post("model", f.change())).status, 409);
		assert.equal((await f.post("context/refresh", {})).status, 202);
		assert.equal(f.controller.snapshot().contextUsage?.estimate.status, "pending");
		assert.equal(f.controller.snapshot().contextUsage?.estimate.inputTokens, null);
		assert.equal(f.manager.current.modelSelection?.thinking, "off");
	} finally { release(); }
	const deadline = Date.now() + 10_000;
	while (f.controller.snapshot().busy && Date.now() < deadline) await delay(5);
	assert.equal(f.controller.snapshot().busy, false);
	assert.equal(f.requests(), 1);
	assert.equal(f.controller.snapshot().contextUsage?.estimate.status, "ready");
});

test("failed context refresh still settles turns and committed management without replay", async (t) => {
	const f = await fixture(t);
	f.manager.previewContext = async () => { throw new Error("Injected preview failure"); };
	f.controller.submit("Complete despite preview failure");
	const deadline = Date.now() + 10_000;
	while (f.controller.snapshot().busy && Date.now() < deadline) await delay(5);
	assert.equal(f.controller.snapshot().busy, false);
	assert.equal(f.controller.snapshot().turns[0]?.status, "answered");
	assert.equal(f.controller.snapshot().status, "Context preview could not be refreshed");
	assert.equal(f.controller.snapshot().contextUsage?.estimate.status, "pending");
	assert.equal((await f.post("model", f.change())).status, 202);
	assert.equal(f.controller.snapshot().busy, false);
	assert.equal(f.manager.current.modelSelection?.thinking, "medium");
	assert.equal((await f.store.loadAny(f.manager.current.id)).modelSelection?.thinking, "medium");
	assert.equal(f.requests(), 1);
	assert.equal((await f.post("context/refresh", {})).status, 500);
});
