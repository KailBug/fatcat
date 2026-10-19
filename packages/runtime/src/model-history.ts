import type { ChatCompletionAssistantMessageParam, ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { decodeModelSelection } from "./model-catalog.js";
import type { ModelSelection } from "./model-catalog.js";
import type { Message } from "./model.js";

/** Provider response data is inert history, never execution policy or a new tool invocation. */
export interface ModelContext {
	selection: ModelSelection;
	message: ChatCompletionAssistantMessageParam & Record<string, unknown>;
}

export function sameModel(left: ModelSelection, right: ModelSelection): boolean {
	return left.provider === right.provider && left.region === right.region && left.workspaceId === right.workspaceId
		&& left.model === right.model;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonValue(value: unknown, depth = 0): boolean {
	if (depth > 32) return false;
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every((item) => jsonValue(item, depth + 1));
	return record(value) && Object.entries(value).every(([key, item]) => key !== "__proto__" && key !== "modelContext"
		&& jsonValue(item, depth + 1));
}

/** Check opaque data against the canonical text and tool facts before preserving it. */
export function decodeModelContext(value: unknown, assistant: ChatCompletionAssistantMessageParam): ModelContext {
	if (!record(value) || !record(value.message) || !jsonValue(value.message)) throw new Error("Invalid model context.");
	const raw = value.message;
	if (raw.role !== "assistant" || (raw.content ?? null) !== assistant.content
		|| (raw.reasoning_content !== undefined && raw.reasoning_content !== null && typeof raw.reasoning_content !== "string")) {
		throw new Error("Invalid assistant context.");
	}
	const calls = raw.tool_calls ?? [];
	if (!Array.isArray(calls) || calls.length !== (assistant.tool_calls?.length ?? 0)) throw new Error("Invalid tool context.");
	for (let i = 0; i < calls.length; i++) {
		const call: unknown = calls[i];
		const expected = assistant.tool_calls![i]!;
		if (!record(call) || expected.type !== "function" || call.id !== expected.id || call.type !== "function"
			|| !record(call.function) || call.function.name !== expected.function.name
			|| call.function.arguments !== expected.function.arguments) throw new Error("Invalid tool context.");
	}
	// The role, content and tool calls above establish the SDK assistant shape; extras stay opaque.
	return { selection: decodeModelSelection(value.selection),
		message: structuredClone(raw) as ModelContext["message"] };
}

/** Strip internal provenance on every request, including disabled thinking and auxiliary calls. */
export function projectModelHistory(messages: Message[], selection: ModelSelection, replay: boolean): ChatCompletionMessageParam[] {
	return messages.map((message) => {
		if (message.role !== "assistant") return message;
		const { modelContext, ...canonical } = message;
		if (replay && modelContext && sameModel(modelContext.selection, selection)) {
			return structuredClone(decodeModelContext(modelContext, canonical).message);
		}
		return canonical;
	});
}

/** Summaries contain conversation facts, not provider reasoning state. */
export function conversationMessage(message: Message): ChatCompletionMessageParam {
	if (message.role !== "assistant") return message;
	const { modelContext: _context, ...canonical } = message;
	return canonical;
}
