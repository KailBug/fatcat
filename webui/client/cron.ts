import type { WebUiState } from "../controller.js";
import type { Trigger } from "../../src/automation/config.js";
import { icon } from "./icons.js";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Task creation and management; the server owns validation, bindings and execution. */
export class CronPanel {
  private readonly dialog = el("dialog");
  private readonly list = el("div");
  private readonly form = el("form");
  private readonly session = el("select");
  private readonly prompt = el("textarea");
  private readonly kind = el("select");
  private readonly value = el("input");
  private readonly valueLabel = el("span", "Interval in minutes");
  private readonly runs = el("input");
  private readonly hours = el("input");
  private readonly note = el("p");
  private readonly error = el("p");
  private readonly create = el("button", "Create task");
  private state: WebUiState | undefined;
  private pending = false;
  private signature = "";

  constructor(private readonly api: (path: string, body: unknown) => Promise<boolean>) {
    this.dialog.className = "cron-dialog";
    this.dialog.setAttribute("aria-labelledby", "cron-heading");
    const heading = el("div"); heading.className = "dialog-heading";
    const title = el("h2", "Cron tasks"); title.id = "cron-heading";
    const close = el("button"); close.type = "button"; close.className = "icon-button";
    close.setAttribute("aria-label", "Close Cron tasks"); close.append(icon("x"));
    close.onclick = () => this.dialog.close();
    heading.append(title, close);
    this.note.className = "dialog-note";
    this.error.className = "session-dialog-error"; this.error.setAttribute("role", "alert");
    const intro = el("p", "Create a task here, or describe a schedule in any chat. Each run continues its linked conversation. Keep Fatcat open for tasks to run.");
    intro.className = "dialog-note";
    let fieldIndex = 0;
    const field = (text: string | HTMLElement, input: HTMLElement) => {
      const label = el("label");
      const caption = typeof text === "string" ? el("span", text) : text;
      caption.id = `cron-field-${++fieldIndex}`;
      input.setAttribute("aria-labelledby", caption.id);
      label.append(caption, input); return label;
    };
    this.session.setAttribute("aria-label", "Linked session");
    this.prompt.required = true; this.prompt.maxLength = 16000; this.prompt.rows = 3;
    this.prompt.placeholder = "What should Fatcat do each time?";
    for (const [value, label] of [["interval", "Every interval"], ["cron", "Cron schedule"], ["at", "Once at a time"], ["file_changed", "When files change"]]) {
      this.kind.add(new Option(label, value));
    }
    this.value.required = true; this.value.value = "5"; this.value.type = "number"; this.value.min = "1";
    this.runs.type = "number"; this.runs.min = "1"; this.runs.max = "1000"; this.runs.value = "20"; this.runs.required = true;
    this.hours.type = "number"; this.hours.min = "1"; this.hours.max = "168"; this.hours.value = "24"; this.hours.required = true;
    this.kind.onchange = () => {
      this.value.type = this.kind.value === "interval" ? "number" : this.kind.value === "at" ? "datetime-local" : "text";
      this.value.step = this.kind.value === "at" ? "1" : "any";
      this.value.value = this.kind.value === "interval" ? "5" : this.kind.value === "cron" ? "0 9 * * 1-5" : "";
      this.valueLabel.textContent = this.kind.value === "interval" ? "Interval in minutes (at least 1)"
        : this.kind.value === "cron" ? "Five-field cron (machine local time)"
        : this.kind.value === "at" ? "Date and time (your browser's timezone)" : "Workspace text files (comma-separated)";
      this.value.placeholder = this.kind.value === "file_changed" ? "src/cli.ts, README.md" : "";
    };
    const limits = el("div"); limits.className = "cron-limits";
    limits.append(field("Maximum runs", this.runs), field("Expires after hours", this.hours));
    this.form.append(el("h3", "New task"), field("Linked session", this.session), field("Task instructions", this.prompt),
      field("Trigger", this.kind), field(this.valueLabel, this.value), limits, this.error, this.create);
    this.create.type = "submit"; this.create.className = "session-dialog-submit";
    this.form.onsubmit = (event) => { event.preventDefault(); void this.submit(); };
    this.list.className = "cron-list";
    const body = el("div"); body.className = "cron-body";
    body.append(intro, this.note, this.list, this.form);
    this.dialog.append(heading, body);
    document.body.append(this.dialog);
    const entry = document.getElementById("show-cron") as HTMLButtonElement;
    entry.onclick = () => {
      if (!this.state) return;
      this.error.textContent = "";
      this.session.value = this.state.current.revision > 0 ? this.state.current.id : "";
      this.dialog.showModal();
    };
  }

