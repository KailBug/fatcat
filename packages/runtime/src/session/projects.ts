import type { AttachmentStore } from "../attachments/store.js";
import { joinedProjectRecord, projectJoinPreview } from "../project/operations.js";
import type { ProjectJoinPreview } from "../project/operations.js";
import type { ProjectRecord } from "../project/record.js";
import { executionIdentity } from "./execution.js";
import { workspaceKey } from "./record.js";
import type { SessionRecord } from "./record.js";

export interface ProjectJoinSources {
	attachments: Pick<AttachmentStore, "sharingState">;
	/** Read this record's private Memory through the manager's identity/owner gate. */
	memoryState: () => Promise<Pick<ProjectJoinPreview, "memoryCount" | "memoryFingerprint">>;
}

/** Rebuild the complete preview on each call; confirmation must read fresh sources. */
export async function sessionProjectJoinPreview(record: SessionRecord, project: ProjectRecord,
	sources: ProjectJoinSources): Promise<ProjectJoinPreview> {
	const preview = { ...projectJoinPreview(record, project), ...await sources.memoryState() };
	if (record.revision === 0) return preview;
	const sharing = await sources.attachments.sharingState(executionIdentity(record));
	return { ...preview, attachmentCount: sharing.count, attachmentRevision: sharing.revision,
		attachmentFingerprint: sharing.fingerprint };
}

/** Refresh an unsaved project session without publishing it or replacing the active runtime. */
export function projectDraftRecord(record: SessionRecord, project: ProjectRecord): SessionRecord {
	if (workspaceKey(record.workspace) !== workspaceKey(project.workspace)) return joinedProjectRecord(record, project);
	return { ...record, projectName: project.name, projectRevision: project.revision };
}
