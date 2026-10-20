import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { deserializeResult, parseResult, serializeResult } from "../src/result.js";
import { mixedResults, resultFixture } from "./fixtures/experiments.js";

describe("evaluation result records", () => {
	it("preserves all terminal outcomes through UTF-8 files, including unknown usage and cost", async (t) => {
		const directory = await mkdtemp(join(tmpdir(), "fatcat-eval-"));
		t.after(() => rm(directory, { recursive: true, force: true }));
		for (const result of mixedResults()) {
			const path = join(directory, `${result.repetition}.json`);
			await writeFile(path, serializeResult(result), "utf8");
			assert.deepEqual(deserializeResult(await readFile(path, "utf8")), result);
		}
	});

	it("requires independent grading evidence and separates execution from grading", () => {
		const result = resultFixture();
		result.grade = { verdict: "not_assessed", reason: "Answer returned without a grader.", evidence: [] };
		assert.equal(parseResult(result).status, "completed");
		assert.throws(() => parseResult({ ...result, grade: { ...result.grade, verdict: "passed" } }), /evidence/);
		assert.throws(() => parseResult({ ...resultFixture(), status: "timeout", failureReason: "Deadline" }), /grade/);
		assert.throws(() => parseResult({ ...result, status: "failed" }), /reason/);
	});

	it("retains partial usage but refuses to present it as complete cost", () => {
		const result = resultFixture();
		result.usage.requests = 3;
		assert.equal(parseResult(result).usage.inputTokens, 100);
		result.cost = { usd: 0.01, kind: "estimated", source: "fixture-price-v1" };
		assert.throws(() => parseResult(result), /complete usage/);
		result.usage.reportedRequests = 3;
		assert.equal(parseResult(result).cost?.usd, 0.01);
	});

	it("rejects inconsistent counters, nonfinite amounts, extra fields and unsupported versions", () => {
		const result = resultFixture();
		for (const value of [
			{ ...result, usage: { ...result.usage, reportedRequests: 3 } },
			{ ...result, usage: { ...result.usage, reportedRequests: 0 } },
			{ ...result, usage: { ...result.usage, cachedInputTokens: 101 } },
			{ ...result, usage: { ...result.usage, outputTokens: null } },
			{ ...result, durationMs: Infinity }, { ...result, repetition: -1 },
			{ ...result, cost: { usd: NaN, kind: "reported", source: "fixture" } },
			{ ...result, schemaVersion: "future" }, { ...result, credentials: "fake-secret" },
		]) assert.throws(() => parseResult(value));
		assert.throws(() => deserializeResult("{"));
	});
});
