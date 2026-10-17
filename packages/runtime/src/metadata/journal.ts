import { isAbsolute } from "node:path";
import { HarnessError } from "../errors.js";
import { decodeSessionRecord, encodeSessionRecord, projectIdOf } from "../session/record.js";
import type { SessionRecord } from "../session/record.js";
import { decodeProjectRecord, projectIdPattern } from "../project/record.js";
import type { ProjectRecord } from "../project/record.js";
import { maxProjectMembers } from "../project/management.js";
import type { ProjectSessionMove } from "../project/management.js";
import { attachmentIdPattern, decodeAttachmentCatalog, parseAttachmentReference } from "../attachments/record.js";
import type { AttachmentCatalog, AttachmentRef } from "../attachments/record.js";

export interface MetadataCommit {
	catalog: AttachmentCatalog;
	writes?: SessionRecord[];
	deletes?: Array<{ id: string; storageWorkspace: string }>;
	purge?: AttachmentRef[];
	projectWrite?: ProjectRecord;
	projectDelete?: string;
	sessionMoves?: ProjectSessionMove[];
	memoryMove?: { sessionId: string; projectId: string };
}

/** Preserve the disk shape; validation and the durable decision belong to the coordinator. */
export function encodeMetadataCommit(change: MetadataCommit): unknown {
	return { version: change.memoryMove ? 3 : 2, catalog: change.catalog, writes: (change.writes ?? []).map(encodeSessionRecord),
		deletes: change.deletes ?? [], purge: change.purge ?? [], sessionMoves: change.sessionMoves ?? [],
		...(change.projectWrite ? { projectWrite: change.projectWrite } : {}),
		...(change.projectDelete ? { projectDelete: change.projectDelete } : {}),
		...(change.memoryMove ? { memoryMove: change.memoryMove } : {}) };
}

export function decodeMetadataCommit(raw: unknown): MetadataCommit {
	if (!isRecord(raw) || (raw.version !== 1 && raw.version !== 2 && raw.version !== 3) || !Array.isArray(raw.writes) || raw.writes.length > 2
		|| !Array.isArray(raw.deletes) || raw.deletes.length > maxProjectMembers
		|| !Array.isArray(raw.purge) || raw.purge.length > 10000) throw new HarnessError("ATTACHMENT_CORRUPT", "Invalid metadata transaction.");
	const writes = raw.writes.map((value) => {
		if (!isRecord(value) || typeof value.id !== "string" || typeof value.storageWorkspace !== "string") throw new Error("Invalid session snapshot.");
		return decodeSessionRecord(value, value.storageWorkspace, value.id);
	});
	const deletes = raw.deletes.map((value) => {
		if (!isRecord(value) || typeof value.id !== "string" || !attachmentIdPattern.test(value.id)
			|| typeof value.storageWorkspace !== "string" || !isAbsolute(value.storageWorkspace)) throw new Error("Invalid session deletion.");
		return { id: value.id, storageWorkspace: value.storageWorkspace };
	});
	const purge = raw.purge.map((value) => {
		if (!isRecord(value)) throw new Error("Invalid original deletion.");
		return parseAttachmentReference(`attachment:${String(value.attachmentId)}@${String(value.contentVersion)}`);
	});
	const moves = raw.sessionMoves ?? [];
	if (!Array.isArray(moves) || moves.length > maxProjectMembers) throw new Error("Too many project sessions.");
	const sessionMoves = moves.map(decodeSessionMove);
	let projectWrite: ProjectRecord | undefined;
	if (raw.projectWrite !== undefined) {
		if (!isRecord(raw.projectWrite) || typeof raw.projectWrite.id !== "string") throw new Error("Invalid project snapshot.");
		projectWrite = decodeProjectRecord(raw.projectWrite, raw.projectWrite.id);
	}
	if (raw.projectDelete !== undefined && (typeof raw.projectDelete !== "string" || !projectIdPattern.test(raw.projectDelete))) throw new Error("Invalid project deletion.");
	if (projectWrite && raw.projectDelete !== undefined) throw new Error("Conflicting project changes.");
	if (sessionMoves.some((move) => move.projectId !== projectWrite?.id || move.toWorkspace !== projectWrite.workspace)
		|| new Set(sessionMoves.map((move) => move.id)).size !== sessionMoves.length
		|| new Set(deletes.map((item) => item.id)).size !== deletes.length) throw new Error("Invalid project members.");
	let memoryMove: MetadataCommit["memoryMove"];
	if (raw.memoryMove !== undefined) {
		const value = raw.memoryMove;
		if (raw.version !== 3 || !isRecord(value) || typeof value.sessionId !== "string" || !attachmentIdPattern.test(value.sessionId)
			|| typeof value.projectId !== "string" || !projectIdPattern.test(value.projectId)
			|| !writes.some((record) => record.id === value.sessionId && projectIdOf(record) === value.projectId)
			|| deletes.some((record) => record.id === value.sessionId) || raw.projectDelete === value.projectId) {
			throw new HarnessError("ATTACHMENT_CORRUPT", "Invalid memory scope change.");
		}
		memoryMove = { sessionId: value.sessionId, projectId: value.projectId };
	}
	return { catalog: decodeAttachmentCatalog(raw.catalog), writes, deletes, purge, sessionMoves,
		...(projectWrite ? { projectWrite } : {}), ...(typeof raw.projectDelete === "string" ? { projectDelete: raw.projectDelete } : {}),
		...(memoryMove ? { memoryMove } : {}) };
}

function decodeSessionMove(value: unknown): ProjectSessionMove {
	if (!isRecord(value) || typeof value.id !== "string" || !attachmentIdPattern.test(value.id)
		|| typeof value.projectId !== "string" || !projectIdPattern.test(value.projectId)
		|| typeof value.changeId !== "string" || !attachmentIdPattern.test(value.changeId)
		|| typeof value.storageWorkspace !== "string" || !isAbsolute(value.storageWorkspace)
		|| typeof value.fromWorkspace !== "string" || !isAbsolute(value.fromWorkspace)
		|| typeof value.toWorkspace !== "string" || !isAbsolute(value.toWorkspace)
		|| !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 1
		|| !Number.isSafeInteger(value.locationRevision) || Number(value.locationRevision) < 0
		|| typeof value.changedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value.changedAt) || !Number.isFinite(Date.parse(value.changedAt))) {
		throw new HarnessError("ATTACHMENT_CORRUPT", "Invalid project session change.");
	}
	return { id: value.id, projectId: value.projectId, changeId: value.changeId, storageWorkspace: value.storageWorkspace,
		fromWorkspace: value.fromWorkspace, toWorkspace: value.toWorkspace, changedAt: value.changedAt,
		expectedRevision: Number(value.expectedRevision), locationRevision: Number(value.locationRevision) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
