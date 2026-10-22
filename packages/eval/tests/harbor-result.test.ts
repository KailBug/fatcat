import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { sha256 } from "../src/artifacts.js";
import { parseHarborTrialResult, readHarborTrialResult } from "../src/harbor-result.js";
import { harborTrialFixture } from "./fixtures/harbor.js";

describe("Harbor trial evidence", () => {
	it("keeps zero, fractional and named rewards without treating them as local pass/fail grades", () => {
		for (const reward of [0, 1, 0.25, -0.5]) {
			const raw = harborTrialFixture(reward);
			const result = parseHarborTrialResult(raw);
			assert.equal(result.scoring, "scored");
			assert.deepEqual(result.rewards, { reward });
			assert.equal("grade" in result, false);
			assert.equal("successRate" in result, false);
			assert.deepEqual(result.agent.model, { name: "injected-model", provider: "injected" });
			assert.equal(result.usage.inputTokens, 100);
			assert.equal(result.usage.cachedInputTokens, 20);
			assert.equal(result.usage.costUsd, null);
			raw.verifier_result.rewards.reward = 99;
			assert.equal(result.rewards?.reward, reward);
		}
		assert.deepEqual(parseHarborTrialResult({ ...harborTrialFixture(),
			verifier_result: { rewards: { correctness: 0, speed: 0.2 } } }).rewards, { correctness: 0, speed: 0.2 });
	});

	it("retains recorded rewards and usage on failed or timed-out trials", () => {
		for (const type of ["AgentTimeoutError", "VerifierTimeoutError", "EnvironmentStartError", "CancelledError"]) {
			const result = parseHarborTrialResult({ ...harborTrialFixture(1), exception_info: {
				exception_type: type, exception_message: "Synthetic failure", exception_traceback: "not copied",
			} });
			assert.equal(result.scoring, "error");
			assert.deepEqual(result.exception, { type, message: "Synthetic failure" });
			assert.equal(result.rewards?.reward, 1);
			assert.equal(result.usage.inputTokens, 100);
		}
	});

	it("does not manufacture a zero score for missing verification or execution evidence", () => {
		for (const patch of [
			{ verifier_result: null }, { verifier_result: {} }, { verifier_result: { rewards: null } },
			{ verifier_result: { rewards: {} } }, { agent_result: null }, { agent_execution: null },
			{ agent_execution: { started_at: "2026-10-22T07:00:01Z", finished_at: null } },
			{ verifier: null }, { verifier: { started_at: "2026-10-22T07:00:08Z" } }, { finished_at: null },
		]) assert.equal(parseHarborTrialResult({ ...harborTrialFixture(), ...patch }).scoring, "incomplete");
		assert.equal(parseHarborTrialResult({ ...harborTrialFixture(), verifier_result: null }).rewards, null);
	});

	it("preserves unknown and partial upstream usage without inventing requests or cost provenance", () => {
		const result = parseHarborTrialResult({ ...harborTrialFixture(), agent_result: { n_input_tokens: 17, cost_usd: 0.01 } });
		assert.deepEqual(result.usage, { inputTokens: 17, cachedInputTokens: null, outputTokens: null, costUsd: 0.01 });
		assert.equal("requests" in result.usage, false);
		assert.deepEqual(parseHarborTrialResult({ ...harborTrialFixture(), agent_result: {} }).usage,
			{ inputTokens: null, cachedInputTokens: null, outputTokens: null, costUsd: null });
		const oracle = parseHarborTrialResult({ ...harborTrialFixture(1), agent_info: { name: "oracle", version: "0.23.0" } });
		assert.equal(oracle.agent.model, null);
		assert.equal(oracle.scoring, "scored");
		assert.equal("integrationComplete" in oracle, false);
	});

	it("rejects malformed rewards, counters, identity, chronology and unsupported multi-step results", () => {
		for (const patch of [
			{ verifier_result: { rewards: { reward: NaN } } }, { verifier_result: { rewards: { reward: Infinity } } },
			{ verifier_result: { rewards: { reward: "0" } } }, { verifier_result: { rewards: { reward: false } } },
			{ verifier_result: { rewards: [] } }, { agent_result: { n_input_tokens: -1 } },
			{ agent_result: { n_cache_tokens: 101, n_input_tokens: 100 } }, { agent_result: { n_output_tokens: 0.5 } },
			{ agent_result: { cost_usd: -1 } }, { agent_info: null }, { task_checksum: "" },
			{ started_at: "not-a-date" }, { started_at: "2026-10-22T07:00:00" },
			{ finished_at: "2026-10-22T06:59:00Z" }, { started_at: null },
			{ verifier: { started_at: "2026-10-22T07:00:08Z", finished_at: "2026-10-22T07:00:11Z" } },
			{ step_results: [{ step_name: "failed", exception_info: { exception_type: "Error" } }] },
		]) assert.throws(() => parseHarborTrialResult({ ...harborTrialFixture(), ...patch }));
		assert.throws(() => parseHarborTrialResult({ stats: { reward: 1 } }));
		assert.throws(() => parseHarborTrialResult([]));
	});

	it("reads a hash-bound local artifact without rewriting it or copying private config", async (t) => {
		const root = await mkdtemp(join(tmpdir(), "fatcat-eval-harbor-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const raw = harborTrialFixture();
		raw.config = { api_key: "fake-credential" };
		const bytes = JSON.stringify(raw);
		const reference = { source: "result.json", sha256: sha256(bytes) };
		await writeFile(join(root, reference.source), bytes);
		const result = await readHarborTrialResult(root, reference);
		assert.deepEqual(result.source, reference);
		assert.equal(result.result.scoring, "scored");
		assert.doesNotMatch(JSON.stringify(result), /fake-credential|api_key/);
		assert.equal(await readFile(join(root, reference.source), "utf8"), bytes);
		await assert.rejects(readHarborTrialResult(root, { ...reference, source: "../result.json" }), /relative/);
		await writeFile(join(root, reference.source), JSON.stringify(harborTrialFixture(1)));
		await assert.rejects(readHarborTrialResult(root, reference), /digest/);
	});
});
