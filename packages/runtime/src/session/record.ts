import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { HarnessError } from "../errors.js";
import type { Message } from "../model.js";
import { decodeBoundTasks } from "../automation/tasks.js";
import type { BoundTask } from "../automation/tasks.js";
import { decodeCompaction } from "../context/manager.js";
import type { CompactionState } from "../context/manager.js";
import { invalidSession, isRecord, validateHistory } from "./history.js";
import { decodeModelSelection } from "../model-catalog.js";
import type { ModelSelection } from "../model-catalog.js";
import { decodeConsumption, decodeObservation } from "../context/accounting.js";
import type { SessionConsumption } from "../context/accounting.js";
import type { ContextObservation } from "../context/usage.js";

export const sessionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export interface SessionAttempt {
	prompt: string;
	startedAt: string;
	updatedAt: string;
	ownerPid: number;
	status: "running" | "failed" | "cancelled";
	code: string | null;
	messages: Message[];
}

export interface SessionRecord {
	consumption?: SessionConsumption;
	lastReportedInput?: ContextObservation;
	version: 1 | 2 | 3;
	modelSelection?: ModelSelection;
	id: string;
	/** Resolved execution directory. Project sessions never persist this projection. */
	workspace: string;
	location?: SessionLocation;
	locationRevision?: number;
	locationChanges?: SessionLocationChange[];
	activeOperation?: SessionActiveOperation;
	/** Project projections are refreshed from ProjectStore and never persisted. */
	projectName?: string;
	projectRevision?: number;
	projectError?: string;
	name: string | null;
	title: string;
	/** Original storage bucket, retained when the execution workspace changes. */
	storageWorkspace?: string;
	createdAt: string;
	updatedAt: string;
	revision: number;
	forkedFrom: string | null;
	history: Message[];
	attempt: SessionAttempt | null;
	automations?: BoundTask[];
	compaction?: CompactionState;
}

export type SessionLocation = { kind: "standalone"; workspace: string } | { kind: "project"; projectId: string };

export interface SessionLocationChange {
	id: string;
	from: SessionLocation;
	to: SessionLocation;
	fromWorkspace: string;
	toWorkspace: string;
	changedAt: string;
	acknowledged: boolean;
}

export interface SessionActiveOperation {
	kind: "compact";
	id: string;
	ownerPid: number;
	startedAt: string;
}

export function locationOf(record: SessionRecord): SessionLocation {
	return record.location ?? { kind: "standalone", workspace: record.workspace };
}

export function projectIdOf(record: SessionRecord): string | undefined {
	const location = locationOf(record);
	return location.kind === "project" ? location.projectId : undefined;
}

export interface SessionSummary {
	modelSelection?: ModelSelection;
	id: string;
	workspace: string;
	name: string | null;
	title: string;
	createdAt: string;
	updatedAt: string;
	revision: number;
	turnCount: number;
	forkedFrom: string | null;
	interrupted: boolean;
	automationCount?: number;
	projectId?: string;
	projectName?: string;
	projectError?: string;
	locationRevision?: number;
}

export function sessionSummary(record: SessionRecord): SessionSummary {
	return { id: record.id, workspace: record.workspace, name: record.name, title: record.title,
		...(record.modelSelection ? { modelSelection: structuredClone(record.modelSelection) } : {}),
		createdAt: record.createdAt, updatedAt: record.updatedAt, revision: record.revision,
		turnCount: record.history.filter((message) => message.role === "user").length,
		forkedFrom: record.forkedFrom, interrupted: record.attempt !== null || record.activeOperation !== undefined,
		...(projectIdOf(record) ? { projectId: projectIdOf(record)! } : {}),
		...(record.projectName === undefined ? {} : { projectName: record.projectName }),
		...(record.projectError === undefined ? {} : { projectError: record.projectError }),
		...(record.locationRevision === undefined ? {} : { locationRevision: record.locationRevision }),
		...(record.automations?.length ? { automationCount: record.automations.length } : {}) };
}

export function sessionName(value: string): string {
	const name = value.trim();
	if (!name || name.length > 120 || /[\x00-\x1f\x7f]/.test(name)) {
		throw new HarnessError("SESSION_NAME", "Use a non-empty session name of at most 120 characters without control characters.");
	}
	return name;
}

