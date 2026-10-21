import { createHash } from "node:crypto";
import { HarnessError } from "../errors.js";
import { projectIdOf } from "../session/record.js";
import type { SessionRecord, SessionSummary } from "../session/record.js";

export const maxProjectMembers = 1000;

export interface ProjectImpact {
	projectId: string;
	projectRevision: number;
	projectName: string;
	sessionCount: number;
	automationCount: number;
	attachmentCount: number;
	retainedAttachmentCount: number;
	memberFingerprint: string;
	attachmentFingerprint: string;
}

export interface ProjectWorkspacePreview extends ProjectImpact {
	fromWorkspace: string;
	toWorkspace: string;
}

export interface ProjectDeletePreview extends ProjectImpact {
	workspace: string;
	deleteAttachmentCount: number;
}

/** A bounded metadata patch keeps full histories out of project transactions. */
export interface ProjectSessionMove {
	id: string;
	storageWorkspace: string;
	projectId: string;
	expectedRevision: number;
	locationRevision: number;
	fromWorkspace: string;
	toWorkspace: string;
	changedAt: string;
	changeId: string;
}

export function projectMemberFingerprint(members: SessionSummary[]): string {
	return createHash("sha256").update(JSON.stringify(members.map((member) => ({ id: member.id,
		revision: member.revision, locationRevision: member.locationRevision ?? 0 })).sort((a, b) => a.id.localeCompare(b.id)))).digest("hex");
}

export function movedProjectSession(record: SessionRecord, move: ProjectSessionMove): SessionRecord {
	if (record.id !== move.id || projectIdOf(record) !== move.projectId || record.revision !== move.expectedRevision
		|| (record.locationRevision ?? 0) !== move.locationRevision) {
		throw new HarnessError("PROJECT_CONFLICT", "A project session changed. Refresh the project before changing its directory.");
	}
	const changes = (record.locationChanges ?? []).filter((change) => !change.acknowledged);
	if (changes.length >= 100) throw new HarnessError("SESSION_LIMIT", "A project session has too many unacknowledged directory changes. Continue it before changing the project directory.");
	const location = { kind: "project" as const, projectId: move.projectId };
	return { ...record, workspace: move.toWorkspace, location,
		storageWorkspace: move.storageWorkspace, revision: move.expectedRevision + 1,
		locationRevision: move.locationRevision + 1, updatedAt: move.changedAt,
		locationChanges: [...changes, { id: move.changeId, from: location, to: location,
			fromWorkspace: move.fromWorkspace, toWorkspace: move.toWorkspace, changedAt: move.changedAt, acknowledged: false }],
		automations: (record.automations ?? []).map((task) => ({ ...task, enabled: false })),
	};
}
