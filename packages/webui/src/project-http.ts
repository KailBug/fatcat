import type { ServerResponse } from "node:http";
import { HarnessError } from "@fatcat/runtime/errors";
import { projectIdPattern } from "@fatcat/runtime/project/record";
import type { WebUiController } from "./controller.js";
import type { WorkspacePicker } from "./folder-picker.js";

function json(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(value));
}

function fields(body: Record<string, unknown>, allowed: string[]): void {
	if (Object.keys(body).some((key) => !allowed.includes(key))) throw new HarnessError("INPUT", "Unexpected project request fields.");
}

/** Project paths and impact snapshots stay server-side until their explicit confirmation. */
export class ProjectManagementHttp {
	constructor(private readonly controller: WebUiController, private readonly picker: WorkspacePicker,
		private readonly shutdown: AbortSignal) {}

	async handle(path: string, body: Record<string, unknown>, response: ServerResponse): Promise<boolean> {
		if (!/^\/api\/project\/(?:rename|workspace-preview|delete-preview|workspace|delete)$/.test(path)) return false;
		if (path.endsWith("/workspace") || path.endsWith("/delete")) {
			fields(body, ["token", "confirmed"]);
			if (typeof body.token !== "string" || body.token.length > 256 || body.confirmed !== true) {
				throw new HarnessError("INPUT", "Review the project impact and explicitly confirm it.");
			}
			if (path.endsWith("/workspace")) await this.controller.changeProjectWorkspace(body.token);
			else await this.controller.deleteProject(body.token);
			json(response, 202, { accepted: true });
			return true;
		}
		fields(body, path.endsWith("/rename") ? ["id", "revision", "name"] : ["id", "revision"]);
		if (typeof body.id !== "string" || !projectIdPattern.test(body.id)
			|| !Number.isSafeInteger(body.revision) || Number(body.revision) < 1) {
			throw new HarnessError("INPUT", "Select a project and its current revision.");
		}
		if (path.endsWith("/rename")) {
			if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 120 || /[\x00-\x1f\x7f]/.test(body.name)) {
				throw new HarnessError("INPUT", "Use a project name of at most 120 characters without control characters.");
			}
			await this.controller.renameProject(body.id, body.name, Number(body.revision));
			json(response, 202, { accepted: true });
		} else if (path.endsWith("/delete-preview")) {
			json(response, 200, await this.controller.previewProjectDelete(body.id, Number(body.revision)));
		} else {
			const disconnected = new AbortController();
			const abort = () => disconnected.abort();
			response.once("close", abort);
			response.setTimeout(310_000);
			try {
				json(response, 200, await this.controller.chooseProjectWorkspaceChange(body.id, Number(body.revision), this.picker,
					AbortSignal.any([this.shutdown, disconnected.signal, AbortSignal.timeout(300_000)])));
			} finally {
				response.off("close", abort);
				if (!response.destroyed) response.setTimeout(15_000);
			}
		}
		return true;
	}
}
