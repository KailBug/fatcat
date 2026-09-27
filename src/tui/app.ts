import { Container, Editor, ProcessTerminal, TuiAltScreen, isKeyRelease, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { Terminal } from "@earendil-works/pi-tui";
import { HarnessError, checkCancellation, formatError } from "../errors.js";
import { createTurnReporter } from "../execution-report.js";
import type { ReportEvent } from "../execution-report.js";
import type { Session } from "../session.js";
import type { ApproveWrite } from "../tools/write.js";
import type { ApproveShell } from "../tools/shell.js";
import { metricSections, statusText } from "./metrics.js";
import type { TuiConfig } from "./metrics.js";
import { createTuiTelemetry } from "./telemetry.js";
import { createTuiTheme } from "./theme.js";
import { FatcatView } from "./view.js";
import type { TuiViewState } from "./view.js";

const help = [
  "/help    Show this guide", "/status  Show full configuration and metric definitions",
  "/reset   Clear conversation history; keep consumed usage and execution facts", "/exit    Close Fatcat",
  "Enter sends. Alt+Enter inserts a newline. Up/Down recall prompts. PageUp/PageDown scroll.",
  "Escape or Ctrl+C cancels a running turn. Ctrl+C at idle exits. Ctrl+D exits after cancellation.",
  "Approvals require a fresh yes or no. Pasted text is never submitted automatically.",
  "Responses appear when a model request completes; token streaming is not enabled.",
].join("\n");

type Options = TuiConfig & { terminal?: Terminal; warnings?: readonly string[]; color?: boolean; signal?: AbortSignal };

/** Route application keys before the toolkit consumes its own fullscreen shortcuts. */
function routeInput(terminal: Terminal, consume: (data: string) => boolean): Terminal {
  return {
    start: (onInput, onResize) => terminal.start((data) => { if (!consume(data)) onInput(data); }, onResize),
    stop: () => terminal.stop(),
    drainInput: (maxMs, idleMs) => terminal.drainInput(maxMs, idleMs),
    write: (data) => terminal.write(data),
    get columns() { return terminal.columns; },
    get rows() { return terminal.rows; },
    get kittyProtocolActive() { return terminal.kittyProtocolActive; },
    moveBy: (lines) => terminal.moveBy(lines),
    hideCursor: () => terminal.hideCursor(),
    showCursor: () => terminal.showCursor(),
    clearLine: () => terminal.clearLine(),
    clearFromCursor: () => terminal.clearFromCursor(),
    clearScreen: () => terminal.clearScreen(),
    setTitle: (title) => terminal.setTitle(title),
    setProgress: (active) => terminal.setProgress(active),
  };
}

/** Owns terminal input and approval routing. The Session still owns model history. */
export class TuiApp {
  readonly telemetry = createTuiTelemetry();
  private readonly terminal: Terminal;
  private readonly tui: TuiAltScreen;
  private readonly editor: Editor;
  private readonly view: FatcatView;
  private readonly state: TuiViewState;
  private session?: Session;
  private turnController: AbortController | undefined;
  private activeTurn?: Promise<void>;
  private approval: { finish: (allowed: boolean) => void; draft: string } | undefined;
  private resolveExit?: (code: number) => void;
  private closing = false;
  private started = false;
  private failed = false;
  private startedAt = 0;
  private activity = "Ready";
  private timer?: ReturnType<typeof setInterval>;
  private readonly observedWrites = new Map<string, string>();
  private readonly observedCommands = new Set<string>();

  constructor(private readonly options: Options) {
    this.terminal = routeInput(options.terminal ?? new ProcessTerminal(), (data) => this.handleShortcut(data));
    this.tui = new TuiAltScreen(this.terminal, true, undefined, { mouse: false });
    const color = options.color ?? process.env.NO_COLOR === undefined;
    this.editor = new Editor(this.tui, createTuiTheme(color).editor, { paddingX: 1 });
    this.state = {
      model: options.config.model, provider: options.config.provider,
      workspace: options.workspace ?? "No workspace selected", status: "Ready", busy: false,
      messages: [], sections: [], color,
      footer: `write ${options.workspace === undefined ? "off" : options.permission} | shell ${options.shellPermission} | skills ${options.skills}`,
    };
    this.view = new FatcatView(this.state, this.terminal.rows - 4);
    const layout = new Container();
    layout.addChild(this.view);
    layout.addChild(this.editor);
    layout.render = (width) => {
      const editorLines = this.editor.render(Math.max(1, width));
      this.view.height = Math.max(1, this.terminal.rows - editorLines.length - 1);
      const hint = this.approval ? " APPROVAL > Type yes or no, then Enter | Esc cancels | PgUp reviews details"
        : this.state.busy ? " Working | Esc cancel | draft your next prompt | PgUp/PgDn scroll"
        : " Enter send  Alt+Enter newline  /help  /status  /reset  Ctrl+C exit  PgUp/PgDn scroll";
      return [...this.view.render(width), ...editorLines, truncateToWidth(hint, width)].slice(-this.terminal.rows);
    };
    this.tui.setLayoutRoot(layout);
    this.tui.setFocus(this.editor);
    this.editor.onSubmit = (value) => this.submit(value);
    for (const warning of options.warnings ?? []) this.message("system", warning, "SKILL WARNING");
  }

  private handleShortcut(data: string): boolean {
    // A release can arrive after cancellation settles; it must not become an idle exit.
    if (isKeyRelease(data)) return true;
    // Keep the toolkit's search overlay in charge of its own navigation and dismissal.
    if (this.tui.hasOverlay()) return false;
    if (matchesKey(data, "ctrl+c") || matchesKey(data, "escape")) {
      if (this.turnController) this.cancelTurn();
      else if (matchesKey(data, "ctrl+c")) this.exit();
      return true;
    }
    if (matchesKey(data, "ctrl+d")) { this.exit(); return true; }
    if (matchesKey(data, "pageUp") || matchesKey(data, "pageDown")) {
      const delta = matchesKey(data, "pageUp") ? 10 : -10;
      this.state.scrollOffset = Math.min(this.view.maxScrollOffset, Math.max(0, (this.state.scrollOffset ?? 0) + delta));
      this.refresh();
      return true;
    }
    return false;
  }

  async run(session: Session): Promise<number> {
    if (this.started) throw new HarnessError("SESSION_BUSY", "This TUI has already started.");
    this.started = true;
    this.session = session;
    const interrupt = () => { if (this.turnController) this.cancelTurn(); else this.exit(); };
    const terminate = () => this.exit();
    const eof = () => this.exit();
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    process.stdin.on("end", eof);
    this.options.signal?.addEventListener("abort", terminate, { once: true });
    try {
      checkCancellation(this.options.signal);
      const done = new Promise<number>((resolve) => { this.resolveExit = resolve; });
      this.tui.start();
      this.timer = setInterval(() => { if (this.state.busy) this.refresh(); }, 1000);
      this.refresh();
      return await done;
    } finally {
      this.closing = true;
      this.turnController?.abort();
      this.approval?.finish(false);
      try {
        await this.activeTurn;
      } finally {
        clearInterval(this.timer);
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", terminate);
        process.stdin.off("end", eof);
        this.options.signal?.removeEventListener("abort", terminate);
        try {
          await this.terminal.drainInput(100, 25);
        } finally {
          this.tui.stop();
        }
      }
    }
  }

  readonly approveWrite: ApproveWrite = (request, signal) => this.confirm("WRITE APPROVAL", [
    `${request.operation} ${JSON.stringify(request.path)} (${request.bytes} bytes after write)`,
    ...(request.oldText === undefined ? [] : [`Replace: ${this.preview(request.oldText)}`]),
    `${request.operation === "create" ? "Content" : "With"}: ${this.preview(request.newText)}`,
  ].join("\n"), signal);

  readonly approveShell: ApproveShell = (request, signal) => this.confirm("COMMAND APPROVAL", [
    `Workspace: ${this.options.workspace ?? "disabled"}`, `Relative directory: ${JSON.stringify(request.cwd)}`,
    `Timeout: ${request.timeoutMs} ms`, "PowerShell runs with your user permissions, including outside the workspace and on the network.",
    `Command: ${JSON.stringify(request.command)}`,
  ].join("\n"), signal);

  private preview(value: string): string {
    const escaped = JSON.stringify(value);
    return escaped.length <= 4000 ? escaped : `${escaped.slice(0, 4000)} ... [preview truncated]`;
  }

  private async confirm(label: string, details: string, signal?: AbortSignal): Promise<boolean> {
    checkCancellation(signal);
    if (!this.started || this.closing || !this.turnController || this.approval) {
      throw new HarnessError("PERMISSION_DENIED", "Approval requires an active TUI turn with no other approval pending.");
    }
    const waiting = signal ? AbortSignal.any([signal, this.turnController.signal]) : this.turnController.signal;
    checkCancellation(waiting);
    const allowed = await new Promise<boolean>((resolve) => {
      const draft = this.editor.getExpandedText();
      const finish = (answer: boolean) => {
        waiting.removeEventListener("abort", abort);
        this.approval = undefined;
        this.editor.setText(draft);
        this.editor.disableSubmit = true;
        this.message("system", answer ? "Approved." : "Denied.", label);
        resolve(answer);
      };
      const abort = () => finish(false);
      this.approval = { finish, draft };
      this.editor.setText("");
      this.editor.disableSubmit = false;
      waiting.addEventListener("abort", abort, { once: true });
      this.message("system", details, label);
      this.activity = "Approval required";
      this.refresh();
    });
    checkCancellation(waiting);
    this.activity = "Running tool";
    this.refresh();
    return allowed;
  }

  private submit(value: string): void {
    if (this.closing) return;
    const prompt = value.trim();
    if (this.approval) {
      const answer = prompt.toLowerCase();
      if (answer === "yes" || answer === "no") this.approval.finish(answer === "yes");
      else {
        this.editor.setText("");
        this.message("system", "Type yes or no to answer this approval request.");
      }
      return;
    }
    if (this.turnController || !prompt || !this.session) return;
    this.editor.setText("");
    if (prompt === "/exit") { this.exit(); return; }
    if (prompt === "/help") { this.message("system", help, "HELP"); return; }
    if (prompt === "/status") { this.message("system", statusText(this.telemetry.snapshot(), this.options), "STATUS"); return; }
    if (prompt === "/reset") {
      this.session.reset();
      this.telemetry.resetConversation();
      this.state.messages = [];
      this.activity = "Ready";
      this.message("system", "Conversation cleared. Usage and workspace execution facts are retained; files are not rolled back.");
      return;
    }
    if (prompt.startsWith("/")) { this.message("system", "Unknown command. Use /help."); return; }
    this.editor.addToHistory(prompt);
    this.turnController = new AbortController();
    this.editor.disableSubmit = true;
    this.state.busy = true;
    this.startedAt = Date.now();
    this.observedWrites.clear();
    this.observedCommands.clear();
    this.telemetry.beginTurn();
    this.message("user", prompt);
    this.activeTurn = this.runTurn(prompt, this.turnController.signal);
  }

  private async runTurn(prompt: string, signal: AbortSignal): Promise<void> {
    try {
      const answer = await this.session!.run(prompt, {
        signal, onEvent: createTurnReporter((event) => this.observe(event)),
      });
      this.telemetry.finishTurn("answered");
      this.message("assistant", answer);
      this.activity = "Answered";
    } catch (cause) {
      this.failed = true;
      const code = cause instanceof HarnessError ? cause.code : "INTERNAL";
      this.telemetry.finishTurn("stopped", code);
      this.message("error", formatError(cause));
      this.activity = code === "CANCELLED" ? "Cancelled; ready for another prompt" : "Stopped; ready for another prompt";
    } finally {
      this.turnController = undefined;
      this.state.busy = false;
      this.editor.disableSubmit = false;
      this.refresh();
      if (this.closing) this.resolveExit?.(this.failed ? 1 : 0);
    }
  }

  private observe(event: ReportEvent): void {
    this.telemetry.observe(event);
    const child = event.type === "subagent_event";
    const detail = child ? event.event : event;
    const prefix = child ? "Child" : "Agent";
    if (detail.type === "model_request") this.activity = `${prefix} request ${detail.iteration}`;
    if (detail.type === "model_usage") this.activity = `${prefix} processing response`;
    if (detail.type === "tool_result") this.message("tool", `${detail.tool}: ${detail.ok ? "OK" : "error"}`, prefix);
    if (detail.type === "write_record") {
      const fingerprint = JSON.stringify(detail.record);
      if (this.observedWrites.get(detail.record.id) !== fingerprint) {
        this.observedWrites.set(detail.record.id, fingerprint);
        this.message("tool", `${detail.record.operation} ${detail.record.path}: ${detail.record.status}`, "WRITE");
      }
    }
    if (detail.type === "shell_record" && !this.observedCommands.has(detail.record.id)) {
      this.observedCommands.add(detail.record.id);
      this.message("tool", `Command ${detail.record.status}; exit ${detail.record.exitCode ?? "N/A"}; ${detail.record.durationMs} ms`, "SHELL");
    }
    if (event.type === "execution_report") {
      const report = event.report;
      this.message("system", `${report.outcome}; ${report.modelRequests.parent} parent + ${report.modelRequests.children} child requests; `
        + `${report.writes.length} writes, ${report.commands.length} commands. Task verification: not assessed.`, "TURN REPORT");
      for (const command of report.commands) {
        if (command.laterWriteAttempt) this.message("system", "A write was attempted after a command. Earlier checks may be stale.", "EVIDENCE");
      }
    }
    this.refresh();
  }

  private message(role: TuiViewState["messages"][number]["role"], text: string, label?: string): void {
    this.state.messages.push({ role, text, ...(label ? { label } : {}) });
    this.state.scrollOffset = 0;
    this.refresh();
  }

  private refresh(): void {
    const elapsed = this.state.busy ? ` | ${Math.floor((Date.now() - this.startedAt) / 1000)}s` : "";
    this.state.status = this.activity + elapsed;
    this.state.sections = metricSections(this.telemetry.snapshot(), this.options);
    if (this.started && !this.closing) this.tui.requestRender();
  }

  private cancelTurn(): void {
    this.activity = "Cancelling";
    this.turnController?.abort();
    this.refresh();
  }

  private exit(): void {
    this.closing = true;
    this.turnController?.abort();
    this.approval?.finish(false);
    if (!this.turnController) this.resolveExit?.(this.failed ? 1 : 0);
  }
}
