import type { ModelSelection } from "./model-catalog.js";
import type { ModelRequestOptions, PreparedModelRequest } from "./model-preparation.js";
import type { TokenUsage } from "./model-usage.js";

export interface TextContent {
	type: "text";
	text: string;
}

export interface ImageContent {
	type: "image";
	url: string;
	detail?: "auto" | "low" | "high";
}

export interface ToolCall {
	id: string;
	name: string;
	/** Keep the original JSON so invalid arguments remain recoverable tool errors. */
	arguments: string;
}

/** Provider data, such as reasoning_content, preserved for replay by its API adapter. */
export interface ProviderReplayData {
	api: "chat-completions";
	selection: ModelSelection;
	/** API-owned extras only; canonical text and tool arguments live on AssistantMessage. */
	data: Record<string, unknown>;
}

export interface AssistantMessage {
	role: "assistant";
	content: string | null;
	toolCalls?: ToolCall[];
	providerReplay?: ProviderReplayData;
}

export type Message =
	| { role: "system" | "developer"; content: string }
	| { role: "user"; content: string | (TextContent | ImageContent)[] }
	| AssistantMessage
	| { role: "tool"; callId: string; content: string };

export interface ModelTurn {
	message: AssistantMessage;
}

export type ModelObservation =
	| { type: "context_reduction"; beforeBytes: number; afterBytes: number; omittedReadResults: number }
	| { type: "model_input"; bytes: number; limitBytes: number; accepted: boolean }
	| { type: "model_usage"; usage: TokenUsage | null };

export type Model = ((messages: Message[], signal?: AbortSignal,
	observe?: (event: ModelObservation) => void,
	options?: ModelRequestOptions) => Promise<ModelTurn>) & {
	prepare?: (messages: Message[], signal?: AbortSignal, options?: ModelRequestOptions) => Promise<PreparedModelRequest>;
};
