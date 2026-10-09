import { HarnessError, checkCancellation } from "../errors.js";
import { FileChanges } from "../automation/files.js";
import { newBoundTask, taskIsEnabled } from "../automation/tasks.js";
import type { BoundTask, SessionAutomation } from "../automation/tasks.js";
import type { SessionRecord } from "./record.js";

export interface SessionAutomationOptions {
	persistent: boolean;
	automated: boolean;
	listAutomations: () => Promise<SessionAutomation[]>;
}

export interface SessionAutomationChange {
	record?: SessionRecord;
	result: unknown;
}

/** Validate a schedule change without publishing it or mutating the active record. */
export async function prepareSessionAutomation(
	record: SessionRecord,
	value: unknown,
	options: SessionAutomationOptions,
	signal?: AbortSignal,
): Promise<SessionAutomationChange> {
	checkCancellation(signal);
	if (!options.persistent) {
		throw new HarnessError("AUTOMATION_UNAVAILABLE", "Automation needs a saved session; restart without --no-session-persistence.");
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new HarnessError("AUTOMATION_CONFIG", "Expected automation arguments.");
	}
	const args = value as Record<string, unknown>;
	const { action, ...fields } = args;
	if (action === "list") {
		if (Object.keys(fields).length) {
			throw new HarnessError("AUTOMATION_CONFIG", "List takes no other fields.");
		}
		return { result: { sessionId: record.id, now: new Date().toString(), tasks: structuredClone(record.automations ?? []) } };
	}
	if (options.automated) {
		throw new HarnessError("AUTOMATION_DENIED", "Automated turns cannot create or change schedules. Ask the user to manage them.");
	}
	let tasks = structuredClone(record.automations ?? []);
	let selected: BoundTask | undefined;
	if (action === "create") {
		if (tasks.length >= 32) {
			throw new HarnessError("AUTOMATION_LIMIT", "At most 32 tasks can be bound to one session.");
		}
		selected = newBoundTask(fields);
		const existing = await options.listAutomations();
		if (existing.filter((task) => taskIsEnabled(task)).length >= 128) {
			throw new HarnessError("AUTOMATION_LIMIT", "At most 128 enabled tasks can run in this workspace.");
		}
		const paths = [...existing, selected].filter((task) => taskIsEnabled(task))
			.flatMap((task) => task.trigger.type === "file_changed" ? task.trigger.paths : []);
		if (new Set(paths).size > 64) {
			throw new HarnessError("AUTOMATION_LIMIT", "At most 64 different files can be monitored in this workspace.");
		}
		if (selected.trigger.type === "file_changed") {
			await FileChanges.open(record.workspace, selected.trigger.paths, signal);
		}
		tasks.push(selected);
	} else {
		if (!["pause", "resume", "delete"].includes(String(action)) || Object.keys(fields).length !== 1 || typeof fields.id !== "string") {
			throw new HarnessError("AUTOMATION_CONFIG", "Use create/list or pause/resume/delete with an exact task ID.");
		}
		selected = tasks.find((task) => task.id === fields.id);
		if (!selected) {
			throw new HarnessError("AUTOMATION_NOT_FOUND", "No matching task belongs to this session.");
		}
		if (action === "delete") tasks = tasks.filter((task) => task.id !== fields.id);
		else {
			selected.enabled = action === "resume";
			if (action === "resume") {
				if (!taskIsEnabled(selected)) {
					throw new HarnessError("AUTOMATION_INACTIVE", "This task has expired or exhausted its run limit. Create a new task.");
				}
				if (selected.lastStatus === "running") selected.lastStatus = "cancelled";
			}
		}
	}
	checkCancellation(signal);
	const updated = { ...record, automations: tasks, updatedAt: new Date().toISOString(),
		title: record.title === "New session" && selected ? selected.prompt.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 80) : record.title };
	return { record: updated, result: { sessionId: record.id, action, task: selected, requiresOpenProcess: true } };
}
