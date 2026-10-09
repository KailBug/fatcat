import type { SessionSummary } from "../../src/session/record.js";

export type SessionMutation = "rename" | "fork" | "delete";

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

/** Session mutations keep their target snapshot until a successful submission or dismissal. */
export class SessionDialog {
  private readonly dialog = node("dialog", "session-dialog");
  private readonly form = node("form", "session-dialog-form");
  private readonly title = node("h2", "session-dialog-heading");
  private readonly description = node("p", "session-dialog-description");
  private readonly field = node("div", "session-dialog-field");
  private readonly input = node("input", "session-dialog-input");
  private readonly error = node("p", "session-dialog-error");
  private readonly status = node("p", "session-dialog-status");
  private readonly cancel = node("button", "session-dialog-cancel", "Cancel");
  private readonly submit = node("button", "session-dialog-submit");
  private action: SessionMutation | undefined;
  private selected: SessionSummary | undefined;
  private trigger: HTMLElement | undefined;
  private submitting = false;

  constructor(private readonly onSubmit: (action: SessionMutation, session: SessionSummary, name?: string) => Promise<string | undefined>,
    private readonly canManage: () => boolean) {
    this.dialog.id = "session-action-dialog";
    this.title.id = "session-action-title";
    this.description.id = "session-action-description";
    this.error.id = "session-action-error";
    this.dialog.setAttribute("aria-labelledby", this.title.id);
    this.dialog.setAttribute("aria-describedby", this.description.id);
    this.form.noValidate = true;
    const label = node("label", "session-dialog-label", "Session name");
    this.input.id = "session-action-name";
    label.htmlFor = this.input.id;
    this.input.type = "text";
    this.input.name = "name";
    this.input.maxLength = 120;
    this.input.autocomplete = "off";
    this.input.setAttribute("aria-describedby", this.error.id);
    this.field.append(label, this.input);
    this.error.role = "alert";
    this.status.role = "status";
    this.error.hidden = true;
    this.status.hidden = true;
    this.cancel.type = "button";
    this.submit.type = "submit";
    const actions = node("div", "session-dialog-actions");
    actions.append(this.cancel, this.submit);
    this.form.append(this.title, this.description, this.field, this.error, this.status, actions);
    this.dialog.append(this.form);
    document.body.append(this.dialog);
    this.cancel.addEventListener("click", () => { if (!this.submitting) this.dialog.close(); });
    this.dialog.addEventListener("cancel", (event) => {
      event.stopPropagation();
      if (this.submitting) event.preventDefault();
    });
    this.dialog.addEventListener("keydown", (event) => { if (event.key === "Escape") event.stopPropagation(); });
    this.dialog.addEventListener("close", () => {
      const targetId = this.selected?.id;
      const trigger = this.trigger?.isConnected ? this.trigger
        : [...document.querySelectorAll<HTMLButtonElement>("[data-session-id]")].find((row) => row.dataset.sessionId === targetId);
      this.selected = undefined;
      this.action = undefined;
      if (trigger) trigger.focus({ preventScroll: true });
      this.trigger = undefined;
    });
    this.input.addEventListener("input", () => {
      this.error.hidden = true;
      this.input.removeAttribute("aria-invalid");
    });
    this.form.addEventListener("submit", (event) => { event.preventDefault(); void this.save(); });
  }

  open(action: SessionMutation, session: SessionSummary): void {
    if (this.dialog.open || !this.canManage()) return;
    this.action = action;
    this.selected = structuredClone(session);
    this.trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const name = session.name ?? session.title;
    this.title.textContent = action === "rename" ? "Rename session" : action === "fork" ? "Fork session" : "Delete session";
    this.description.textContent = action === "rename" ? `Choose a name for "${name}".`
      : action === "fork" ? `Create a copy of "${name}" and open it as a new session.`
      : `Delete "${name}" and its saved conversation? This cannot be undone. Files and commands stay in effect.`;
    this.field.hidden = action === "delete";
    this.input.value = action === "rename" ? name : "";
    this.input.placeholder = action === "fork" ? "Optional name; leave blank to use the default" : "Session name";
    this.input.required = action === "rename";
    this.input.removeAttribute("aria-invalid");
    this.error.textContent = "";
    this.error.hidden = true;
    this.submit.dataset.action = action;
    this.submit.classList.toggle("danger", action === "delete");
    this.update();
    this.dialog.showModal();
    if (action === "delete") this.cancel.focus();
    else { this.input.focus(); this.input.select(); }
  }

  update(): void {
    const focused = document.activeElement;
    this.input.disabled = this.submitting;
    this.cancel.disabled = this.submitting;
    this.submit.disabled = this.submitting || !this.canManage();
    this.submit.textContent = this.submitting
      ? this.action === "rename" ? "Saving…" : this.action === "fork" ? "Creating…" : "Deleting…"
      : this.action === "rename" ? "Save name" : this.action === "fork" ? "Fork session" : "Delete session";
    this.status.hidden = this.submitting || this.canManage();
    this.status.textContent = this.status.hidden ? "" : "Session changes are unavailable while disconnected or another operation is running.";
    if (this.dialog.open && !this.submitting && this.submit.disabled && focused === this.submit) {
      this.cancel.focus({ preventScroll: true });
    }
  }

  private async save(): Promise<void> {
    const action = this.action;
    const session = this.selected;
    if (!action || !session || this.submitting || !this.canManage()) return;
    const name = this.input.value.trim();
    if (action !== "delete" && ((action === "rename" && !name) || name.length > 120 || /[\x00-\x1f\x7f]/.test(name))) {
      this.error.textContent = "Use a non-empty session name of at most 120 characters without control characters.";
      this.error.hidden = false;
      this.input.setAttribute("aria-invalid", "true");
      this.input.focus();
      return;
    }
    this.submitting = true;
    this.error.hidden = true;
    this.update();
    try {
      const failure = await this.onSubmit(action, session, action === "delete" || !name ? undefined : name);
      if (failure === undefined) this.dialog.close();
      else { this.error.textContent = failure; this.error.hidden = false; }
    } catch (error) {
      this.error.textContent = error instanceof Error ? error.message : "The session operation failed. Try again.";
      this.error.hidden = false;
    } finally {
      this.submitting = false;
      this.update();
    }
  }
}
