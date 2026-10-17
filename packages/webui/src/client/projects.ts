import type { WebUiState } from "../types.js";
import type { ProjectJoinConfirmation } from "../projects.js";
import type { SessionSummary } from "@fatcat/runtime/session/record";

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
	const result = document.createElement(tag);
	if (text !== undefined) result.textContent = text;
	if (className) result.className = className;
	return result;
}

/** Creation and migration keep their original targets while tabs refresh shared state. */
export class ProjectDialog {
	private readonly dialog = node("dialog", undefined, "session-dialog project-dialog");
	private readonly form = node("form", undefined, "session-dialog-form");
	private readonly title = node("h2", undefined, "session-dialog-heading");
	private readonly description = node("p", undefined, "session-dialog-description");
	private readonly name = node("input", undefined, "session-dialog-input");
	private readonly projects = node("select", undefined, "session-dialog-input");
	private readonly label = node("label", undefined, "session-dialog-label");
	private readonly preview = node("div", undefined, "project-move-preview");
	private readonly error = node("p", undefined, "session-dialog-error");
	private readonly cancel = node("button", "Cancel", "session-dialog-cancel");
	private readonly submit = node("button", undefined, "session-dialog-submit");
	private mode: "create" | "join" = "create";
	private selected: SessionSummary | undefined;
	private confirmation: ProjectJoinConfirmation | undefined;
	private submitting = false;
	private trigger: HTMLElement | undefined;

	constructor(private readonly request: <T>(path: string, body: unknown, timeout?: number) => Promise<T>,
		private readonly canManage: () => boolean) {
		this.dialog.id = "project-dialog";
		this.title.id = "project-dialog-title";
		this.description.id = "project-dialog-description";
		this.dialog.setAttribute("aria-labelledby", this.title.id);
		this.dialog.setAttribute("aria-describedby", this.description.id);
		this.name.id = "project-name";
		this.name.maxLength = 120;
		this.name.autocomplete = "off";
		this.projects.id = "project-destination";
		this.error.role = "alert";
		this.cancel.type = "button";
		this.submit.type = "submit";
		const actions = node("div", undefined, "session-dialog-actions");
		actions.append(this.cancel, this.submit);
		this.form.append(this.title, this.description, this.label, this.name, this.projects, this.preview, this.error, actions);
		this.dialog.append(this.form);
		document.body.append(this.dialog);
		this.form.addEventListener("submit", (event) => { event.preventDefault(); void this.save(); });
		this.cancel.addEventListener("click", () => { if (!this.submitting) this.dialog.close(); });
		this.projects.addEventListener("change", () => { this.confirmation = undefined; this.preview.replaceChildren(); this.update(); });
		this.dialog.addEventListener("cancel", (event) => {
			event.stopPropagation();
			if (this.submitting) event.preventDefault();
		});
		this.dialog.addEventListener("keydown", (event) => { if (event.key === "Escape") event.stopPropagation(); });
		this.dialog.addEventListener("close", () => {
			this.confirmation = undefined;
			this.selected = undefined;
			if (this.trigger?.isConnected) this.trigger.focus({ preventScroll: true });
			this.trigger = undefined;
		});
	}

	create(): void {
		if (!this.open("create")) return;
		this.title.textContent = "Create project";
		this.description.textContent = "Choose a name, then select the project folder. Every chat in this project will use that folder. You can manage it from the project menu.";
		this.label.textContent = "Project name";
		this.label.htmlFor = this.name.id;
		this.name.value = "";
		this.name.focus();
	}

	join(session: SessionSummary, state: WebUiState, projectId?: string): void {
		if (!this.open("join")) return;
		this.selected = structuredClone(session);
		this.title.textContent = "Move session to project";
		this.description.textContent = `Review where "${session.name ?? session.title}" will belong. Moving between projects and leaving a project are not available in this version.`;
		this.label.textContent = "Destination project";
		this.label.htmlFor = this.projects.id;
		this.projects.replaceChildren(...state.projects.map((project) => {
			const option = node("option", project.name);
			option.value = project.id;
			return option;
		}));
		if (projectId) this.projects.value = projectId;
		if (!state.projects.length) this.fail("Create a project before moving a session.");
		this.update();
		this.projects.focus();
		if (projectId) void this.save();
	}

	update(): void {
		this.name.disabled = this.submitting;
		this.projects.disabled = this.submitting;
		this.cancel.disabled = this.submitting;
		this.submit.disabled = this.submitting || !this.canManage() || (this.mode === "join" && !this.projects.value);
		this.submit.textContent = this.submitting ? "Working…" : this.mode === "create" ? "Choose folder"
			: this.confirmation ? "Confirm move" : "Review move";
	}

	private open(mode: "create" | "join"): boolean {
		if (this.dialog.open || !this.canManage()) return false;
		this.mode = mode;
		this.trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
		this.confirmation = undefined;
		this.selected = undefined;
		this.error.hidden = true;
		this.preview.replaceChildren();
		this.name.hidden = mode !== "create";
		this.name.required = mode === "create";
		this.projects.hidden = mode !== "join";
		this.update();
		this.dialog.showModal();
		return true;
	}

	private fail(message: string): void {
		this.error.textContent = message;
		this.error.hidden = false;
	}

	private async save(): Promise<void> {
		if (this.submitting || !this.canManage()) return;
		this.submitting = true;
		this.error.hidden = true;
		this.update();
		try {
			if (this.mode === "create") {
				const name = this.name.value.trim();
				if (!name || name.length > 120 || /[\x00-\x1f\x7f]/.test(name)) throw new Error("Use a project name of at most 120 characters without control characters.");
				await this.request("project/create", { name }, 310_000);
				this.dialog.close();
			} else if (this.confirmation) {
				await this.request("project/join", { token: this.confirmation.token, confirmed: true });
				this.dialog.close();
			} else if (this.selected && this.projects.value) {
				const result = await this.request<ProjectJoinConfirmation>("project/join-preview", {
					projectId: this.projects.value, sessionId: this.selected.id,
				});
				this.confirmation = result;
				const { preview } = result;
				const paths = node("dl");
				paths.append(node("dt", "Current folder"), node("dd", preview.fromWorkspace), node("dt", "Project folder"), node("dd", preview.toWorkspace));
				this.preview.replaceChildren(node("p", `Move to "${preview.projectName}". Future uploads will be shared with this project. ${preview.attachmentCount} existing attachment(s) will become project-shared.`),
					paths, node("p", `${preview.memoryCount} active private Memory entry/entries become project Memory, available to all project sessions with their original sources and revisions.`),
					node("p", "Conversation histories stay separate. Existing files are not moved or copied, and historical paths are unchanged. Future operations use the project folder with your existing permissions."),
					node("p", preview.automationCount ? `${preview.automationCount} automation task(s) will be paused. Review them before resuming.` : "This session has no automation tasks to pause."));
			}
		} catch (error) {
			this.confirmation = undefined;
			this.preview.replaceChildren();
			this.fail(error instanceof Error ? error.message : "The project operation failed. Review and try again.");
		} finally {
			this.submitting = false;
			this.update();
		}
	}
}
