import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { summarizeExperiment } from "../src/summary.js";
import { experimentFixture, mixedResults, resultFixture } from "./fixtures/experiments.js";

describe("experiment summary", () => {
	it("keeps all failures in the denominator and all repetitions in the report", () => {
		const experiment = experimentFixture();
		const results = mixedResults(experiment);
		const summary = summarizeExperiment(experiment, results.toReversed());
		assert.equal(summary.complete, true);
		assert.equal(summary.successRate, 1 / 5);
		assert.deepEqual(summary.statuses, { completed: 2, failed: 0, timeout: 1, cancelled: 1, infra_error: 1 });
		assert.deepEqual(summary.grades, { passed: 1, failed: 1, not_assessed: 3 });
		assert.deepEqual(summary.results, results);
		assert.equal(summary.evidence, "synthetic");
		assert.equal(summary.coverage, "subset");
		assert.deepEqual(summary.usage, { requests: 7, reportedRequests: 4, knownInputTokens: 200, knownOutputTokens: 40, inputTokens: null, outputTokens: null });
		assert.deepEqual(summary.cost, { usd: null, kind: null, reportedAttempts: 0 });
	});

	it("marks missing and ungraded results without inventing a final success rate", () => {
		const experiment = experimentFixture();
		const results = mixedResults(experiment);
		const partial = summarizeExperiment(experiment, results.slice(0, 2));
		assert.equal(partial.complete, false);
		assert.equal(partial.missing, 3);
		assert.equal(partial.successRate, null);
		const empty = summarizeExperiment(experiment, []);
		assert.equal(empty.usage.knownInputTokens, null);
		assert.equal(empty.cost.usd, null);
		results[0]!.grade = { verdict: "not_assessed", reason: "No grader", evidence: [] };
		assert.equal(summarizeExperiment(experiment, results).successRate, null);
	});

	it("rejects cherry-picked duplicates and results from different settings or sample selections", () => {
		const experiment = experimentFixture();
		const result = resultFixture(experiment);
		assert.throws(() => summarizeExperiment(experiment, [result, result]), /Duplicate/);
		assert.throws(() => summarizeExperiment(experiment, [{ ...result, sampleId: "holdout-marker" }]), /outside/);
		assert.throws(() => summarizeExperiment(experiment, [{ ...result, repetition: 6 }]), /outside/);
		const changed = structuredClone(experiment);
		changed.grader.version = "2";
		assert.throws(() => summarizeExperiment(changed, [result]), /different experiment/);
	});

	it("distinguishes complete, partial, mixed-price and overflowing totals", () => {
		const experiment = experimentFixture();
		experiment.repetitions = 2;
		const results = [resultFixture(experiment, 1), resultFixture(experiment, 2)];
		for (const result of results) result.cost = { usd: 0.25, kind: "estimated", source: "synthetic-price-v1" };
		assert.equal(summarizeExperiment(experiment, results).cost.usd, 0.5);
		assert.equal(summarizeExperiment(experiment, results).usage.inputTokens, 200);
		results[0]!.cost!.kind = "reported";
		assert.equal(summarizeExperiment(experiment, results).cost.usd, null);
		results[0]!.cost = null;
		results[0]!.usage.inputTokens = Number.MAX_SAFE_INTEGER;
		assert.equal(summarizeExperiment(experiment, results).usage.inputTokens, null);
	});

	it("labels dirty-code experiments and preserves execution failures with observed costs", () => {
		const experiment = experimentFixture();
		experiment.code.dirty = true;
		experiment.repetitions = 1;
		const result = resultFixture(experiment);
		result.status = "failed";
		result.failureReason = "Synthetic tool error";
		result.grade = { verdict: "not_assessed", reason: "Execution failed", evidence: [] };
		result.cost = { usd: 0.25, kind: "reported", source: "synthetic-receipt" };
		const summary = summarizeExperiment(experiment, [result]);
		assert.equal(summary.codeClean, false);
		assert.equal(summary.statuses.failed, 1);
		assert.equal(summary.successRate, 0);
		assert.equal(summary.cost.usd, 0.25);
	});
});
