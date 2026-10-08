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
  private readonly valueLabel = el("span", "Interval (minutes)");
  private readonly runs = el("input");
  private readonly hours = el("input");
  private readonly note = el("p");
  private readonly error = el("p");
  private readonly create = el("button", "Create task");
  private readonly newTab = el("button", "New task");
  private readonly scheduledTab = el("button", "Scheduled tasks");
  private state: WebUiState | undefined;
  private pending = false;
  private disabled = false;
  private page = 0;
  private selectedTaskId: string | undefined;
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
    this.note.className = "cron-note";
    this.error.className = "session-dialog-error"; this.error.setAttribute("role", "alert");
    const intro = el("p", "Schedule a task. Each run continues its linked conversation.");
    intro.className = "cron-intro";
    let fieldIndex = 0;
    const field = (text: string | HTMLElement, input: HTMLElement) => {
      const label = el("label");
      const caption = typeof text === "string" ? el("span", text) : text;
      caption.id = `cron-field-${++fieldIndex}`;
      input.setAttribute("aria-labelledby", caption.id);
      label.append(caption, input); return label;
    };
    this.session.setAttribute("aria-label", "Linked session");
    this.prompt.required = true; this.prompt.maxLength = 16000; this.prompt.rows = 2;
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
      this.valueLabel.textContent = this.kind.value === "interval" ? "Interval (minutes)"
        : this.kind.value === "cron" ? "Cron (local time)"
        : this.kind.value === "at" ? "Date & time (local)" : "Files (comma-separated)";
      this.value.placeholder = this.kind.value === "file_changed" ? "src/cli.ts, README.md" : "";
      this.value.title = this.kind.value === "cron" ? "Five-field cron, in the machine's local timezone."
        : this.kind.value === "at" ? "Date and time in your browser's timezone."
        : this.kind.value === "file_changed" ? "Workspace-relative text file paths, separated by commas." : "At least one minute.";
    };
    const schedule = el("div"); schedule.className = "cron-fields";
    schedule.append(field("Trigger", this.kind), field(this.valueLabel, this.value));
    const limits = el("div"); limits.className = "cron-limits";
    limits.append(field("Maximum runs", this.runs), field("Expires after (hours)", this.hours));
    const footer = el("div"); footer.className = "cron-form-footer"; footer.append(this.error, this.create);
    this.form.append(el("h3", "New task"), field("Linked session", this.session), field("Task instructions", this.prompt),
      schedule, limits, footer);
    this.form.id = "cron-new-task";
    this.create.type = "submit"; this.create.className = "session-dialog-submit";
    this.form.onsubmit = (event) => { event.preventDefault(); void this.submit(); };
    this.list.className = "cron-list";
    this.list.id = "cron-scheduled-tasks";
    const tabs = el("div"); tabs.className = "cron-tabs"; tabs.setAttribute("aria-label", "Cron views");
    for (const [button, view, panel] of [[this.newTab, "new", this.form], [this.scheduledTab, "scheduled", this.list]] as const) {
      button.type = "button"; button.setAttribute("aria-controls", panel.id);
      button.onclick = () => this.selectView(view);
      tabs.append(button);
    }
    const body = el("div"); body.className = "cron-body";
    body.append(this.list, this.form);
    this.dialog.append(heading, intro, tabs, body, this.note);
    this.selectView("new");
    document.body.append(this.dialog);
    const entry = document.getElementById("show-cron") as HTMLButtonElement;
    entry.onclick = () => {
      if (!this.state) return;
      this.error.textContent = "";
      this.session.value = this.state.current.revision > 0 ? this.state.current.id : "";
      this.selectView("new");
      this.dialog.showModal();
    };
  }

  update(state: WebUiState, disabled: boolean): void {
    this.state = state;
    this.disabled = disabled;
    (document.getElementById("show-cron") as HTMLButtonElement).disabled = false;
    this.note.textContent = state.automationNotice || (state.runningSessionId ? `Running in session ${state.runningSessionId}` : "Keep Fatcat open. Tasks use current permissions; missed offline runs are skipped.");
    this.scheduledTab.textContent = `Scheduled (${state.automations.length})`;
    const signature = JSON.stringify([state.automations, state.sessions, state.current.id, state.current.revision === 0]);
    if (signature !== this.signature) {
      this.signature = signature;
      const selected = this.session.value;
      this.session.replaceChildren(new Option("Create a new session", ""));
      const sessions = state.sessions.some((item) => item.id === state.current.id) ? state.sessions : [state.current, ...state.sessions];
      for (const item of sessions) this.session.add(new Option(item.name ?? item.title, item.id));
      this.session.value = [...this.session.options].some((option) => option.value === selected) ? selected : "";
      this.renderTasks(true);
    }
    this.updateControls();
  }

  private selectView(view: "new" | "scheduled"): void {
    this.dialog.dataset.view = view;
    this.newTab.setAttribute("aria-pressed", String(view === "new"));
    this.scheduledTab.setAttribute("aria-pressed", String(view === "scheduled"));
  }

  private renderTasks(preserveSelection = false): void {
    if (!this.state) return;
    const tasks = this.state.automations;
    const selected = preserveSelection ? tasks.findIndex((task) => task.id === this.selectedTaskId) : -1;
    this.page = selected >= 0 ? selected : Math.min(this.page, Math.max(0, tasks.length - 1));
    this.list.replaceChildren(el("h3", `Scheduled tasks · ${tasks.length}`));
    if (!tasks.length) {
      const empty = el("div"); empty.className = "cron-empty";
      empty.append(icon("clock"), el("strong", "No tasks yet"), el("p", "Your scheduled tasks will appear here."));
      this.list.append(empty);
    }
    const task = tasks[this.page];
    this.selectedTaskId = task?.id;
    if (task) {
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
      const instructions = el("p", task.prompt); instructions.className = "cron-task-prompt"; instructions.title = task.prompt;
      link.title = task.sessionTitle; detail.title = detail.textContent ?? ""; expiry.title = expiry.textContent ?? "";
      card.append(link, instructions, detail, expiry, actions); this.list.append(card);
    }
    if (tasks.length > 1) {
      const pager = el("nav"); pager.className = "cron-pagination"; pager.setAttribute("aria-label", "Scheduled task pages");
      const previous = el("button", "Previous"); previous.type = "button";
      const next = el("button", "Next"); next.type = "button";
      previous.dataset.inactive = String(this.page === 0); next.dataset.inactive = String(this.page === tasks.length - 1);
      previous.onclick = () => { this.page--; this.renderTasks(); this.updateControls(); };
      next.onclick = () => { this.page++; this.renderTasks(); this.updateControls(); };
      const position = el("span", `${this.page + 1} / ${tasks.length}`); position.setAttribute("aria-live", "polite");
      pager.append(previous, position, next); this.list.append(pager);
    }
  }

  private updateControls(): void {
    for (const input of this.dialog.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>("form input, form select, form textarea, form button, .cron-list button")) {
      input.disabled = this.disabled || this.pending || input.dataset.inactive === "true";
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
