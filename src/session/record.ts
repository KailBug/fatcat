import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { HarnessError } from "../errors.js";
import type { Message } from "../model.js";
import { decodeBoundTasks } from "../automation/tasks.js";
import type { BoundTask } from "../automation/tasks.js";
import { invalidSession, isRecord, validateHistory } from "./history.js";

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
	version: 1;
	id: string;
	workspace: string;
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
}

export interface SessionSummary {
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
}

export function sessionSummary(record: SessionRecord): SessionSummary {
	return { id: record.id, workspace: record.workspace, name: record.name, title: record.title,
		createdAt: record.createdAt, updatedAt: record.updatedAt, revision: record.revision,
		turnCount: record.history.filter((message) => message.role === "user").length,
		forkedFrom: record.forkedFrom, interrupted: record.attempt !== null,
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
	if (!isRecord(value) || value.version !== 1 || value.id !== id || !sessionIdPattern.test(id)
		|| typeof value.workspace !== "string"
		|| (value.storageWorkspace !== undefined && (typeof value.storageWorkspace !== "string" || !isAbsolute(value.storageWorkspace)))
		|| workspaceKey(String(value.storageWorkspace ?? value.workspace)) !== workspaceKey(workspace)
		|| !isAbsolute(value.workspace) || (value.name !== null && typeof value.name !== "string")
		|| typeof value.title !== "string" || value.title.length > 120 || /[\x00-\x1f\x7f]/.test(value.title)
		|| !isDate(value.createdAt) || !isDate(value.updatedAt) || !Number.isSafeInteger(value.revision)
		|| Number(value.revision) < 1 || (value.forkedFrom !== null && (typeof value.forkedFrom !== "string" || !sessionIdPattern.test(value.forkedFrom)))) return invalidSession();
	let name: string | null = null;
	if (value.name !== null) {
		try { name = sessionName(value.name as string); } catch { return invalidSession(); }
		if (name !== value.name) {
			return invalidSession();
		}
	}
	const history = validateHistory(value.history);
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
	return { version: 1, id, workspace: value.workspace, name, title: value.title, createdAt: value.createdAt,
		...(value.storageWorkspace === undefined ? {} : { storageWorkspace: String(value.storageWorkspace) }),
		updatedAt: value.updatedAt, revision: Number(value.revision), forkedFrom: value.forkedFrom as string | null,
		history, attempt, ...(value.automations === undefined ? {} : { automations: decodeBoundTasks(value.automations) }) };
}
