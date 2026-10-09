import type { SessionSummary } from "../../src/session/record.js";

import { icon } from "./icons.js";

export type SessionAction = "details" | "rename" | "fork" | "delete" | "workspace";

/** A single menu owns pointer placement, keyboard navigation, and focus restoration. */
export class SessionMenu {
  private selected: SessionSummary | undefined;
  private trigger: HTMLElement | undefined;
  private readonly title = document.createElement("div");
  private readonly buttons: HTMLButtonElement[] = [];

  constructor(private readonly menu: HTMLElement,
    private readonly onAction: (action: SessionAction, session: SessionSummary) => void,
    private readonly canManage: () => boolean) {
    this.title.className = "session-menu-title";
    menu.append(this.title);
    for (const [action, label] of [["details", "Session details"], ["rename", "Rename session"],
      ["workspace", "Change workspace"], ["fork", "Fork session"], ["delete", "Delete session"]] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.role = "menuitem";
      button.tabIndex = -1;
      button.dataset.action = action;
      button.append(icon(({ details: "info", rename: "pencil", workspace: "folder", fork: "git-branch", delete: "trash" } as const)[action]), document.createTextNode(label));
      button.addEventListener("click", () => {
        const session = this.selected;
        if (!session || (action !== "details" && !this.canManage())) return;
        this.close(true);
        this.onAction(action, session);
      });
      menu.append(button);
      this.buttons.push(button);
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
    document.addEventListener("contextmenu", (event) => {
      if (event.target instanceof Element && !event.target.closest("[data-session-id]")) this.close();
    });
    document.addEventListener("scroll", (event) => {
      if (event.target instanceof Node && !menu.contains(event.target)) this.close();
    }, true);
    window.addEventListener("resize", () => this.close());
  }

  open(session: SessionSummary, trigger: HTMLElement, x: number, y: number): void {
    this.close();
    this.selected = structuredClone(session);
    this.trigger = trigger;
    trigger.setAttribute("aria-expanded", "true");
    this.title.textContent = session.name ?? session.title;
    this.title.title = this.title.textContent;
    this.buttons.forEach((button) => { button.disabled = button.dataset.action !== "details" && !this.canManage(); });
    this.menu.hidden = false;
    const bounds = this.menu.getBoundingClientRect();
    this.menu.style.left = `${Math.max(8, Math.min(x, innerWidth - bounds.width - 8))}px`;
    this.menu.style.top = `${Math.max(8, Math.min(y, innerHeight - bounds.height - 8))}px`;
    this.buttons[0]?.focus({ preventScroll: true });
  }

  update(sessions: readonly SessionSummary[]): void {
    if (!this.selected) return;
    const latest = sessions.find((session) => session.id === this.selected!.id);
    if (!latest || latest.revision !== this.selected.revision) { this.close(); return; }
    const focused = document.activeElement;
    this.buttons.forEach((button) => { button.disabled = button.dataset.action !== "details" && !this.canManage(); });
    if (this.buttons.some((button) => button.disabled && button === focused)) {
      this.buttons[0]?.focus({ preventScroll: true });
    }
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
