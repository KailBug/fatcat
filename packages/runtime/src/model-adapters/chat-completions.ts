import { HarnessError } from "../errors.js";
import type { ChatCompletionMessageParam, ChatCompletionFunctionTool } from "openai/resources/chat/completions";
import type { AssistantMessage, Message, ModelTurn, ToolCall } from "../model-types.js";
import type { ToolDefinition } from "../tools/types.js";
import { sameModel } from "../model-catalog.js";
import type { ModelSelection } from "../model-catalog.js";

type ChatReplayData = {
	messageFields: Record<string, unknown>;
	toolFields?: {
		id: string;
		fields: Record<string, unknown>;
		functionFields: Record<string, unknown>;
	}[];
};

/** The SDK format is confined to this boundary; canonical history is never mutated. */
export function encodeChatMessages(messages: readonly Message[], selection: ModelSelection, replay: boolean): ChatCompletionMessageParam[] {
	return messages.map((message): ChatCompletionMessageParam => {
		if (message.role === "assistant") {
			const data = replay && message.providerReplay?.api === "chat-completions" && sameModel(message.providerReplay.selection, selection)
				? decodeChatReplayData(message.providerReplay.data, message) : undefined;
			return { ...data?.messageFields, role: "assistant", content: message.content,
				...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map((call) => {
					const extra = data?.toolFields?.find((item) => item.id === call.id);
					return { ...extra?.fields, id: call.id, type: "function" as const,
						function: { ...extra?.functionFields, name: call.name, arguments: call.arguments } };
				}) } : {}) };
		}
		if (message.role === "tool") return { role: "tool", tool_call_id: message.callId, content: message.content };
		if (message.role === "user" && Array.isArray(message.content)) {
			return { role: "user", content: message.content.map((part) => part.type === "text" ? { ...part }
				: { type: "image_url", image_url: { url: part.url, ...(part.detail ? { detail: part.detail } : {}) } }) };
		}
		return { role: message.role, content: message.content as string };
	});
}

export function encodeChatTools(tools: readonly ToolDefinition[]): ChatCompletionFunctionTool[] {
	return tools.map((tool) => ({ type: "function", function: structuredClone(tool) }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonValue(value: unknown, depth = 0): boolean {
	if (depth > 32) return false;
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every((item) => jsonValue(item, depth + 1));
	return isRecord(value) && Object.entries(value).every(([key, item]) => key !== "__proto__" && key !== "providerReplay"
		&& jsonValue(item, depth + 1));
}

function extraFields(value: unknown, reserved: string[]): value is Record<string, unknown> {
	return isRecord(value) && !reserved.some((key) => Object.hasOwn(value, key));
}

/** Validate extras and call associations without storing a second copy of conversation facts. */
export function decodeChatReplayData(value: unknown, assistant: AssistantMessage): ChatReplayData {
	if (!isRecord(value) || !jsonValue(value)
		|| !extraFields(value.messageFields, ["role", "content", "tool_calls"])) {
		throw new Error("Invalid Chat Completions replay data.");
	}
	const reasoning = value.messageFields.reasoning_content;
	if (reasoning !== undefined && reasoning !== null && typeof reasoning !== "string") {
		throw new Error("Invalid Chat Completions reasoning replay.");
	}
	const toolFields = value.toolFields;
	if (toolFields !== undefined && !Array.isArray(toolFields)) throw new Error("Invalid Chat Completions tool replay.");
	const pending = new Set(assistant.toolCalls?.map((call) => call.id));
	const tools: NonNullable<ChatReplayData["toolFields"]> = [];
	for (const item of toolFields ?? []) {
		if (!isRecord(item) || typeof item.id !== "string" || !pending.delete(item.id)
			|| !extraFields(item.fields, ["id", "type", "function"])
			|| !extraFields(item.functionFields, ["name", "arguments"])) {
			throw new Error("Invalid Chat Completions tool replay.");
		}
		tools.push({ id: item.id, fields: item.fields, functionFields: item.functionFields });
	}
	return structuredClone({ messageFields: value.messageFields, ...(tools.length ? { toolFields: tools } : {}) });
}

function invalidResponse(label: string): never {
	throw new HarnessError("MODEL_RESPONSE", `${label} returned an invalid or unsupported response.`);
}

export function parseChatResponse(response: unknown, label: string, replaySelection?: ModelSelection): ModelTurn {
	if (!isRecord(response) || !Array.isArray(response.choices) || response.choices.length !== 1) {
		return invalidResponse(label);
	}
	const choice: unknown = response.choices[0];
	if (!isRecord(choice) || !isRecord(choice.message)) return invalidResponse(label);
	if (choice.finish_reason === "length") {
		throw new HarnessError("MODEL_TRUNCATED", "The model output was truncated before completion.");
	}
	if (choice.finish_reason !== "stop" && choice.finish_reason !== "tool_calls") return invalidResponse(label);
	const raw = choice.message;
	if (raw.role !== "assistant" || (raw.content != null && typeof raw.content !== "string")) return invalidResponse(label);
	if (raw.tool_calls != null && !Array.isArray(raw.tool_calls)) return invalidResponse(label);

	const toolCalls: ToolCall[] = [];
	const toolFields: NonNullable<ChatReplayData["toolFields"]> = [];
	const ids = new Set<string>();
	for (const call of (raw.tool_calls ?? []) as unknown[]) {
		if (!isRecord(call) || call.type !== "function"
			|| typeof call.id !== "string" || !call.id.trim() || ids.has(call.id)
			|| !isRecord(call.function) || typeof call.function.name !== "string" || !call.function.name.trim()
			|| typeof call.function.arguments !== "string") return invalidResponse(label);
		ids.add(call.id);
		toolCalls.push({
			id: call.id,
			name: call.function.name, arguments: call.function.arguments,
		});
		if (replaySelection) {
			const { id: _id, type: _type, function: _function, ...fields } = call;
			const { name: _name, arguments: _arguments, ...functionFields } = call.function;
			if (Object.keys(fields).length || Object.keys(functionFields).length) {
				toolFields.push({ id: call.id, fields, functionFields });
			}
		}
	}
	if ((choice.finish_reason === "tool_calls") !== (toolCalls.length > 0)) return invalidResponse(label);
	const content = typeof raw.content === "string" ? raw.content : null;
	if (!toolCalls.length && !content?.trim()) return invalidResponse(label);
	const message: AssistantMessage = { role: "assistant", content, ...(toolCalls.length ? { toolCalls } : {}) };
	if (replaySelection) {
		const { role: _role, content: _content, tool_calls: _calls, ...messageFields } = raw;
		message.providerReplay = { api: "chat-completions", selection: structuredClone(replaySelection),
			data: decodeChatReplayData({ messageFields, ...(toolFields.length ? { toolFields } : {}) }, message) };
	}
	return { message };
}
