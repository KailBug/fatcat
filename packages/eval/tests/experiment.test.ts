import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { experimentDigest, parseExperiment } from "../src/experiment.js";
import { experimentFixture } from "./fixtures/experiments.js";

describe("experiment protocol", () => {
	it("round-trips the declared settings without retaining mutable input references", () => {
		const original = experimentFixture();
		const parsed = parseExperiment(JSON.parse(JSON.stringify(original)));
		assert.deepEqual(parsed, original);
		const fingerprint = experimentDigest(parsed);
		original.dataset.selectedIds[0] = "changed";
		assert.equal(experimentDigest(parsed), fingerprint);
	});

	it("binds results to code, model, data, prompt, policy, budgets and grader settings", () => {
		const original = experimentFixture();
		const fingerprint = experimentDigest(original);
		for (const change of [
			(value: typeof original) => { value.code.gitSha = "c".repeat(40); },
			(value: typeof original) => { value.model.parameters.temperature = 1; },
			(value: typeof original) => { value.dataset.manifest.sha256 = "c".repeat(64); },
			(value: typeof original) => { value.prompt.version = "2"; },
			(value: typeof original) => { value.policy.version = "2"; },
			(value: typeof original) => { value.grader.version = "2"; },
			(value: typeof original) => { value.budget.perAttempt.requests++; },
		]) {
			const candidate = structuredClone(original);
			change(candidate);
			assert.notEqual(experimentDigest(candidate), fingerprint);
		}
		const reordered = Object.fromEntries(Object.entries(original).reverse());
		assert.equal(experimentDigest(parseExperiment(reordered)), fingerprint);
	});

	it("rejects overlap, duplicate IDs, undeclared samples and false full coverage", () => {
		for (const change of [
			(value: ReturnType<typeof experimentFixture>) => { value.dataset.holdoutIds.push("fresh-marker"); },
			(value: ReturnType<typeof experimentFixture>) => { value.dataset.selectedIds.push("fresh-marker"); },
			(value: ReturnType<typeof experimentFixture>) => { value.dataset.developmentIds.push("unknown"); },
			(value: ReturnType<typeof experimentFixture>) => { value.dataset.selectedIds = ["holdout-marker"]; },
			(value: ReturnType<typeof experimentFixture>) => { value.dataset.coverage = "full"; },
			(value: ReturnType<typeof experimentFixture>) => { value.dataset.selectedIds = []; },
		]) {
			const value = experimentFixture();
			change(value);
			assert.throws(() => parseExperiment(value));
		}
		const full = experimentFixture();
		full.dataset.developmentIds = [...full.dataset.sampleIds];
		full.dataset.holdoutIds = [];
		full.dataset.selectedIds = [...full.dataset.sampleIds];
		full.dataset.coverage = "full";
		assert.equal(parseExperiment(full).dataset.coverage, "full");
	});

	it("rejects malformed versions, limits, identities and credential fields without echoing values", () => {
		const original = experimentFixture();
		for (const value of [
			{ ...original, schemaVersion: "future" }, { ...original, repetitions: 0 }, { ...original, repetitions: 1.5 },
			{ ...original, code: { gitSha: "abc", dirty: false } },
			{ ...original, apiKey: "fake-secret" },
			{ ...original, model: { ...original.model, parameters: { apiKey: "fake-secret" } } },
			{ ...original, budget: { ...original.budget, perAttempt: { ...original.budget.perAttempt, tokens: NaN } } },
			{ ...original, budget: { ...original.budget, experiment: { ...original.budget.experiment, costUsd: -1 } } },
		]) {
			assert.throws(() => parseExperiment(value), (error: unknown) => error instanceof Error && !error.message.includes("fake-secret"));
		}
	});
});
