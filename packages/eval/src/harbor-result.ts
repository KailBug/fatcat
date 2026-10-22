import { readArtifact } from "./artifacts.js";
import { parseArtifact, type ArtifactReference } from "./experiment.js";
import { amount, count, text } from "./validation.js";

interface Timing {
	startedAt: string | null;
	finishedAt: string | null;
}

export interface HarborTrialResult {
	trialId: string;
	trialName: string;
	taskName: string;
	taskChecksum: string;
	agent: { name: string; version: string; model: { name: string; provider: string | null } | null };
	timing: Timing;
	agentExecution: Timing | null;
	verifier: Timing | null;
	rewards: Record<string, number> | null;
	exception: { type: string; message: string } | null;
	usage: { inputTokens: number | null; cachedInputTokens: number | null; outputTokens: number | null; costUsd: number | null };
	/** Describes the saved trial, not model execution proof or benchmark acceptance. */
	scoring: "scored" | "incomplete" | "error";
	reason: string;
}

// Read the consumed Harbor fields, allowing additive upstream metadata without copying config or secrets.
function record(value: unknown, where: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${where} must be an object.`);
	return value as Record<string, unknown>;
}

function timestamp(value: unknown, where: string): string | null {
	if (value === null || value === undefined) return null;
	const result = text(value, where);
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(result)
		|| !Number.isFinite(Date.parse(result))) throw new Error(`${where} must be a timestamp with a timezone.`);
	return result;
}

function timing(value: unknown, where: string): Timing | null {
	if (value === null || value === undefined) return null;
	const raw = record(value, where);
	const startedAt = timestamp(raw.started_at, `${where}.started_at`);
	const finishedAt = timestamp(raw.finished_at, `${where}.finished_at`);
	if (finishedAt !== null && (startedAt === null || Date.parse(finishedAt) < Date.parse(startedAt))) {
		throw new Error(`${where} finishes before it starts.`);
	}
	return { startedAt, finishedAt };
}

function finished(value: Timing | null): boolean {
	return value !== null && value.startedAt !== null && value.finishedAt !== null;
}

function tokenCount(value: unknown, where: string): number | null {
	return value === null || value === undefined ? null : count(value, where);
}

/** Project a single-step Harbor trial result; never turn rewards into local exact-match grades. */
export function parseHarborTrialResult(value: unknown): HarborTrialResult {
	const raw = record(value, "Harbor trial result");
	if (raw.step_results !== null && raw.step_results !== undefined
		&& (!Array.isArray(raw.step_results) || raw.step_results.length !== 0)) {
		throw new Error("Multi-step Harbor results require a separate adapter; refusing to ignore step outcomes.");
	}
	const agent = record(raw.agent_info, "agent_info");
	const model = agent.model_info == null ? null : record(agent.model_info, "agent_info.model_info");
	const execution = raw.agent_result == null ? null : record(raw.agent_result, "agent_result");
	const verifierResult = raw.verifier_result == null ? null : record(raw.verifier_result, "verifier_result");
	const rewards = verifierResult?.rewards == null ? null : Object.fromEntries(
		Object.entries(record(verifierResult.rewards, "verifier_result.rewards")).map(([key, reward]) => {
			text(key, "reward name");
			if (typeof reward !== "number" || !Number.isFinite(reward)) throw new Error("Rewards must be finite numbers.");
			return [key, reward];
		}),
	);
	const error = raw.exception_info == null ? null : record(raw.exception_info, "exception_info");
	if (error !== null && typeof error.exception_message !== "string") throw new Error("exception_info.exception_message must be text.");
	const exception = error === null ? null : {
		type: text(error.exception_type, "exception_info.exception_type"),
		message: error.exception_message as string,
	};
	const trialTiming = timing(raw, "trial")!;
	const agentExecution = timing(raw.agent_execution, "agent_execution");
	const verifier = timing(raw.verifier, "verifier");
	for (const phase of [agentExecution, verifier]) {
		if (phase?.startedAt && trialTiming.startedAt && Date.parse(phase.startedAt) < Date.parse(trialTiming.startedAt)
			|| phase?.finishedAt && trialTiming.finishedAt && Date.parse(phase.finishedAt) > Date.parse(trialTiming.finishedAt)) {
			throw new Error("Phase timing is outside the recorded trial.");
		}
	}
	const usage = {
		inputTokens: tokenCount(execution?.n_input_tokens, "agent_result.n_input_tokens"),
		cachedInputTokens: tokenCount(execution?.n_cache_tokens, "agent_result.n_cache_tokens"),
		outputTokens: tokenCount(execution?.n_output_tokens, "agent_result.n_output_tokens"),
		costUsd: execution?.cost_usd == null ? null : amount(execution.cost_usd, "agent_result.cost_usd"),
	};
	if (usage.cachedInputTokens !== null && usage.inputTokens !== null && usage.cachedInputTokens > usage.inputTokens) {
		throw new Error("Harbor cache tokens cannot exceed inclusive input tokens.");
	}
	const scored = finished(trialTiming) && finished(agentExecution) && finished(verifier)
		&& execution !== null && rewards !== null && Object.keys(rewards).length > 0;
	return {
		trialId: text(raw.id, "id"), trialName: text(raw.trial_name, "trial_name"),
		taskName: text(raw.task_name, "task_name"), taskChecksum: text(raw.task_checksum, "task_checksum"),
		agent: { name: text(agent.name, "agent_info.name"), version: text(agent.version, "agent_info.version"),
			model: model === null ? null : { name: text(model.name, "model_info.name"),
				provider: model.provider == null ? null : text(model.provider, "model_info.provider") } },
		timing: trialTiming, agentExecution, verifier, rewards, exception, usage,
		scoring: exception !== null ? "error" : scored ? "scored" : "incomplete",
		reason: exception !== null ? "The trial records an exception; any recorded rewards are retained."
			: scored ? "The trial records finished execution and verification with numeric rewards, including zero."
			: "The trial lacks finished execution, verification, agent results or rewards.",
	};
}

/** Read existing local evidence only; this does not launch Harbor, grade an answer or publish results. */
export async function readHarborTrialResult(root: string, reference: ArtifactReference) {
	const source = parseArtifact(reference, "Harbor result source");
	const bytes = await readArtifact(root, source);
	return { source, result: parseHarborTrialResult(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))) };
}
