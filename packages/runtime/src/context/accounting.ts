import type { TokenUsage } from "../model-usage.js";
import { parseTokenUsage } from "../model-usage.js";
import { decodeModelSelection } from "../model-catalog.js";
import type { ContextObservation } from "./usage.js";
import { invalidSession, isRecord } from "../session/history.js";

/** Sums of reported requests, never a measure of the retained context. */
export interface SessionConsumption {
	requests: number;
	reportedRequests: number;
	completeHistory: boolean;
	tokens: TokenUsage | null;
	cache: { requests: number; inputTokens: number; hitTokens: number } | null;
}

export function emptyConsumption(completeHistory: boolean): SessionConsumption {
	return { requests: 0, reportedRequests: 0, completeHistory, tokens: null,
		cache: { requests: 0, inputTokens: 0, hitTokens: 0 } };
}

/** Weighted ratio over requests with valid cache counters; never subtract hits from context. */
export function cacheHitRate(consumption: SessionConsumption): number | null {
	const cache = consumption.cache;
	return cache && cache.requests > 0 && cache.inputTokens > 0 ? cache.hitTokens / cache.inputTokens : null;
}

export function addUsage(current: SessionConsumption, usage: TokenUsage): SessionConsumption {
	const previous = current.tokens;
	const tokens: TokenUsage = {
		promptTokens: (previous?.promptTokens ?? 0) + usage.promptTokens,
		completionTokens: (previous?.completionTokens ?? 0) + usage.completionTokens,
		totalTokens: (previous?.totalTokens ?? 0) + usage.totalTokens,
	};
	const overflow = (current.reportedRequests > 0 && previous === null) || !Object.values(tokens).every(Number.isSafeInteger);
	let cache = current.cache ? { ...current.cache } : null;
	if (cache && usage.cachedPromptTokens !== undefined) {
		cache.requests++;
		cache.inputTokens += usage.promptTokens;
		cache.hitTokens += usage.cachedPromptTokens;
		if (!Object.values(cache).every(Number.isSafeInteger)) cache = null;
	}
	return { ...current, reportedRequests: current.reportedRequests + 1, tokens: overflow ? null : tokens, cache };
}

export function decodeConsumption(value: unknown): SessionConsumption {
	if (!isRecord(value) || !count(value.requests) || !count(value.reportedRequests)
		|| value.reportedRequests > value.requests || typeof value.completeHistory !== "boolean") return invalidSession();
	const raw = value.tokens;
	const tokens = isRecord(raw) ? parseTokenUsage({ prompt_tokens: raw.promptTokens,
		completion_tokens: raw.completionTokens, total_tokens: raw.totalTokens }) : null;
	if (raw !== null && (!tokens || value.reportedRequests === 0)) return invalidSession();
	let cache: SessionConsumption["cache"] = null;
	if (value.cache !== null) {
		const item = value.cache;
		if (!isRecord(item) || !count(item.requests) || item.requests > value.reportedRequests
			|| !count(item.inputTokens) || !count(item.hitTokens) || item.hitTokens > item.inputTokens
			|| (tokens && item.inputTokens > tokens.promptTokens)
			|| (item.requests === 0 && (item.inputTokens !== 0 || item.hitTokens !== 0))) return invalidSession();
		cache = { requests: item.requests, inputTokens: item.inputTokens, hitTokens: item.hitTokens };
	}
	return { requests: value.requests, reportedRequests: value.reportedRequests, completeHistory: value.completeHistory,
		tokens, cache };
}

export function decodeObservation(value: unknown): ContextObservation {
	if (!isRecord(value) || value.kind !== "reported" || typeof value.requestId !== "string"
		|| !/^[0-9a-f-]{36}$/.test(value.requestId)
		|| (value.inputTokens === null ? typeof value.reason !== "string" || !value.reason.trim() || value.reason.length > 300 : !count(value.inputTokens))
		|| typeof value.observedAt !== "string" || !Number.isFinite(Date.parse(value.observedAt))) return invalidSession();
	try { return { kind: "reported", requestId: value.requestId,
		...(value.inputTokens === null ? { inputTokens: null, reason: String(value.reason) } : { inputTokens: value.inputTokens as number }),
		observedAt: value.observedAt, selection: decodeModelSelection(value.selection) }; }
	catch { return invalidSession(); }
}

function count(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