export function workspaceKey(workspace: string): string {
	return createHash("sha256").update(process.platform === "win32" ? workspace.toLowerCase() : workspace).digest("hex");
}
function isDate(value: unknown): value is string {
	return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}
export function decodeSessionRecord(value: unknown, workspace: string, id: string): SessionRecord {
	if (!isRecord(value) || (value.version !== 1 && value.version !== 2 && value.version !== 3) || value.id !== id || !sessionIdPattern.test(id)
		|| (value.storageWorkspace !== undefined && (typeof value.storageWorkspace !== "string" || !isAbsolute(value.storageWorkspace)))
		|| workspaceKey(String(value.storageWorkspace ?? value.workspace)) !== workspaceKey(workspace)
		|| (value.name !== null && typeof value.name !== "string")
		|| typeof value.title !== "string" || value.title.length > 120 || /[\x00-\x1f\x7f]/.test(value.title)
		|| !isDate(value.createdAt) || !isDate(value.updatedAt) || !Number.isSafeInteger(value.revision)
		|| Number(value.revision) < 1 || (value.forkedFrom !== null && (typeof value.forkedFrom !== "string" || !sessionIdPattern.test(value.forkedFrom)))) return invalidSession();
	let location: SessionLocation;
	if (value.version !== 3 && (value.consumption !== undefined || value.lastReportedInput !== undefined)) return invalidSession();
	if (value.version === 1) {
		if (typeof value.workspace !== "string" || !isAbsolute(value.workspace)) return invalidSession();
		location = { kind: "standalone", workspace: value.workspace };
	} else {
		if (typeof value.storageWorkspace !== "string" || value.workspace !== undefined) return invalidSession();
		location = decodeLocation(value.location);
	}
	if (value.locationRevision !== undefined && (!Number.isSafeInteger(value.locationRevision) || Number(value.locationRevision) < 0)) return invalidSession();
	const locationChanges = value.locationChanges === undefined ? undefined : decodeLocationChanges(value.locationChanges);
	const activeOperation = value.activeOperation === undefined ? undefined : decodeActiveOperation(value.activeOperation);
	let name: string | null = null;
	if (value.name !== null) {
		try { name = sessionName(value.name as string); } catch { return invalidSession(); }
		if (name !== value.name) {
			return invalidSession();
		}
	}
	const history = validateHistory(value.history);
	let modelSelection: ModelSelection | undefined;
	if (value.modelSelection !== undefined) {
		if (value.version !== 3) return invalidSession();
		try { modelSelection = decodeModelSelection(value.modelSelection); } catch { return invalidSession(); }
	}
	const compaction = value.compaction === undefined ? undefined : decodeCompaction(value.compaction, history);
	let attempt: SessionAttempt | null = null;
	if (value.attempt !== null) {
		const raw = value.attempt;
		if (!isRecord(raw) || typeof raw.prompt !== "string" || !raw.prompt.trim() || !isDate(raw.startedAt)
			|| !isDate(raw.updatedAt) || !Number.isSafeInteger(raw.ownerPid) || Number(raw.ownerPid) < 1
			|| !["running", "failed", "cancelled"].includes(String(raw.status))
			|| (raw.code !== null && (typeof raw.code !== "string" || !/^[A-Z_]{1,80}$/.test(raw.code)))) return invalidSession();
		const messages = validateHistory(raw.messages, false);
		if (messages.length && (messages.length <= history.length
			|| JSON.stringify(messages.slice(0, history.length)) !== JSON.stringify(history)
			|| messages[history.length || 1]?.role !== "user"
			|| messages[history.length || 1]?.content !== raw.prompt
			|| messages.filter((message) => message.role === "user").length
				!== history.filter((message) => message.role === "user").length + 1)) return invalidSession();
		attempt = { prompt: raw.prompt, startedAt: raw.startedAt, updatedAt: raw.updatedAt,
			ownerPid: Number(raw.ownerPid), status: raw.status as SessionAttempt["status"],
			code: raw.code as string | null, messages };
	}
	if (activeOperation && attempt?.status === "running") return invalidSession();
	if (value.version !== 3 && [...history, ...(attempt?.messages ?? [])]
		.some((message) => message.role === "assistant" && message.modelContext !== undefined)) return invalidSession();
	return { version: value.version, id, workspace: location.kind === "standalone" ? location.workspace : "",
		...(value.consumption === undefined ? {} : { consumption: decodeConsumption(value.consumption) }),
		...(value.lastReportedInput === undefined ? {} : { lastReportedInput: decodeObservation(value.lastReportedInput) }),
		...(modelSelection ? { modelSelection } : {}),
		location, locationRevision: Number(value.locationRevision ?? 0), name, title: value.title, createdAt: value.createdAt,
		...(locationChanges ? { locationChanges } : {}), ...(activeOperation ? { activeOperation } : {}),
		...(compaction ? { compaction } : {}),
		...(value.storageWorkspace === undefined ? {} : { storageWorkspace: String(value.storageWorkspace) }),
		updatedAt: value.updatedAt, revision: Number(value.revision), forkedFrom: value.forkedFrom as string | null,
		history, attempt, ...(value.automations === undefined ? {} : { automations: decodeBoundTasks(value.automations) }) };
}

