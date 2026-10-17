import { isAbsolute } from "node:path";
import { HarnessError } from "../errors.js";

export const projectIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export interface ProjectRecord {
	version: 1;
	id: string;
	name: string;
	workspace: string;
	createdAt: string;
	updatedAt: string;
	revision: number;
}

export function projectName(value: string): string {
	const name = value.trim();
	if (!name || name.length > 120 || /[\x00-\x1f\x7f]/.test(name)) {
		throw new HarnessError("PROJECT_NAME", "Use a non-empty project name of at most 120 characters without control characters.");
	}
	return name;
}

export function decodeProjectRecord(value: unknown, id: string): ProjectRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return invalidProject();
	const raw = value as Record<string, unknown>;
	if (raw.version !== 1 || raw.id !== id || !projectIdPattern.test(id)
		|| typeof raw.name !== "string" || typeof raw.workspace !== "string" || !isAbsolute(raw.workspace)
		|| !isDate(raw.createdAt) || !isDate(raw.updatedAt)
		|| !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 1) return invalidProject();
	try {
		if (projectName(raw.name) !== raw.name) return invalidProject();
	} catch { return invalidProject(); }
	return { version: 1, id, name: raw.name, workspace: raw.workspace,
		createdAt: raw.createdAt, updatedAt: raw.updatedAt, revision: Number(raw.revision) };
}

function isDate(value: unknown): value is string {
	return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

export function invalidProject(): never {
	throw new HarnessError("PROJECT_CORRUPT", "The saved project is invalid or unsupported. Repair its record before using its sessions.");
}
