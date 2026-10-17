import { HarnessError, checkCancellation } from "../errors.js";
import { memoryFingerprint } from "../memory/record.js";
import type { MemoryRecord, MemoryScope, MemorySource } from "../memory/record.js";
import type { MemoryStore } from "../memory/store.js";
import type { MemoryWriteRequest } from "../memory/write.js";
import type { ProjectJoinPreview } from "../project/operations.js";
import type { SessionExecutionIdentity } from "./execution.js";

export type MemoryChange = { action: "add"; scope: "session" | "project" | "global"; content: string }
	| { action: "update" | "delete"; id: string; revision: number; content?: string };

export function memoryScopes(identity: SessionExecutionIdentity): MemoryScope[] {
	return [identity.projectId ? { kind: "project", id: identity.projectId } : { kind: "session", id: identity.sessionId },
		{ kind: "global" }];
}

/** The caller keeps the session identity/owner gate held across this entire operation. */
export async function changeSessionMemory(store: MemoryStore, identity: SessionExecutionIdentity,
	change: MemoryChange, source: MemorySource, signal?: AbortSignal): Promise<MemoryRecord> {
	checkCancellation(signal);
	if (source.sessionId !== identity.sessionId) throw new HarnessError("MEMORY_SOURCE", "Memory source must belong to the executing session.");
	const records = await store.list(memoryScopes(identity), signal);
	if (change.action === "add") {
		if (identity.projectId && change.scope === "session") {
			throw new HarnessError("INVALID_ARGUMENTS", "Project session Memory belongs to the project. Choose project or global explicitly.");
		}
		const scope = memoryScopes(identity).find((scope) => scope.kind === change.scope);
		if (!scope) throw new HarnessError("INVALID_ARGUMENTS", "Project Memory requires a project session.");
		const existing = records.find((record) => record.scope.kind === scope.kind && record.status === "active" && record.content === change.content);
		return existing ?? store.create(scope, change.content, source, signal);
	}
	const existing = records.find((record) => record.id === change.id);
	if (!existing) throw new HarnessError("MEMORY_NOT_FOUND", "No Memory entry is available in this session's scope.");
	if (change.action === "update" && change.content === undefined) throw new HarnessError("INVALID_ARGUMENTS", "Updated Memory content is required.");
	return store.update(existing.scope, existing.id, change.revision,
		change.action === "delete" ? null : change.content!, source, signal);
}

/** Count active entries, but bind the preview to all private records, including tombstones. */
export function memoryJoinState(entries: MemoryRecord[]): Pick<ProjectJoinPreview, "memoryCount" | "memoryFingerprint"> {
	return { memoryCount: entries.filter((entry) => entry.status === "active").length,
		memoryFingerprint: memoryFingerprint(entries) };
}

/** Resolve an already validated user-turn request against its captured execution identity. */
export function memoryChangeForRequest(identity: SessionExecutionIdentity, request: MemoryWriteRequest): MemoryChange {
	return request.action === "add"
		? { action: "add", scope: request.scope ?? (identity.projectId ? "project" : "session"), content: request.content }
		: { action: request.action, id: request.id, revision: request.revision,
			...(request.action === "update" ? { content: request.content } : {}) };
}