function decodeLocation(value: unknown): SessionLocation {
	if (!isRecord(value)) return invalidSession();
	if (value.kind === "standalone" && typeof value.workspace === "string" && isAbsolute(value.workspace)
		&& value.projectId === undefined) return { kind: "standalone", workspace: value.workspace };
	if (value.kind === "project" && typeof value.projectId === "string" && sessionIdPattern.test(value.projectId)
		&& value.workspace === undefined) return { kind: "project", projectId: value.projectId };
	return invalidSession();
}

function decodeLocationChanges(value: unknown): SessionLocationChange[] {
	if (!Array.isArray(value) || value.length > 100) return invalidSession();
	const ids = new Set<string>();
	return value.map((raw: unknown) => {
		if (!isRecord(raw) || typeof raw.id !== "string" || !sessionIdPattern.test(raw.id) || ids.has(raw.id)
			|| typeof raw.fromWorkspace !== "string" || !isAbsolute(raw.fromWorkspace)
			|| typeof raw.toWorkspace !== "string" || !isAbsolute(raw.toWorkspace)
			|| !isDate(raw.changedAt) || typeof raw.acknowledged !== "boolean") return invalidSession();
		ids.add(raw.id);
		return { id: raw.id, from: decodeLocation(raw.from), to: decodeLocation(raw.to), fromWorkspace: raw.fromWorkspace,
			toWorkspace: raw.toWorkspace, changedAt: raw.changedAt, acknowledged: raw.acknowledged };
	});
}

function decodeActiveOperation(value: unknown): SessionActiveOperation {
	if (!isRecord(value) || value.kind !== "compact" || typeof value.id !== "string" || !sessionIdPattern.test(value.id)
		|| !Number.isSafeInteger(value.ownerPid) || Number(value.ownerPid) < 1 || !isDate(value.startedAt)) return invalidSession();
	return { kind: "compact", id: value.id, ownerPid: Number(value.ownerPid), startedAt: value.startedAt };
}

/** Explicit disk shape excludes credentials, projections and unknown fields. */
export function encodeSessionRecord(record: SessionRecord): Record<string, unknown> {
	const modelHistory = [...record.history, ...(record.attempt?.messages ?? [])]
		.some((message) => message.role === "assistant" && message.modelContext !== undefined);
	return { version: record.version === 3 || record.modelSelection || modelHistory || record.consumption || record.lastReportedInput ? 3 : 2,
		...(record.modelSelection ? { modelSelection: decodeModelSelection(record.modelSelection) } : {}),
		...(record.consumption ? { consumption: decodeConsumption(record.consumption) } : {}),
		...(record.lastReportedInput ? { lastReportedInput: decodeObservation(record.lastReportedInput) } : {}),
		id: record.id, location: locationOf(record), locationRevision: record.locationRevision ?? 0,
		storageWorkspace: record.storageWorkspace ?? record.workspace, name: record.name, title: record.title,
		createdAt: record.createdAt, updatedAt: record.updatedAt, revision: record.revision,
		forkedFrom: record.forkedFrom, history: record.history, attempt: record.attempt,
		...(record.locationChanges === undefined ? {} : { locationChanges: record.locationChanges }),
		...(record.activeOperation === undefined ? {} : { activeOperation: record.activeOperation }),
		...(record.automations === undefined ? {} : { automations: record.automations }),
		...(record.compaction === undefined ? {} : { compaction: record.compaction }) };
}
