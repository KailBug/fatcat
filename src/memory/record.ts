import { createHash } from "node:crypto";
import { HarnessError } from "../errors.js";

export const memoryIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const maxMemoryRecords = 64;
export const maxMemoryContentBytes = 1024;
export const maxMemoryRequestBytes = 2048;
export const maxMemoryRevisions = 32;

export type MemoryScope = { kind: "session" | "project"; id: string } | { kind: "global" };

export interface MemorySource {
	sessionId: string;
	request: string;
	turn: number;
	evidence?: string;
	requestExcerpt?: true;
}

export interface MemoryChange {
	revision: number;
	content: string;
	status: "active" | "deleted";
	source: MemorySource;
	updatedAt: string;
}

export interface MemoryRecord extends MemoryChange {
	id: string;
	scope: MemoryScope;
	changes: MemoryChange[];
}

export function memoryFingerprint(records: readonly MemoryRecord[]): string {
	const entries = records.map((record) => [record.id, record.revision, record.status] as const)
		.sort((left, right) => left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0);
	return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

export function validateMemoryScope(value: unknown): MemoryScope {
	if (!isRecord(value)) return invalidArguments();
	if (value.kind === "global" && Object.keys(value).length === 1) return { kind: "global" };
	if ((value.kind === "session" || value.kind === "project") && typeof value.id === "string"
		&& memoryIdPattern.test(value.id) && Object.keys(value).length === 2) return { kind: value.kind, id: value.id };
	return invalidArguments();
}

export function memoryScopeKey(scope: MemoryScope): string {
	const validated = validateMemoryScope(scope);
	return validated.kind === "global" ? "global" : `${validated.kind}-${validated.id}`;
}

export function validateMemoryContent(value: unknown): string {
	if (typeof value !== "string" || !value.trim()) return invalidArguments();
	if (Buffer.byteLength(value, "utf8") > maxMemoryContentBytes) {
		throw new HarnessError("MEMORY_LIMIT", `Memory content must be at most ${maxMemoryContentBytes} UTF-8 bytes.`);
	}
	return value;
}

export function validateMemorySource(value: unknown): MemorySource {
	if (!isRecord(value) || typeof value.sessionId !== "string" || !memoryIdPattern.test(value.sessionId)
		|| typeof value.request !== "string" || !value.request.trim()
		|| !Number.isSafeInteger(value.turn) || Number(value.turn) < 0) return invalidArguments();
	if (Buffer.byteLength(value.request, "utf8") > maxMemoryRequestBytes) {
		throw new HarnessError("MEMORY_LIMIT", `A memory source request must be at most ${maxMemoryRequestBytes} UTF-8 bytes.`);
	}
	if (value.evidence !== undefined && (typeof value.evidence !== "string" || !value.evidence.trim()
		|| !value.request.includes(value.evidence) || Buffer.byteLength(value.evidence) > maxMemoryRequestBytes)) return invalidArguments();
	if (value.requestExcerpt !== undefined && (value.requestExcerpt !== true || value.evidence !== value.request)) return invalidArguments();
	return { sessionId: value.sessionId, request: value.request, turn: Number(value.turn),
		...(typeof value.evidence === "string" ? { evidence: value.evidence } : {}),
		...(value.requestExcerpt === true ? { requestExcerpt: true } : {}) };
}

export function decodeMemoryRecords(value: unknown, scope: MemoryScope): MemoryRecord[] {
	try {
		if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.records)
			|| value.records.length > maxMemoryRecords || memoryScopeKey(validateMemoryScope(value.scope)) !== memoryScopeKey(scope)) return invalidMemory();
		const records = value.records.map((record: unknown) => decodeMemoryRecord(record, scope));
		if (new Set(records.map((record) => record.id)).size !== records.length) return invalidMemory();
		return records;
	} catch (error) {
		if (error instanceof HarnessError && error.code === "MEMORY_IO") throw error;
		return invalidMemory();
	}
}

function decodeMemoryRecord(value: unknown, scope: MemoryScope): MemoryRecord {
	if (!isRecord(value) || typeof value.id !== "string" || !memoryIdPattern.test(value.id)
		|| memoryScopeKey(validateMemoryScope(value.scope)) !== memoryScopeKey(scope)
		|| !Array.isArray(value.changes) || value.changes.length < 1 || value.changes.length > maxMemoryRevisions
		|| value.revision !== value.changes.length || (value.revision === maxMemoryRevisions && value.status !== "deleted")) return invalidMemory();
	const changes = value.changes.map((change: unknown, index: number) => decodeMemoryChange(change, index + 1));
	for (let index = 0; index < changes.length; index++) {
		const previous = changes[index - 1];
		const current = changes[index]!;
		if ((!previous && current.status !== "active") || (previous && (previous.status === "deleted" || current.updatedAt < previous.updatedAt))) return invalidMemory();
	}
	const latest = decodeMemoryChange(value, changes.length);
	const lastChange = changes.at(-1)!;
	if (latest.content !== lastChange.content || latest.status !== lastChange.status || latest.updatedAt !== lastChange.updatedAt
		|| latest.source.sessionId !== lastChange.source.sessionId || latest.source.request !== lastChange.source.request
		|| latest.source.turn !== lastChange.source.turn || latest.source.evidence !== lastChange.source.evidence
		|| latest.source.requestExcerpt !== lastChange.source.requestExcerpt) return invalidMemory();
	return { id: value.id, scope: validateMemoryScope(scope), ...latest, changes };
}

function decodeMemoryChange(value: unknown, revision: number): MemoryChange {
	if (!isRecord(value) || value.revision !== revision || (value.status !== "active" && value.status !== "deleted")
		|| typeof value.updatedAt !== "string" || !isDate(value.updatedAt)) return invalidMemory();
	const content = value.status === "deleted" ? value.content === "" ? "" : invalidMemory() : validateMemoryContent(value.content);
	return { revision, content, status: value.status, source: validateMemorySource(value.source), updatedAt: value.updatedAt };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDate(value: string): boolean {
	const milliseconds = Date.parse(value);
	return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function invalidArguments(): never {
	throw new HarnessError("INVALID_ARGUMENTS", "Memory requires a valid scope, non-empty content, and a source session, request, and non-negative turn.");
}

export function invalidMemory(): never {
	throw new HarnessError("MEMORY_IO", "Saved memory is invalid or unsupported. Repair its scope file before continuing.");
}
