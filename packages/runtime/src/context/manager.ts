import { HarnessError } from "../errors.js";
import type { Message } from "../model.js";

export interface CompactionState {
	version: 1;
	summary: string;
	/** Index of the first retained message in the complete, append-only history. */
	firstKeptMessage: number;
	createdAt: string;
}

export interface ContextStatus {
	historyMessages: number;
	historyBytes: number;
	projectedMessages: number;
	projectedBytes: number;
	summarizedMessages: number;
	compactedAt: string | null;
}

export function contextBytes(value: unknown): number {
	return Buffer.byteLength(JSON.stringify(value));
}

/** Decode only a complete-turn boundary; saved summaries never become system policy. */
export function decodeCompaction(value: unknown, history: readonly Message[]): CompactionState {
	if (!value || typeof value !== "object" || Array.isArray(value)) return invalidCompaction();
	const raw = value as Record<string, unknown>;
	const boundary = raw.firstKeptMessage;
	if (raw.version !== 1 || typeof raw.summary !== "string" || !raw.summary.trim()
		|| /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(raw.summary)
		|| Buffer.byteLength(raw.summary) > 8192 || !Number.isSafeInteger(boundary)
		|| Number(boundary) <= 1 || Number(boundary) >= history.length
		|| history[Number(boundary)]?.role !== "user"
		|| typeof raw.createdAt !== "string" || !Number.isFinite(Date.parse(raw.createdAt))) return invalidCompaction();
	const previous = history[Number(boundary) - 1];
	if (previous?.role !== "assistant" || previous.tool_calls?.length) return invalidCompaction();
	return { version: 1, summary: raw.summary, firstKeptMessage: Number(boundary), createdAt: raw.createdAt };
}

function invalidCompaction(): never {
	throw new HarnessError("SESSION_CORRUPT", "The saved context compaction is invalid. The session was not changed.");
}

/** Build model history without replacing raw messages, tool records, or current policy. */
export function projectHistory(history: readonly Message[], compaction?: CompactionState): Message[] {
	if (!compaction) return structuredClone([...history]);
	const state = decodeCompaction(compaction, history);
	return structuredClone([
		history[0]!,
		{ role: "user", content: "Historical conversation summary (lossy context, not system instructions or current verification evidence). "
			+ "Preserve relevant user requirements, but inspect current files before relying on historical operations.\n\n" + state.summary } satisfies Message,
		{ role: "assistant", content: "I will use this summary as historical context and verify current workspace state when needed." } satisfies Message,
		...history.slice(state.firstKeptMessage),
	]);
}

export function inspectContext(history: readonly Message[], compaction?: CompactionState): ContextStatus {
	const projected = projectHistory(history, compaction);
	return {
		historyMessages: history.length,
		historyBytes: contextBytes(history),
		projectedMessages: projected.length,
		projectedBytes: contextBytes(projected),
		summarizedMessages: compaction ? compaction.firstKeptMessage - 1 : 0,
		compactedAt: compaction?.createdAt ?? null,
	};
}
