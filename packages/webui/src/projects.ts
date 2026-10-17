import { randomUUID } from "node:crypto";
import { HarnessError } from "@fatcat/runtime/errors";
import type { ProjectJoinPreview } from "@fatcat/runtime/project/operations";

export interface ProjectJoinConfirmation {
	token: string;
	preview: ProjectJoinPreview;
}

/** The browser confirms an opaque token; paths and revisions remain server-owned. */
export class ProjectJoinConfirmations {
	private readonly pending = new Map<string, { preview: ProjectJoinPreview; expiresAt: number }>();

	create(preview: ProjectJoinPreview): ProjectJoinConfirmation {
		for (const [token, item] of this.pending) {
			if (item.expiresAt <= Date.now()) this.pending.delete(token);
		}
		if (this.pending.size >= 100) this.pending.delete(this.pending.keys().next().value!);
		const token = randomUUID();
		this.pending.set(token, { preview: structuredClone(preview), expiresAt: Date.now() + 600_000 });
		return { token, preview: structuredClone(preview) };
	}

	take(token: string): ProjectJoinPreview {
		const item = this.pending.get(token);
		this.pending.delete(token);
		if (!item || item.expiresAt <= Date.now()) {
			throw new HarnessError("SESSION_CONFLICT", "This project confirmation expired. Review the move again.");
		}
		return item.preview;
	}
}
