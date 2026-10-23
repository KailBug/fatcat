import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createModel } from "@fatcat/runtime/model";
import { createDeepSeekBudget } from "../src/deepseek-budget.js";
import { createDeepSeekHeadlessModel } from "../src/deepseek-headless.js";
import { runHeadlessSession } from "../src/headless.js";
import { completion } from "./fixtures/session.js";

const url = "https://api.deepseek.com/chat/completions";
const request = { method: "POST", body: JSON.stringify({ model: "deepseek-flash", stream: false, max_tokens: 16384, messages: [] }) };

describe("DeepSeek evaluation spending gate (injected, no network)", () => {
	it("uses the reviewed 1 MiB live request envelope for a long tool-history-sized request", async () => {
		let sent = 0;
		const profile = createDeepSeekHeadlessModel(32, "offline-profile-key", async (_url, init) => {
			sent++;
			assert.ok(Buffer.byteLength(String(init?.body)) > 262144);
			assert.ok(Buffer.byteLength(String(init?.body)) < 1048576);
			return completion("Completed long-context check.");
		});
		const model = createModel(profile.config, profile.createTransport());
		await model([{ role: "user", content: "Context ".repeat(40000) }]);
		assert.equal(sent, 1);
		assert.equal(profile.config.maxRequestBytes, 1048576);
		assert.equal(profile.config.requestTimeoutMs, 180000);
		await assert.rejects(model([{ role: "user", content: "Context ".repeat(150000) }]), { code: "MODEL_CONTEXT_LIMIT" });
		assert.equal(sent, 1);
	});
	it("reserves before concurrent dispatch and retains unknown/failed request costs", async () => {
		let release!: () => void;
		const wait = new Promise<void>((resolve) => { release = resolve; });
		let sent = 0;
		const budget = createDeepSeekBudget(32, async (_url, init) => {
			sent++;
			assert.equal(init?.redirect, "error");
			await wait;
			return new Response("provider unavailable", { status: 500 });
		});
		const pending = Array.from({ length: 4 }, () => budget.transport(url, request));
		await assert.rejects(budget.transport(url, request), /CNY allowance/);
		assert.equal(sent, 4);
		assert.equal(budget.snapshot().accountedCnyCeiling, 8.912896);
		release();
		await Promise.all(pending);
		assert.equal(budget.snapshot().usageComplete, false);
		assert.equal(budget.snapshot().accountedCnyCeiling, 8.912896);
		await assert.rejects(budget.transport(url, request), /CNY allowance/);
	});

	it("releases only validated usage at peak rates and records returned model identity", async () => {
		const budget = createDeepSeekBudget(2, async () => Response.json({ id: "fake-response", model: "fake-version",
			usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, prompt_cache_hit_tokens: 900 } }));
		await budget.transport(url, request);
		const snapshot = budget.snapshot();
		assert.equal(snapshot.accountedCnyCeiling, 0.001036);
		assert.equal(snapshot.usageComplete, true);
		assert.equal(snapshot.requests[0]?.responseModel, "fake-version");
		assert.ok(snapshot.requests[0]);
		snapshot.requests[0].accountedNanoCny = 0;
		assert.equal(budget.snapshot().accountedCnyCeiling, 0.001036);
		await budget.transport(url, request);
		await assert.rejects(budget.transport(url, request), /request allowance/);
	});

	it("carries earlier failed-attempt spending into the total cap without resetting it", async () => {
		let sent = 0;
		const budget = createDeepSeekBudget(32, async () => { sent++; return Response.json({}); }, 2820469360);
		for (let i = 0; i < 3; i++) await budget.transport(url, request);
		await assert.rejects(budget.transport(url, request), /CNY allowance/);
		assert.equal(sent, 3);
		assert.equal(budget.snapshot().accountedCnyCeiling, 9.50514136);
		assert.equal(budget.snapshot().currentAttemptCnyCeiling, 6.684672);
		for (const prior of [-1, 0.5, 10000000001, NaN]) assert.throws(() => createDeepSeekBudget(1, fetch, prior));
	});

	it("does not refund malformed usage, impossible counts, or transport failures", async () => {
		for (const usage of [null, { prompt_tokens: 1, completion_tokens: 1, total_tokens: 3 },
			{ prompt_tokens: 1048577, completion_tokens: 1, total_tokens: 1048578 },
			{ prompt_tokens: 1, completion_tokens: 16385, total_tokens: 16386 }]) {
			const budget = createDeepSeekBudget(1, async () => Response.json({ usage }));
			await budget.transport(url, request);
			assert.equal(budget.snapshot().accountedCnyCeiling, 2.228224);
			assert.equal(budget.snapshot().usageComplete, false);
		}
		const budget = createDeepSeekBudget(1, async () => { throw new DOMException("Aborted", "AbortError"); });
		await assert.rejects(budget.transport(url, request));
		assert.equal(budget.snapshot().accountedCnyCeiling, 2.228224);
		assert.ok(budget.snapshot().requests[0]?.finishedAt);
	});

	it("rejects different endpoints, output limits and server tools before dispatch", async () => {
		const budget = createDeepSeekBudget(8, async () => assert.fail("Unauthorized network dispatch"));
		await assert.rejects(budget.transport("https://example.invalid/chat/completions", request));
		for (const change of [{ model: "deepseek-v4-pro" }, { stream: true }, { max_tokens: 16385 },
			{ tools: [{ type: "web_search" }] }]) {
			await assert.rejects(budget.transport(url, { ...request, body: JSON.stringify({ ...JSON.parse(request.body), ...change }) }));
		}
		await assert.rejects(budget.transport(url, { ...request, signal: AbortSignal.abort() }));
		assert.equal(budget.snapshot().requests.length, 0);
		assert.equal(budget.snapshot().accountedCnyCeiling, 0);
	});

	it("shares a global allowance with the actual delegated Session and preserves evidence without credentials", async (t) => {
		const root = await mkdtemp(join(tmpdir(), "fatcat-live-contract-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const taskCwd = join(root, "task");
		await mkdir(taskCwd);
		let sent = 0;
		const budget = createDeepSeekBudget(2, async () => ++sent === 1
			? completion(null, [{ id: "delegate", type: "function", function: { name: "delegate_task", arguments: '{"task":"Return a short answer."}' } }])
			: completion("Child finished."));
		const result = await runHeadlessSession({ taskCwd, resultDirectory: join(root, "result"), instruction: "Delegate a short task.",
			permission: { files: "read-only", shell: "deny" }, requests: 8, durationMs: 30000 }, {
			evidence: "live", config: { provider: "deepseek", region: "global", model: "deepseek-flash", thinking: "high",
				apiKey: "offline-secret-never-persist", maxIterations: 8, maxRequestBytes: 262144, requestTimeoutMs: 10000 },
			createTransport: () => budget.transport, metadata: budget.snapshot,
		});
		assert.equal(result.status, "failed");
		assert.equal(result.cleanup, "removed");
		assert.equal(sent, 2);
		const raw = await readFile(result.evidenceFile, "utf8");
		assert.doesNotMatch(raw, /offline-secret-never-persist/);
		const evidence = JSON.parse(raw);
		assert.equal(evidence.model.stoppedReason, "Global request allowance exhausted.");
		assert.equal(evidence.model.requests.length, 2);
		assert.ok(evidence.session);
	});
});
