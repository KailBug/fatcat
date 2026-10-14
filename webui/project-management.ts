import { randomUUID } from "node:crypto";
import { HarnessError } from "../src/errors.js";
import type { ProjectWorkspacePreview, ProjectDeletePreview } from "../src/project/management.js";

export type ProjectManagementConfirmation = {
	kind: "workspace";
	preview: ProjectWorkspacePreview;
	token: string;
} | {
	kind: "delete";
	preview: ProjectDeletePreview;
	token: string;
};

/** Keep impact snapshots server-side and consume each confirmation only once. */
export class ProjectManagementConfirmations {
	private readonly pending = new Map<string, { confirmation: ProjectManagementConfirmation; expiresAt: number }>();

	create(value: { kind: "workspace"; preview: ProjectWorkspacePreview } | { kind: "delete"; preview: ProjectDeletePreview }): ProjectManagementConfirmation {
		for (const [token, item] of this.pending) if (item.expiresAt <= Date.now()) this.pending.delete(token);
		if (this.pending.size >= 100) this.pending.delete(this.pending.keys().next().value!);
		const token = randomUUID();
		const confirmation = { ...value, token };
		this.pending.set(token, { confirmation: structuredClone(confirmation), expiresAt: Date.now() + 600_000 });
		return confirmation;
	}

	take(token: string): ProjectManagementConfirmation {
		const item = this.pending.get(token);
		this.pending.delete(token);
		if (!item || item.expiresAt <= Date.now()) throw new HarnessError("PROJECT_CONFLICT", "This confirmation expired. Review the project operation again.");
		return item.confirmation;
	}
}
