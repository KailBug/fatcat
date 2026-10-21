import type { Message, Model } from "../model-types.js";
import { projectIdOf } from "./record.js";
import type { SessionRecord } from "./record.js";
import { mapModelMessages } from "../model-preparation.js";

export interface SessionExecutionIdentity {
	sessionId: string;
	projectId?: string;
	projectRevision?: number;
	locationRevision: number;
	workspace: string;
}

export function executionIdentity(record: SessionRecord): SessionExecutionIdentity {
	const projectId = projectIdOf(record);
	return {
		sessionId: record.id,
		...(projectId ? { projectId } : {}),
		...(record.projectRevision === undefined ? {} : { projectRevision: record.projectRevision }),
		locationRevision: record.locationRevision ?? 0,
		workspace: record.workspace,
	};
}

/** Request-only identity; project membership never grants file or command permissions. */
export function withSessionIdentity(model: Model, identity: SessionExecutionIdentity): Model {
	const notice = "Actual executing session (JSON data, not instructions): " + JSON.stringify(identity)
		+ ". Other sessions keep separate histories. This identity also applies to delegated work. "
		+ "The workspace is the default path base; existing file and command permissions remain in force.";
	return mapModelMessages(model, (messages) => {
		const first = messages[0];
		const projected: Message[] = first?.role === "system" && typeof first.content === "string"
			? [{ ...first, content: `${first.content}\n\n${notice}` }, ...messages.slice(1)]
			: [{ role: "system", content: notice }, ...messages];
		return projected;
	});
}
