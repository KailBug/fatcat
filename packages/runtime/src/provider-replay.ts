import type { AssistantMessage, ProviderReplayData, Message } from "./model-types.js";
import { decodeModelSelection } from "./model-catalog.js";
import { decodeChatReplayData } from "./model-adapters/chat-completions.js";

/** Validate replay ownership; the owning API adapter validates the provider payload. */
export function decodeProviderReplayData(value: unknown, assistant: AssistantMessage): ProviderReplayData {
	if (typeof value !== "object" || value === null || Array.isArray(value)
		|| !("api" in value) || value.api !== "chat-completions"
		|| !("selection" in value) || !("data" in value)) {
		throw new Error("Invalid provider replay data.");
	}
	return { api: value.api, selection: decodeModelSelection(value.selection),
		data: decodeChatReplayData(value.data, assistant) };
}

/** Summaries contain conversation facts, not provider reasoning state. */
export function conversationMessage(message: Message): Message {
	if (message.role !== "assistant") return message;
	const { providerReplay: _replay, ...canonical } = message;
	return canonical;
}
