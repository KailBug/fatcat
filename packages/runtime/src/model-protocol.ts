import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import { getModelDescriptor, validateModelSelection } from "./model-catalog.js";
import type { ModelSelection, ThinkingLevel } from "./model-catalog.js";
import { HarnessError } from "./errors.js";

export type ModelPurpose = "chat" | "compaction" | "document";
export interface GenerationParameters {
	thinking?: { type: "enabled" | "disabled"; keep?: "all" };
	reasoning_effort?: NonNullable<ChatCompletionCreateParamsNonStreaming["reasoning_effort"]>;
	enable_thinking?: boolean;
	preserve_thinking?: boolean;
	thinking_budget?: number;
	max_tokens?: number;
	max_completion_tokens?: number;
}

export interface ModelProtocol {
	generation: GenerationParameters;
	/** Total future generation reservation; reasoning is included exactly once. */
	outputReservationTokens: number | null;
	inputLimitTokens: number | null;
	reasoningHistory: "none" | "with-tools" | "all";
}

/** Pure provider mapping, shared by actual request preparation and context previews. */
export function resolveModelProtocol(value: ModelSelection, purpose: ModelPurpose = "chat"): ModelProtocol {
	const selection = validateModelSelection(value);
	const descriptor = getModelDescriptor(selection.provider, selection.model);
	const chosen = purpose === "chat" || !descriptor.thinkingOptions.includes("off") ? selection.thinking : "off";
	const thinking = descriptor.thinkingAliases?.[chosen] ?? chosen;
	const enabled = thinking !== "off";
	const totalOutput = enabled ? 16_384 : 2_048;
	const inputLimitTokens = descriptor.inputLimitTokens?.[enabled ? "thinking" : "off"] ?? null;
	if (descriptor.protocol === "qwen-effort" || descriptor.protocol === "qwen-toggle") {
		return { generation: { enable_thinking: enabled, preserve_thinking: enabled, max_completion_tokens: totalOutput,
			...(enabled && descriptor.protocol === "qwen-effort" ? { reasoning_effort: wireEffort(thinking) } : {}) },
			outputReservationTokens: totalOutput, inputLimitTokens, reasoningHistory: enabled ? "all" : "none" };
	}
	if (descriptor.protocol === "qwen-legacy") {
		// qwen-plus max_tokens excludes reasoning; the separate budget is not an effort level.
		return { generation: { enable_thinking: enabled, max_tokens: 2_048,
			...(enabled ? { thinking_budget: 8_192 } : {}) },
			outputReservationTokens: descriptor.known ? 2_048 + (enabled ? 8_192 : 0) : null,
			inputLimitTokens, reasoningHistory: "none" };
	}
	if (descriptor.protocol === "deepseek") {
		return { generation: { thinking: { type: enabled ? "enabled" : "disabled" }, max_tokens: totalOutput,
			...(enabled ? { reasoning_effort: wireEffort(thinking) } : {}) },
			outputReservationTokens: descriptor.known ? totalOutput : null, inputLimitTokens,
			reasoningHistory: enabled ? "with-tools" : "none" };
	}
	if (descriptor.protocol === "kimi-k3") {
		return { generation: { reasoning_effort: wireEffort(thinking), max_completion_tokens: totalOutput },
			outputReservationTokens: totalOutput, inputLimitTokens, reasoningHistory: "all" };
	}
	return { generation: { thinking: { type: enabled ? "enabled" : "disabled",
		...(enabled && selection.provider === "kimi" ? { keep: "all" as const } : {}) }, max_completion_tokens: totalOutput },
		outputReservationTokens: descriptor.known ? totalOutput : null, inputLimitTokens,
		reasoningHistory: enabled ? "all" : "none" };
}

/** Normalize aliases before reaching the SDK; never widen its wire type to accept UI labels. */
function wireEffort(thinking: ThinkingLevel): NonNullable<GenerationParameters["reasoning_effort"]> {
	if (thinking === "low" || thinking === "medium" || thinking === "high" || thinking === "xhigh" || thinking === "max") return thinking;
	throw new HarnessError("MODEL_SELECTION", "This thinking option has no supported wire effort.");
}
