import { randomUUID } from "node:crypto";
import { HarnessError } from "../errors.js";
import { locationOf, projectIdOf } from "../session/record.js";
import type { SessionRecord } from "../session/record.js";
import type { ProjectRecord } from "./record.js";

export interface ProjectJoinPreview {
	sessionId: string;
	sessionRevision: number;
	projectId: string;
	projectRevision: number;
	projectName: string;
	fromWorkspace: string;
	toWorkspace: string;
	locationRevision: number;
	automationCount: number;
	attachmentCount: number;
	attachmentRevision: number;
	attachmentFingerprint: string;
	memoryCount: number;
	memoryFingerprint: string;
	alreadyJoined: boolean;
}

export function projectJoinPreview(record: SessionRecord, project: ProjectRecord): ProjectJoinPreview {
	const currentProject = projectIdOf(record);
	if (currentProject && currentProject !== project.id) {
		throw new HarnessError("PROJECT_MEMBERSHIP", "Moving a session between projects is not supported. Start a new session in the target project.");
	}
	return {
		sessionId: record.id,
		sessionRevision: record.revision,
		projectId: project.id,
		projectRevision: project.revision,
		projectName: project.name,
		fromWorkspace: record.workspace,
		toWorkspace: project.workspace,
		locationRevision: record.locationRevision ?? 0,
		automationCount: record.automations?.filter((task) => task.enabled).length ?? 0,
		attachmentCount: 0,
		attachmentRevision: 0,
		attachmentFingerprint: "",
		memoryCount: 0,
		memoryFingerprint: "",
		alreadyJoined: currentProject === project.id,
	};
}

export function requireProjectJoinPreview(current: ProjectJoinPreview, supplied: ProjectJoinPreview): void {
	if (Object.keys(current).some((key) => current[key as keyof ProjectJoinPreview] !== supplied[key as keyof ProjectJoinPreview])) {
		throw new HarnessError("SESSION_CONFLICT", "The session or project changed. Review a fresh move preview before confirming.");
	}
}

export function joinedProjectRecord(record: SessionRecord, project: ProjectRecord): SessionRecord {
	const changes = record.locationChanges ?? [];
	if (changes.filter((change) => !change.acknowledged).length >= 100) {
		throw new HarnessError("SESSION_LIMIT", "Too many workspace changes await a successful turn. Continue the session before moving it.");
	}
	const now = new Date().toISOString();
	const location = { kind: "project" as const, projectId: project.id };
	return {
		...record,
		version: 2,
		location,
		workspace: project.workspace,
		projectName: project.name,
		projectRevision: project.revision,
		storageWorkspace: record.storageWorkspace ?? record.workspace,
		locationRevision: (record.locationRevision ?? 0) + 1,
		updatedAt: now,
		locationChanges: [...changes.filter((change) => !change.acknowledged), {
			id: randomUUID(), from: locationOf(record), to: location,
			fromWorkspace: record.workspace, toWorkspace: project.workspace,
			changedAt: now, acknowledged: false,
		}],
		automations: (record.automations ?? []).map((task) => ({ ...task, enabled: false })),
	};
}
