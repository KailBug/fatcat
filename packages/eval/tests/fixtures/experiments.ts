import { createHash } from "node:crypto";
import { experimentDigest, type Experiment } from "../../src/experiment.js";
import type { EvalResult } from "../../src/result.js";

// Synthetic protocol evidence only. These are not recorded Fatcat executions.
export function experimentFixture(): Experiment {
	const reference = { source: "synthetic:context-marker-v1", sha256: createHash("sha256").update("synthetic context marker fixture").digest("hex"), version: "1" };
	return {
		schemaVersion: "fatcat.eval.v1", id: "context-marker-demo",
		code: { gitSha: "a".repeat(40), dirty: false },
		environment: { os: "Windows synthetic fixture", node: "24.19.0", pnpm: "11.21.0" },
		evidence: "synthetic", level: "task_acceptance",
		model: { provider: "injected", id: "fixture", parameters: { temperature: 0 } },
		dataset: {
			id: "context-marker", version: "1", manifest: { source: reference.source, sha256: reference.sha256 },
			sampleIds: ["fresh-marker", "holdout-marker"], developmentIds: ["fresh-marker"], holdoutIds: ["holdout-marker"],
			selectedIds: ["fresh-marker"], split: "development", coverage: "subset",
		},
		prompt: { ...reference }, policy: { ...reference }, grader: { ...reference }, repetitions: 5,
		budget: {
			perAttempt: { requests: 9, tokens: 20000, durationMs: 60000, costUsd: null },
			experiment: { requests: 45, tokens: 100000, durationMs: 300000, costUsd: null },
		},
	};
}

export function resultFixture(experiment = experimentFixture(), repetition = 1): EvalResult {
	return {
		schemaVersion: "fatcat.eval.result.v1", experimentId: experiment.id, experimentDigest: experimentDigest(experiment),
		sampleId: experiment.dataset.selectedIds[0]!, repetition, status: "completed",
		grade: { verdict: "passed", reason: "Synthetic fresh-marker check passed.", evidence: [{ source: "synthetic:grader-output", sha256: "b".repeat(64) }] },
		durationMs: 1000, usage: { requests: 2, reportedRequests: 2, inputTokens: 100, outputTokens: 20, cachedInputTokens: null },
		cost: null, failureReason: null,
	};
}

export function mixedResults(experiment = experimentFixture()): EvalResult[] {
	const passed = resultFixture(experiment, 1);
	const failed = resultFixture(experiment, 2);
	failed.grade.verdict = "failed";
	failed.grade.reason = "Synthetic answer reused the old marker.";
	return [passed, failed, ...(["timeout", "cancelled", "infra_error"] as const).map((status, index) => ({
		...resultFixture(experiment, index + 3), status, failureReason: `Synthetic ${status}.`,
		grade: { verdict: "not_assessed" as const, reason: "Execution did not complete.", evidence: [] },
		usage: { requests: 1, reportedRequests: 0, inputTokens: null, outputTokens: null, cachedInputTokens: null },
	}))];
}