  update(state: WebUiState, disabled: boolean): void {
    this.state = state;
    (document.getElementById("show-cron") as HTMLButtonElement).disabled = false;
    this.note.textContent = state.automationNotice || (state.runningSessionId ? `Running in session ${state.runningSessionId}` : "Tasks use current permissions. Missed offline runs are not replayed.");
    const signature = JSON.stringify([state.automations, state.sessions, state.current.id, state.current.revision === 0]);
    if (signature !== this.signature) {
      this.signature = signature;
      const selected = this.session.value;
      this.session.replaceChildren(new Option("Create a new session", ""));
      const sessions = state.sessions.some((item) => item.id === state.current.id) ? state.sessions : [state.current, ...state.sessions];
      for (const item of sessions) this.session.add(new Option(item.name ?? item.title, item.id));
      this.session.value = [...this.session.options].some((option) => option.value === selected) ? selected : "";
      this.list.replaceChildren(el("h3", "Scheduled tasks"));
      if (!state.automations.length) this.list.append(el("p", "No scheduled tasks yet."));
      for (const task of state.automations) {
        const card = el("article"); card.className = "cron-task";
        const link = el("button", task.sessionTitle); link.type = "button"; link.className = "cron-session-link";
        link.onclick = () => { void this.api("session/resume", { id: task.sessionId }).then((ok) => { if (ok) this.dialog.close(); }); };
        const inactive = task.runs >= task.maxRuns || task.expiresAt <= Date.now() || (task.trigger.type === "at" && task.runs > 0);
        const status = inactive ? "Finished" : task.lastStatus === "running" ? "Running / interrupted" : task.enabled ? "Enabled" : "Paused";
        const description = task.trigger.type === "cron" ? `${task.trigger.expression} · ${task.trigger.timezone}`
          : task.trigger.type === "interval" ? `Every ${task.trigger.seconds / 60} minutes`
          : task.trigger.type === "at" ? new Date(task.trigger.time).toLocaleString() : `Files: ${task.trigger.paths.join(", ")}`;
        const detail = el("p", `${description} · ${status} · ${task.runs}/${task.maxRuns} runs`); detail.className = "cron-detail";
        const expiry = el("p", `Expires ${new Date(task.expiresAt).toLocaleString()}${task.lastStatus ? ` · Last run: ${task.lastStatus}` : ""}`); expiry.className = "cron-detail";
        const actions = el("div"); actions.className = "cron-actions";
        for (const action of [task.enabled && task.lastStatus !== "running" ? "pause" : "resume", "delete"] as const) {
          const button = el("button", action === "delete" ? "Delete" : action === "pause" ? "Pause" : "Resume");
          button.type = "button"; button.dataset.inactive = String(inactive && action !== "delete");
          button.onclick = () => { void this.api("automation/manage", { sessionId: task.sessionId, id: task.id, action }); };
          actions.append(button);
        }
        card.append(link, el("p", task.prompt), detail, expiry, actions); this.list.append(card);
      }
    }
    for (const input of this.dialog.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("form input, form select, form textarea, form button, .cron-list button")) {
      input.disabled = disabled || this.pending || input.dataset.inactive === "true";
    }
  }

  private async submit(): Promise<void> {
    if (this.pending || !this.state || this.state.busy) return;
    this.error.textContent = "";
    try {
      let trigger: Trigger;
      if (this.kind.value === "interval") trigger = { type: "interval", seconds: Number(this.value.value) * 60 };
      else if (this.kind.value === "cron") trigger = { type: "cron", expression: this.value.value, timezone: "local" };
      else if (this.kind.value === "at") trigger = { type: "at", time: new Date(this.value.value).toISOString() };
      else trigger = { type: "file_changed", paths: this.value.value.split(/[\n,]/).map((path) => path.trim()).filter(Boolean), debounceMs: 1000 };
      this.pending = true; this.update(this.state, true);
      const ok = await this.api("automation/create", { task: { prompt: this.prompt.value, trigger,
        maxRuns: Number(this.runs.value), maxRuntimeSeconds: Number(this.hours.value) * 3600 },
        ...(this.session.value ? { sessionId: this.session.value } : {}) });
      if (ok) this.prompt.value = "";
      else this.error.textContent = document.getElementById("notice")?.textContent || "Task creation failed.";
    } catch { this.error.textContent = "Check the task instructions, time and limits."; }
    finally { this.pending = false; if (this.state) this.update(this.state, this.state.busy); }
  }
}
