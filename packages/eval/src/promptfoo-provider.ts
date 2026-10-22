import type { ProviderResponse } from "promptfoo/contracts";
import { count, text } from "./validation.js";
import { runSessionEvaluation, type SessionEvaluationDependencies, type SessionEvaluationOptions } from "./session-runner.js";

/** Promptfoo owns test presentation; Fatcat owns the complete Session execution. */
export default class FatcatProvider {
	private readonly name: string;
	private readonly evaluation: SessionEvaluationOptions;

	constructor(options: { id?: string; config: SessionEvaluationOptions }, private readonly dependencies: SessionEvaluationDependencies) {
		this.name = options.id ?? "fatcat-session";
		this.evaluation = structuredClone(options.config);
	}

	id(): string { return this.name; }

	async callApi(prompt: string, context?: { vars: Record<string, unknown>; repeatIndex?: number },
		options?: { abortSignal?: AbortSignal }): Promise<ProviderResponse> {
		const sampleId = text(context?.vars.sampleId, "sampleId");
		const repetition = count(context?.vars.repetition ?? (context?.repeatIndex ?? 0) + 1, "repetition", 1);
		// The prompt is an identifier, not a second source of untracked task instructions.
		if (prompt !== sampleId) throw new Error("Promptfoo prompt must be exactly the declared sample ID.");
		const evaluation = await runSessionEvaluation(this.evaluation, this.dependencies, { sampleId, repetition }, options?.abortSignal);
		const { result, answer, artifactDirectory, evidence } = evaluation;
		const usage = result.usage;
		const completeUsage = usage.requests === usage.reportedRequests && usage.inputTokens !== null && usage.outputTokens !== null
			&& Number.isSafeInteger(usage.inputTokens + usage.outputTokens);
		return {
			...(result.status === "completed" ? { output: answer! } : { error: result.failureReason! }),
			...(completeUsage ? { tokenUsage: { prompt: usage.inputTokens!, completion: usage.outputTokens!,
				total: usage.inputTokens! + usage.outputTokens!, numRequests: usage.requests } } : {}),
			cached: false,
			metadata: { result, artifactDirectory, evidence },
		};
	}
}
