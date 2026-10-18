import type { SessionSummary } from "@fatcat/runtime/session/record";
import type { ProjectRecord } from "@fatcat/runtime/project/record";
import type { WebUiState } from "../types.js";
import { icon } from "./icons.js";

interface SessionListActions {
	canManage(): boolean;
	createChat(projectId: string): void;
	selectSession(session: SessionSummary, selected: boolean): void;
	joinProject(sessionId: string, projectId: string): void;
	closeSessionMenu(): void;
	openSessionMenu(session: SessionSummary, trigger: HTMLElement, x: number, y: number): void;
	openProjectMenu(project: ProjectRecord, trigger: HTMLElement, x: number, y: number): void;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
	const result = document.createElement(tag);
	if (text !== undefined) result.textContent = text;
	if (className) result.className = className;
	return result;
}

export function displaySessions(next: Pick<WebUiState, "current" | "sessions">): SessionSummary[] {
	if (next.current.revision === 0) return next.sessions;
	return next.sessions.some((session) => session.id === next.current.id) ? next.sessions : [next.current, ...next.sessions];
}

/** Owns list nodes and their render signature; actions use the page's live state. */
export class SessionListView {
	private signature = "";
	private readonly collapsedProjects = new Map<string, boolean>();
	private readonly sessionDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });

	constructor(private readonly container: HTMLElement, private readonly actions: SessionListActions) {}

	setDisabled(disabled: boolean): void {
		this.container.querySelectorAll<HTMLButtonElement>(".project-new-chat,.project-more").forEach((button) => {
			button.disabled = disabled;
		});
	}

	update(next: Pick<WebUiState, "current" | "sessions" | "projects">): void {
		const sessions = displaySessions(next);
		const signature = JSON.stringify([next.current.id, sessions, next.projects]);
		if (signature === this.signature) return;
		this.signature = signature;
		this.container.replaceChildren();
		for (const id of this.collapsedProjects.keys()) {
			if (!next.projects.some((project) => project.id === id)) {
				this.collapsedProjects.delete(id);
				try { localStorage.removeItem(`fatcat-project-collapsed:${id}`); } catch { /* Browser storage may be unavailable. */ }
			}
		}
		const groups = new Map<string, HTMLElement>();
		for (const project of next.projects) {
			if (!this.collapsedProjects.has(project.id)) {
				let collapsed = false;
				try { collapsed = localStorage.getItem(`fatcat-project-collapsed:${project.id}`) === "true"; } catch { /* Default to expanded without storage. */ }
				this.collapsedProjects.set(project.id, collapsed);
			}
			const group = node("section", undefined, "project-group");
			group.dataset.projectId = project.id;
			group.setAttribute("aria-label", `Project ${project.name}`);
			const heading = node("div", undefined, "project-heading");
			const name = node("span", project.name, "project-name");
			name.title = `${project.name}\n${project.workspace}`;
			const sessions = node("div", undefined, "project-sessions");
			sessions.id = `project-sessions-${project.id}`;
			sessions.hidden = this.collapsedProjects.get(project.id) === true;
			const toggle = node("button", undefined, "project-toggle");
			toggle.type = "button";
			toggle.setAttribute("aria-controls", sessions.id);
			const updateToggle = () => {
				toggle.setAttribute("aria-expanded", String(!sessions.hidden));
				toggle.setAttribute("aria-label", `${sessions.hidden ? "Expand" : "Collapse"} ${project.name}`);
				toggle.title = `${sessions.hidden ? "Expand" : "Collapse"} project chats`;
			};
			updateToggle();
			toggle.append(name, icon("chevron-down"));
			toggle.addEventListener("click", () => {
				sessions.hidden = !sessions.hidden;
				this.collapsedProjects.set(project.id, sessions.hidden);
				try { localStorage.setItem(`fatcat-project-collapsed:${project.id}`, String(sessions.hidden)); } catch { /* Keep the choice for this page. */ }
				updateToggle();
			});
			const create = node("button", undefined, "project-new-chat icon-button");
			create.type = "button";
			create.setAttribute("aria-label", `New chat in ${project.name}`);
			create.title = `New chat in ${project.name}`;
			create.append(icon("plus"));
			create.addEventListener("click", () => {
				this.actions.createChat(project.id);
			});
			const more = node("button", undefined, "project-more icon-button");
			more.type = "button";
			more.dataset.projectActionId = project.id;
			more.setAttribute("aria-label", `Actions for project ${project.name}`);
			more.setAttribute("aria-haspopup", "menu");
			more.setAttribute("aria-controls", "project-menu");
			more.setAttribute("aria-expanded", "false");
			more.title = "Project actions";
			more.append(icon("ellipsis"));
			const openProjectMenu = () => {
				this.actions.closeSessionMenu();
				const bounds = more.getBoundingClientRect();
				this.actions.openProjectMenu(project, more, bounds.left, bounds.bottom + 4);
			};
			more.addEventListener("click", openProjectMenu);
			more.addEventListener("keydown", (event) => {
				if (event.key === "ArrowDown" || event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
					event.preventDefault(); openProjectMenu();
				}
			});
			heading.addEventListener("contextmenu", (event) => {
				event.preventDefault(); openProjectMenu();
			});
			const actions = node("div", undefined, "project-heading-actions");
			actions.append(create, more);
			heading.append(toggle, actions);
			group.append(heading, sessions);
			group.addEventListener("dragover", (event) => {
				if (!this.actions.canManage() || !event.dataTransfer?.types.includes("application/x-fatcat-session")) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = "move";
				group.classList.add("project-drop-target");
			});
			group.addEventListener("dragleave", (event) => {
				if (!(event.relatedTarget instanceof Node) || !group.contains(event.relatedTarget)) group.classList.remove("project-drop-target");
			});
			group.addEventListener("drop", (event) => {
				event.preventDefault();
				group.classList.remove("project-drop-target");
				const id = event.dataTransfer?.getData("application/x-fatcat-session");
				if (id) this.actions.joinProject(id, project.id);
			});
			groups.set(project.id, sessions);
			this.container.append(group);
		}
		const independent = node("section", undefined, "independent-sessions");
		independent.setAttribute("aria-label", "Independent chats");
		if (next.projects.length) independent.append(node("div", "Independent chats", "section-label"));
		this.container.append(independent);
		if (sessions.length === 0 && next.projects.length === 0) {
			this.container.append(node("p", "Your conversations will appear here after your first message.", "session-empty"));
		}
		for (const session of sessions) {
			const button = node("button", undefined, "conversation");
			const selected = session.id === next.current.id;
			button.setAttribute("aria-current", String(selected));
			const metadata = `${session.turnCount} ${session.turnCount === 1 ? "turn" : "turns"} · ${this.sessionDate.format(new Date(session.updatedAt))} · ${session.workspace}`;
			button.title = `${session.name ?? session.title}\n${metadata}\n${session.id}`;
			button.setAttribute("aria-description", metadata);
			button.dataset.sessionId = session.id;
			button.draggable = !session.projectId;
			button.addEventListener("dragstart", (event) => {
				if (!this.actions.canManage() || session.projectId) { event.preventDefault(); return; }
				event.dataTransfer?.setData("application/x-fatcat-session", session.id);
				if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
				this.actions.closeSessionMenu();
			});
			button.addEventListener("dragend", () => {
				this.container.querySelectorAll(".project-drop-target").forEach((group) => group.classList.remove("project-drop-target"));
			});
			button.setAttribute("aria-haspopup", "menu");
			const copy = node("span", undefined, "session-copy");
			copy.append(node("span", session.name ?? session.title, "session-name"));
			button.append(copy);
			button.addEventListener("click", () => {
				this.actions.selectSession(session, selected);
			});
			button.addEventListener("contextmenu", (event) => {
				event.preventDefault();
				this.actions.openSessionMenu(session, button, event.clientX, event.clientY);
			});
			button.addEventListener("keydown", (event) => {
				if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
					event.preventDefault();
					const bounds = button.getBoundingClientRect();
					this.actions.openSessionMenu(session, button, bounds.left + 16, bounds.bottom);
				}
			});
			const row = node("div", undefined, "session-row");
			row.dataset.active = String(selected);
			const more = node("button", undefined, "session-more icon-button");
			more.type = "button";
			more.setAttribute("aria-label", `Actions for ${session.name ?? session.title}`);
			more.setAttribute("aria-haspopup", "menu");
			more.setAttribute("aria-controls", "session-menu");
			more.setAttribute("aria-expanded", "false");
			more.title = "Session actions";
			more.append(icon("ellipsis"));
			more.addEventListener("click", () => {
				const bounds = more.getBoundingClientRect();
				this.actions.openSessionMenu(session, more, bounds.left, bounds.bottom + 4);
			});
			row.append(button, more);
			if (session.automationCount) {
				const clock = node("span", undefined, "session-clock");
				clock.title = `${session.automationCount} linked automation task(s)`;
				clock.setAttribute("aria-label", clock.title);
				clock.append(icon("clock"));
				row.append(clock);
			}
			if (session.projectId && !groups.has(session.projectId)) {
				const missing = node("section", undefined, "project-group");
				missing.append(node("div", session.projectName ?? "Unavailable project", "project-heading"));
				groups.set(session.projectId, missing);
				this.container.insertBefore(missing, independent);
			}
			(session.projectId ? groups.get(session.projectId)! : independent).append(row);
		}
	}
}
