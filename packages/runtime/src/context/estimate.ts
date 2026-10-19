import type { PreparedModelRequest } from "../model-preparation.js";
import type { ModelSelection } from "../model-catalog.js";
import { getModelDescriptor } from "../model-catalog.js";
import { checkCancellation } from "../errors.js";
import type { ContextEstimate } from "./usage.js";

/** Host-injected local tokenizer; supports must match the exact model and request format.
 * Implementations must not perform network requests, generation, tools, or state writes. */
export interface InputTokenCounter {
	supports: (selection: ModelSelection) => boolean;
	count: (request: PreparedModelRequest, signal?: AbortSignal) => Promise<{
		inputTokens: number; method: string; approximate: boolean; limitations: string[];
	}>;
}

export function pendingEstimate(selection: ModelSelection, contextRevision: number, reason: string): ContextEstimate {
	return { kind: "estimated", selection: structuredClone(selection), contextRevision, status: "pending",
		inputTokens: null, measuredAt: null, method: null, reason };
}

/** Does not call a provider count endpoint by default. Bytes remain a separate transport limit. */
export async function estimateRequest(request: PreparedModelRequest, contextRevision: number,
	counter?: InputTokenCounter, signal?: AbortSignal): Promise<ContextEstimate> {
	checkCancellation(signal);
	const identity = { kind: "estimated" as const, selection: structuredClone(request.selection), contextRevision };
	const limitations = ["Unsent drafts are excluded. Dynamic guidance is sampled at preview time; future tool results and automatic compaction are not predicted."];
	if (request.bytes > request.limitBytes) limitations.push("This projection exceeds the local request byte limit. Preview did not compact or send it.");
	try {
		const counted = counter?.supports(request.selection) ? await counter.count(structuredClone(request), signal) : approximateDeepSeek(request);
		checkCancellation(signal);
		if (counted && Number.isSafeInteger(counted.inputTokens) && counted.inputTokens >= 0 && counted.method.trim()) {
			return { ...identity, status: "ready", ...counted, measuredAt: new Date().toISOString(), limitations: [...counted.limitations, ...limitations] };
		}
	} catch {
		checkCancellation(signal);
		return { ...identity, status: "unknown", inputTokens: null, measuredAt: new Date().toISOString(), method: null,
			reason: "The matching local token counter failed or returned an invalid result." };
	}
	return { ...identity, status: "unknown", inputTokens: null, measuredAt: new Date().toISOString(), method: null,
		reason: "No reliable local counter or applicable approximation is available for this model and content." };
}

function approximateDeepSeek(request: PreparedModelRequest) {
	if (request.selection.provider !== "deepseek" || getModelDescriptor("deepseek", request.selection.model).contextWindowTokens === null) return undefined;
	// Official rough text guidance, not a tokenizer or a chat-template measurement:
	// https://api-docs.deepseek.com/quick_start/token_usage/
	if (request.body.messages.some((message) => Array.isArray(message.content))) return undefined;
	const text = JSON.stringify({ messages: request.body.messages, tools: request.body.tools });
	let tenths = 0;
	let unicodeFallback = false;
	for (const character of text) {
		if (/^[\x00-\x7f]$/.test(character)) tenths += 3;
		else if (/^\p{Script=Han}$/u.test(character)) tenths += 6;
		else {
			// A conservative fallback for punctuation, emoji and other Unicode text.
			// This is a local heuristic, not DeepSeek's published character ratio or an exact tokenizer.
			tenths += Buffer.byteLength(character, "utf8") * 10;
			unicodeFallback = true;
		}
	}
	return { inputTokens: Math.ceil(tenths / 10), approximate: true,
		method: "deepseek-text-heuristic: serialized messages/tools, ASCII × 0.3 + Han × 0.6; other Unicode uses a conservative UTF-8 byte fallback",
		limitations: ["Rough character-based proxy using DeepSeek's English/Chinese guidance. JSON characters are not tokens; provider chat framing, code and reasoning serialization can differ substantially.",
			...(unicodeFallback ? ["Other Unicode text is conservatively estimated at one token per UTF-8 byte. This fallback is not an exact tokenizer and can overestimate punctuation, emoji and other languages."] : [])] };
}
