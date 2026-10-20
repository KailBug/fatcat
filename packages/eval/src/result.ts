import { parseArtifact, type ArtifactReference } from "./experiment.js";
import { amount, choice, count, digest, object, text } from "./validation.js";

export interface EvalUsage {
	requests: number;
	reportedRequests: number;
	inputTokens: number | null;
	outputTokens: number | null;
	cachedInputTokens: number | null;
}

export interface EvalResult {
	schemaVersion: "fatcat.eval.result.v1";
	experimentId: string;
	experimentDigest: string;
	sampleId: string;
	repetition: number;
	status: "completed" | "failed" | "timeout" | "cancelled" | "infra_error";
	grade: { verdict: "passed" | "failed" | "not_assessed"; reason: string; evidence: ArtifactReference[] };
	durationMs: number;
	usage: EvalUsage;
	cost: { usd: number; kind: "estimated" | "reported"; source: string } | null;
	failureReason: string | null;
}

export function parseResult(value: unknown): EvalResult {
	const record = object(value, ["schemaVersion", "experimentId", "experimentDigest", "sampleId", "repetition", "status",
		"grade", "durationMs", "usage", "cost", "failureReason"], "result");
	const status = choice(record.status, ["completed", "failed", "timeout", "cancelled", "infra_error"], "status");
	const rawGrade = object(record.grade, ["verdict", "reason", "evidence"], "grade");
	const verdict = choice(rawGrade.verdict, ["passed", "failed", "not_assessed"], "grade.verdict");
	if (!Array.isArray(rawGrade.evidence)) throw new Error("grade.evidence must be an array.");
	const evidence = rawGrade.evidence.map((item) => parseArtifact(item, "grade.evidence"));
	if (verdict !== "not_assessed" && !evidence.length) throw new Error("Assessed grades require evidence.");
	if (status !== "completed" && verdict !== "not_assessed") throw new Error("Interrupted or failed execution cannot carry a completed grade.");
	const failureReason = record.failureReason === null ? null : text(record.failureReason, "failureReason");
	if ((status === "completed") !== (failureReason === null)) throw new Error("Execution failures require a reason; completed execution has none.");
	const rawUsage = object(record.usage, ["requests", "reportedRequests", "inputTokens", "outputTokens", "cachedInputTokens"], "usage");
	const usage: EvalUsage = {
		requests: count(rawUsage.requests, "usage.requests"), reportedRequests: count(rawUsage.reportedRequests, "usage.reportedRequests"),
		inputTokens: rawUsage.inputTokens === null ? null : count(rawUsage.inputTokens, "usage.inputTokens"),
		outputTokens: rawUsage.outputTokens === null ? null : count(rawUsage.outputTokens, "usage.outputTokens"),
		cachedInputTokens: rawUsage.cachedInputTokens === null ? null : count(rawUsage.cachedInputTokens, "usage.cachedInputTokens"),
	};
	if (usage.reportedRequests > usage.requests) throw new Error("Reported requests exceed observed requests.");
	if ((usage.inputTokens === null) !== (usage.outputTokens === null)) throw new Error("Input and output coverage must agree.");
	if (usage.reportedRequests === 0 && (usage.inputTokens !== null || usage.outputTokens !== null || usage.cachedInputTokens !== null)) {
		throw new Error("Unreported usage must remain unknown.");
	}
	if (usage.cachedInputTokens !== null && (usage.inputTokens === null || usage.cachedInputTokens > usage.inputTokens)) {
		throw new Error("Cache hits must be a known subset of input tokens.");
	}
	let cost: EvalResult["cost"] = null;
	if (record.cost !== null) {
		const rawCost = object(record.cost, ["usd", "kind", "source"], "cost");
		cost = { usd: amount(rawCost.usd, "cost.usd"), kind: choice(rawCost.kind, ["estimated", "reported"], "cost.kind"), source: text(rawCost.source, "cost.source") };
		if (usage.requests !== usage.reportedRequests || usage.inputTokens === null) throw new Error("Cost requires complete usage coverage.");
	}
	return {
		schemaVersion: choice(record.schemaVersion, ["fatcat.eval.result.v1"], "schemaVersion"),
		experimentId: text(record.experimentId, "experimentId"), experimentDigest: digest(record.experimentDigest, "experimentDigest"),
		sampleId: text(record.sampleId, "sampleId"), repetition: count(record.repetition, "repetition", 1), status,
		grade: { verdict, reason: text(rawGrade.reason, "grade.reason"), evidence },
		durationMs: count(record.durationMs, "durationMs"), usage, cost, failureReason,
	};
}

export function serializeResult(value: EvalResult): string {
	return JSON.stringify(parseResult(value), null, 2) + "\n";
}

export function deserializeResult(json: string): EvalResult {
	return parseResult(JSON.parse(json));
}
