import type { PreparedModelRequest } from "@fatcat/runtime/internal/model-preparation";
import type { Message } from "@fatcat/runtime/model-types";

/** Wire fixtures intentionally do not use the runtime's canonical conversation types. */
export interface ChatMessage {
	role: "system" | "developer" | "user" | "assistant" | "tool";
	content: string | null | ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[];
	tool_call_id?: string;
	tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
}

export interface ChatRequest {
	messages: ChatMessage[];
	tools?: { type: "function"; function: { name: string; description?: string; parameters?: Record<string, unknown> } }[];
	[key: string]: unknown;
}

export function preparedChatRequest(request: PreparedModelRequest): ChatRequest {
	return JSON.parse(request.json) as ChatRequest;
}

/** Encode injected model decisions when the fixture exercises the real SDK transport. */
export function chatMessage(message: Message): ChatMessage {
	if (message.role === "assistant") return { role: "assistant", content: message.content,
		...(message.toolCalls ? { tool_calls: message.toolCalls.map((call) => ({
			id: call.id, type: "function" as const, function: { name: call.name, arguments: call.arguments },
		})) } : {}) };
	if (message.role === "tool") return { role: "tool", tool_call_id: message.callId, content: message.content };
	if (typeof message.content !== "string") throw new Error("This fixture only encodes text messages.");
	return { role: message.role, content: message.content };
}
