import type { PermissionMode, PermissionState } from "../../src/permissions/types.js";

export type PermissionModeState = PermissionState;

const modes = [
  { mode: "plan", label: "Plan", icon: "☷", description: "Read and plan. File changes and commands are disabled." },
  { mode: "default", label: "Manual", icon: "◇", description: "Ask before file changes and commands." },
  { mode: "acceptEdits", label: "Accept edits", icon: "✓", description: "Allow file changes; ask before commands." },
  { mode: "freeToGo", label: "Free to go", icon: "↗", description: "Access local files and networks. Ask before clearly dangerous commands." },
] as const;

/** The selector displays server policy; selecting a mode does not grant permissions locally. */
export class PermissionMenu {
  private state: PermissionModeState | undefined;
  private disabled = true;
  private readonly buttons: HTMLButtonElement[] = [];
  private readonly label = document.createElement("span");
  private readonly icon = document.createElement("span");

  constructor(private readonly trigger: HTMLButtonElement, private readonly menu: HTMLElement,
    private readonly onSelect: (mode: PermissionMode) => void) {
    this.label.id = "permission-mode-label";
    this.icon.className = "permission-mode-icon";
    this.icon.setAttribute("aria-hidden", "true");
    const chevron = document.createElement("span");
    chevron.className = "permission-mode-chevron";
    chevron.textContent = "⌄";
    chevron.setAttribute("aria-hidden", "true");
    trigger.append(this.icon, this.label, chevron);
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.setAttribute("aria-controls", menu.id);
    trigger.setAttribute("aria-expanded", "false");
    for (const item of modes) {
      const button = document.createElement("button");
      button.type = "button";
      button.role = "menuitemradio";
      button.dataset.mode = item.mode;
      button.tabIndex = -1;
      const copy = document.createElement("span");
      copy.className = "permission-option-copy";
      const heading = document.createElement("span");
      heading.className = "permission-option-label";
      heading.textContent = item.label;
      const description = document.createElement("span");
      description.className = "permission-option-description";
      description.textContent = item.description;
      copy.append(heading, description);
      const check = document.createElement("span");
      check.className = "permission-option-check";
      check.textContent = "✓";
      check.setAttribute("aria-hidden", "true");
      button.append(copy, check);
      button.addEventListener("click", () => {
        if (this.disabled || !this.state?.availableModes.includes(item.mode)) return;
        const changed = this.state.mode !== item.mode;
        this.close(true);
        if (changed) this.onSelect(item.mode);
      });
      menu.append(button);
      this.buttons.push(button);
    }
    trigger.addEventListener("click", () => { if (menu.hidden) this.open(); else this.close(); });
    trigger.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); this.open(event.key === "ArrowUp"); }
    });
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
      if (event.target instanceof Node && !menu.contains(event.target) && !trigger.contains(event.target)) this.close();
    });
    window.addEventListener("resize", () => this.close());
  }

  update(state: PermissionModeState | undefined, disabled: boolean): void {
    this.state = state;
    this.disabled = disabled || !state;
    const selected = modes.find((item) => item.mode === state?.mode);
    this.label.textContent = selected?.label ?? (state ? "Custom permissions" : "Manual");
    this.icon.textContent = selected?.icon ?? "◇";
    this.trigger.dataset.mode = state?.mode ?? "default";
    this.trigger.setAttribute("aria-label", `Permission mode: ${this.label.textContent}`);
    this.trigger.title = selected ? selected.description
      : state ? `Custom permissions: file changes ${state.permission}, commands ${state.shellPermission}.` : "Connecting to the local server.";
    this.trigger.disabled = this.disabled;
    this.buttons.forEach((button) => {
      const available = state?.availableModes.includes(button.dataset.mode as PermissionMode) ?? false;
      button.disabled = this.disabled || !available;
      button.setAttribute("aria-checked", String(button.dataset.mode === state?.mode));
      button.title = available ? "" : "Unavailable under this launch's permission limits.";
    });
    if (this.disabled) this.close();
  }

  close(restoreFocus = false): void {
    if (this.menu.hidden) return;
    this.menu.hidden = true;
    this.trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus && !this.trigger.disabled) this.trigger.focus({ preventScroll: true });
  }

  private open(last = false): void {
    if (this.disabled || !this.state) return;
    this.menu.hidden = false;
    this.trigger.setAttribute("aria-expanded", "true");
    const trigger = this.trigger.getBoundingClientRect();
    const bounds = this.menu.getBoundingClientRect();
    const top = trigger.top - bounds.height - 8;
    this.menu.style.left = `${Math.max(8, Math.min(trigger.left, innerWidth - bounds.width - 8))}px`;
    this.menu.style.top = `${Math.max(8, Math.min(top >= 8 ? top : trigger.bottom + 8, innerHeight - bounds.height - 8))}px`;
    const enabled = this.buttons.filter((button) => !button.disabled);
    const selected = enabled.find((button) => button.dataset.mode === this.state!.mode);
    (last ? enabled.at(-1) : selected ?? enabled[0])?.focus();
  }
}
