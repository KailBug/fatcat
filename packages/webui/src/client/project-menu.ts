import type { ProjectRecord } from "@fatcat/runtime/project/record";
import { icon } from "./icons.js";

export type ProjectAction = "rename" | "workspace" | "delete";

/** Project controls follow the session menu's pointer, keyboard and focus behavior. */
export class ProjectMenu {
	private selected: ProjectRecord | undefined;
	private trigger: HTMLElement | undefined;
	private readonly title = document.createElement("div");
	private readonly buttons: HTMLButtonElement[] = [];

	constructor(private readonly menu: HTMLElement,
		private readonly onAction: (action: ProjectAction, project: ProjectRecord) => void,
		private readonly canManage: () => boolean) {
		this.title.className = "session-menu-title";
		menu.append(this.title);
		for (const [action, label, symbol] of [["rename", "Rename project", "pencil"],
			["workspace", "Change workspace", "folder"], ["delete", "Delete project", "trash"]] as const) {
			const button = document.createElement("button");
			button.type = "button";
			button.role = "menuitem";
			button.tabIndex = -1;
			button.dataset.action = action;
			button.append(icon(symbol), document.createTextNode(label));
			button.addEventListener("click", () => {
				if (!this.selected || !this.canManage()) return;
				const project = this.selected;
				this.close(true);
				this.onAction(action, project);
			});
			this.buttons.push(button);
			menu.append(button);
		}
		menu.addEventListener("keydown", (event) => {
			if (event.key === "Escape" || event.key === "Tab") {
				this.close(true);
				event.stopPropagation();
				if (event.key === "Escape") event.preventDefault();
				return;
			}
			const enabled = this.buttons.filter((button) => !button.disabled);
			const index = enabled.indexOf(document.activeElement as HTMLButtonElement);
			let next: HTMLButtonElement | undefined;
			if (event.key === "ArrowDown") next = enabled[(index + 1) % enabled.length];
			if (event.key === "ArrowUp") next = enabled[(index - 1 + enabled.length) % enabled.length];
			if (event.key === "Home") next = enabled[0];
			if (event.key === "End") next = enabled.at(-1);
			if (next) { event.preventDefault(); event.stopPropagation(); next.focus(); }
		});
		document.addEventListener("pointerdown", (event) => {
			if (event.target instanceof Node && !menu.contains(event.target)) this.close();
		});
		document.addEventListener("scroll", (event) => {
			if (event.target instanceof Node && this.trigger && event.target.contains(this.trigger)) this.close();
		}, true);
		window.addEventListener("resize", () => this.close());
	}

	open(project: ProjectRecord, trigger: HTMLElement, x: number, y: number): void {
		this.close();
		this.selected = structuredClone(project);
		this.trigger = trigger;
		trigger.setAttribute("aria-expanded", "true");
		this.title.textContent = project.name;
		this.title.title = project.name;
		this.buttons.forEach((button) => { button.disabled = !this.canManage(); });
		this.menu.hidden = false;
		const bounds = this.menu.getBoundingClientRect();
		this.menu.style.left = `${Math.max(8, Math.min(x, innerWidth - bounds.width - 8))}px`;
		this.menu.style.top = `${Math.max(8, Math.min(y, innerHeight - bounds.height - 8))}px`;
		this.buttons.find((button) => !button.disabled)?.focus({ preventScroll: true });
	}

	update(projects: readonly ProjectRecord[]): void {
		if (!this.selected) return;
		const current = projects.find((project) => project.id === this.selected!.id);
		if (!current || current.revision !== this.selected.revision || !this.trigger?.isConnected) { this.close(); return; }
		this.buttons.forEach((button) => { button.disabled = !this.canManage(); });
	}

	close(restoreFocus = false): void {
		if (this.menu.hidden) return;
		this.menu.hidden = true;
		this.selected = undefined;
		this.trigger?.setAttribute("aria-expanded", "false");
		if (restoreFocus && this.trigger?.isConnected) this.trigger.focus({ preventScroll: true });
		this.trigger = undefined;
	}
}
