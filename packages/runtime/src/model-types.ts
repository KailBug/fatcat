import type { ModelSelection } from "./model-catalog.js";
import type { ModelRequestOptions, PreparedModelRequest } from "./model-preparation.js";
import type { TokenUsage } from "./model-usage.js";

/** Text block in a user message containing multiple content parts. */
export interface TextContent {
	type: "text";
	text: string;
}

/** Image reference and optional detail level in a user message. */
export interface ImageContent {
	type: "image";
	url: string;
	detail?: "auto" | "low" | "high";
}

/** Model-requested tool invocation with an ID for matching its result. */
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

/** Model response carrying text, tool calls and optional provider replay data. */
export interface AssistantMessage {
	role: "assistant";
	content: string | null;
	toolCalls?: ToolCall[];
	providerReplay?: ProviderReplayData;
}

/** Internal message union for conversation history and model input. */
export type Message =
	| { role: "system" | "developer"; content: string }
	| { role: "user"; content: string | (TextContent | ImageContent)[] }
	| AssistantMessage
	| { role: "tool"; callId: string; content: string };

/** Result of one model invocation, which may request further tool execution. */
export interface ModelTurn {
	message: AssistantMessage;
}

/** Request reduction, input-size validation and token-usage events. */
export type ModelObservation =
	| { type: "context_reduction"; beforeBytes: number; afterBytes: number; omittedReadResults: number }
	| { type: "model_input"; bytes: number; limitBytes: number; accepted: boolean }
	| { type: "model_usage"; usage: TokenUsage | null };

/** Async model callable with cancellation, observations and optional request preparation. */
export type Model = ((messages: Message[], signal?: AbortSignal,
	observe?: (event: ModelObservation) => void,
	options?: ModelRequestOptions) => Promise<ModelTurn>) & {
	prepare?: (messages: Message[], signal?: AbortSignal, options?: ModelRequestOptions) => Promise<PreparedModelRequest>;
};
