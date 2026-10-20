import { experimentDigest, parseExperiment, type Experiment } from "./experiment.js";
import { parseResult, type EvalResult } from "./result.js";

function sum(values: readonly number[]): number | null {
	const total = values.reduce((left, right) => left + right, 0);
	return Number.isSafeInteger(total) ? total : null;
}

/** Every planned repetition remains in the denominator; missing records are never successful runs. */
export function summarizeExperiment(input: Experiment, records: readonly EvalResult[]) {
	const experiment = parseExperiment(input);
	const fingerprint = experimentDigest(experiment);
	const results = records.map(parseResult);
	const samples = new Set(experiment.dataset.selectedIds);
	const seen = new Map<string, Set<number>>();
	const statuses: Record<EvalResult["status"], number> = { completed: 0, failed: 0, timeout: 0, cancelled: 0, infra_error: 0 };
	const grades: Record<EvalResult["grade"]["verdict"], number> = { passed: 0, failed: 0, not_assessed: 0 };
	for (const result of results) {
		if (result.experimentId !== experiment.id || result.experimentDigest !== fingerprint) throw new Error("Result belongs to a different experiment configuration.");
		if (!samples.has(result.sampleId) || result.repetition > experiment.repetitions) throw new Error("Result is outside the planned sample repetitions.");
		const repetitions = seen.get(result.sampleId) ?? new Set<number>();
		if (repetitions.has(result.repetition)) throw new Error("Duplicate sample repetition; retries must not overwrite results.");
		repetitions.add(result.repetition);
		seen.set(result.sampleId, repetitions);
		statuses[result.status]++;
		grades[result.grade.verdict]++;
	}
	results.sort((a, b) => a.sampleId < b.sampleId ? -1 : a.sampleId > b.sampleId ? 1 : a.repetition - b.repetition);
	const planned = samples.size * experiment.repetitions;
	const missing = planned - results.length;
	const complete = missing === 0;
	const ungradedCompleted = results.filter((result) => result.status === "completed" && result.grade.verdict === "not_assessed").length;
	const inputTokens = sum(results.flatMap((result) => result.usage.inputTokens === null ? [] : [result.usage.inputTokens]));
	const outputTokens = sum(results.flatMap((result) => result.usage.outputTokens === null ? [] : [result.usage.outputTokens]));
	const usageComplete = complete && results.every((result) => result.usage.requests === result.usage.reportedRequests && result.usage.inputTokens !== null);
	const costs = results.flatMap((result) => result.cost === null ? [] : [result.cost]);
	const costTotal = costs.reduce((total, cost) => total + cost.usd, 0);
	const costKinds = new Set(costs.map((cost) => cost.kind));
	const costComplete = complete && costs.length === planned && Number.isFinite(costTotal) && costKinds.size === 1;
	return {
		experimentId: experiment.id, experimentDigest: fingerprint,
		evidence: experiment.evidence, level: experiment.level, split: experiment.dataset.split, coverage: experiment.dataset.coverage,
		codeClean: !experiment.code.dirty,
		planned, recorded: results.length, missing, complete, statuses, grades, ungradedCompleted,
		// A partial run or an ungraded answer has no final success rate.
		successRate: complete && ungradedCompleted === 0 ? grades.passed / planned : null,
		usage: {
			requests: sum(results.map((result) => result.usage.requests)), reportedRequests: sum(results.map((result) => result.usage.reportedRequests)),
			knownInputTokens: results.some((result) => result.usage.inputTokens !== null) ? inputTokens : null,
			knownOutputTokens: results.some((result) => result.usage.outputTokens !== null) ? outputTokens : null,
			inputTokens: usageComplete ? inputTokens : null, outputTokens: usageComplete ? outputTokens : null,
		},
		cost: { usd: costComplete ? costTotal : null, kind: costComplete ? costs[0]!.kind : null, reportedAttempts: costs.length },
		results,
	};
}
