import type { ProjectRecord } from "../../src/project/record.js";
import type { ProjectManagementConfirmation } from "../project-management.js";
import type { ProjectAction } from "./project-menu.js";

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
	const element = document.createElement(tag);
	if (text !== undefined) element.textContent = text;
	if (className) element.className = className;
	return element;
}

export class ProjectActionDialog {
	private readonly dialog = node("dialog", undefined, "session-dialog project-dialog");
	private readonly form = node("form", undefined, "session-dialog-form");
	private readonly title = node("h2", undefined, "session-dialog-heading");
	private readonly description = node("p", undefined, "session-dialog-description");
	private readonly nameField = node("div", undefined, "session-dialog-field");
	private readonly name = node("input", undefined, "session-dialog-input");
	private readonly preview = node("div", undefined, "project-move-preview");
	private readonly error = node("p", undefined, "session-dialog-error");
	private readonly cancel = node("button", "Cancel", "session-dialog-cancel");
	private readonly submit = node("button", undefined, "session-dialog-submit");
	private action: ProjectAction = "rename";
	private selected: ProjectRecord | undefined;
	private confirmation: ProjectManagementConfirmation | undefined;
	private submitting = false;
	private trigger: HTMLElement | undefined;

	constructor(private readonly request: <T>(path: string, body: unknown, timeout?: number) => Promise<T>,
		private readonly canManage: () => boolean) {
		this.dialog.id = "project-action-dialog";
		this.title.id = "project-action-title";
		this.description.id = "project-action-description";
		this.dialog.setAttribute("aria-labelledby", this.title.id);
		this.dialog.setAttribute("aria-describedby", this.description.id);
		this.name.id = "project-action-name";
		this.name.maxLength = 120;
		this.name.autocomplete = "off";
		const label = node("label", "Project name", "session-dialog-label");
		label.htmlFor = this.name.id;
		this.nameField.append(label, this.name);
		this.error.role = "alert";
		this.cancel.type = "button";
		this.submit.type = "submit";
		const actions = node("div", undefined, "session-dialog-actions");
		actions.append(this.cancel, this.submit);
		this.form.append(this.title, this.description, this.nameField, this.preview, this.error, actions);
		this.dialog.append(this.form);
		document.body.append(this.dialog);
		this.form.addEventListener("submit", (event) => { event.preventDefault(); void this.save(); });
		this.cancel.addEventListener("click", () => { if (!this.submitting) this.dialog.close(); });
		this.dialog.addEventListener("cancel", (event) => {
			event.stopPropagation();
			if (this.submitting) event.preventDefault();
		});
		this.dialog.addEventListener("keydown", (event) => { if (event.key === "Escape") event.stopPropagation(); });
		this.dialog.addEventListener("close", () => {
			const projectId = this.selected?.id;
			const trigger = this.trigger?.isConnected ? this.trigger
				: [...document.querySelectorAll<HTMLElement>("[data-project-action-id]")].find((element) => element.dataset.projectActionId === projectId);
			this.selected = undefined;
			this.confirmation = undefined;
			trigger?.focus({ preventScroll: true });
			this.trigger = undefined;
		});
	}

	open(action: ProjectAction, project: ProjectRecord): void {
		if (this.dialog.open || !this.canManage()) return;
		this.action = action;
		this.selected = structuredClone(project);
		this.trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
		this.confirmation = undefined;
		this.preview.replaceChildren();
		this.error.hidden = true;
		this.nameField.hidden = action !== "rename";
		this.name.required = action === "rename";
		this.name.value = project.name;
		this.title.textContent = action === "rename" ? "Rename project" : action === "workspace" ? "Change project workspace" : "Delete project";
		this.description.textContent = action === "rename" ? `Choose a name for "${project.name}".`
			: action === "workspace" ? `Choose a new folder for "${project.name}", then review its effect on every project chat. Workspace files will not be moved or copied.`
				: `Review the conversations and attachment originals that will be removed from "${project.name}". This cannot be undone. Files in the project workspace will not be deleted.`;
		this.submit.classList.toggle("danger", action === "delete");
		this.update();
		this.dialog.showModal();
		if (action === "rename") { this.name.focus(); this.name.select(); }
		if (action === "delete") void this.save();
	}

	update(): void {
		this.name.disabled = this.submitting;
		this.cancel.disabled = this.submitting;
		this.submit.disabled = this.submitting || !this.canManage();
		this.submit.textContent = this.submitting ? "Working…" : this.action === "rename" ? "Save project name"
			: this.action === "workspace" ? this.confirmation ? "Confirm workspace change" : "Choose folder"
				: this.confirmation ? "Delete project and data" : "Review deletion";
	}

	private showPreview(confirmation: ProjectManagementConfirmation): void {
		this.confirmation = confirmation;
		const { preview } = confirmation;
		if (confirmation.kind === "workspace") {
			const paths = node("dl");
			paths.append(node("dt", "Current folder"), node("dd", confirmation.preview.fromWorkspace),
				node("dt", "New project folder"), node("dd", confirmation.preview.toWorkspace));
			this.preview.replaceChildren(paths, node("p", `${preview.sessionCount} saved chat(s), plus new and unsaved project chats, will use the new folder. Conversation history and existing source paths stay unchanged.`),
				node("p", `${preview.automationCount} enabled automation task(s) will be paused. Review their paths before resuming. Pending uploads and old workspace approvals will no longer apply.`),
				node("p", "Project attachments keep their existing sharing scope. Files in either workspace are not moved, copied or deleted."));
		} else {
			this.preview.replaceChildren(node("p", `${preview.sessionCount} saved chat(s) and ${preview.automationCount} automation task(s) will be deleted. Any current unsaved chat in this project will also be closed.`),
				node("p", `${confirmation.preview.attachmentCount} project attachment original(s) are affected: ${confirmation.preview.deleteAttachmentCount} will be permanently deleted; ${confirmation.preview.retainedAttachmentCount} referenced outside this project will be retained.`),
				node("p", "Other projects and independent conversations keep their own history and permitted references."),
				node("p", `The workspace folder and its files will remain untouched: ${confirmation.preview.workspace}`));
		}
	}

	private async save(): Promise<void> {
		if (this.submitting || !this.canManage() || !this.selected) return;
		this.submitting = true;
		this.error.hidden = true;
		this.update();
		try {
			const { id, revision } = this.selected;
			if (this.action === "rename") {
				const name = this.name.value.trim();
				if (!name || name.length > 120 || /[\x00-\x1f\x7f]/.test(name)) throw new Error("Use a project name of at most 120 characters without control characters.");
				await this.request("project/rename", { id, revision, name });
				this.dialog.close();
			} else if (this.confirmation) {
				await this.request(`project/${this.action === "workspace" ? "workspace" : "delete"}`, { token: this.confirmation.token, confirmed: true });
				this.dialog.close();
			} else {
				const confirmation = await this.request<ProjectManagementConfirmation | null>(`project/${this.action === "workspace" ? "workspace-preview" : "delete-preview"}`,
					{ id, revision }, this.action === "workspace" ? 310_000 : 15_000);
				if (confirmation) this.showPreview(confirmation);
			}
		} catch (error) {
			this.confirmation = undefined;
			this.preview.replaceChildren();
			this.error.textContent = error instanceof Error ? error.message : "The project operation failed. Reopen the project menu and review it again.";
			this.error.hidden = false;
		} finally { this.submitting = false; this.update(); }
	}
}
