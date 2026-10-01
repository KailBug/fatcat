import { randomUUID } from "node:crypto";
import { HarnessError, formatError } from "../src/errors.js";
import { createTurnReporter } from "../src/execution-report.js";
import type { ExecutionReport, ReportEvent } from "../src/execution-report.js";
import type { Message } from "../src/model.js";
import type { SessionManager } from "../src/session/manager.js";
import type { SessionSummary } from "../src/session/store.js";
import type { ShellRequest } from "../src/tools/shell.js";
import type { WriteApprovalRequest } from "../src/tools/write.js";

export type WebUiInfo = {
  provider: string; model: string; workspace: string;
  permission: string; shellPermission: string; webPermission: string;
  maxIterations: number; maxRequestBytes: number; skills: number; warnings: string[];
};
export type Approval = { id: string } & (
  { kind: "write"; request: WriteApprovalRequest } | { kind: "shell"; request: ShellRequest }
);
export type WebTurn = {
  id: string; prompt: string; answer?: string; error?: string;
  status: "running" | "answered" | "stopped";
  activity: string[]; report?: ExecutionReport;
};
export type WebUiState = {
  revision: number; info: WebUiInfo; turns: WebTurn[]; busy: boolean;
  approval: Approval | null; status: string;
  current: SessionSummary; sessions: SessionSummary[]; persistent: boolean;
};

/** Browser tabs share one selected session, active turn and pending approval. */
export class WebUiController {
  private turns: WebTurn[] = [];
  private revision = 0;
  private active: { abort: AbortController; done: Promise<void> } | undefined;
  private pending: { approval: Approval; finish: (allowed: boolean) => void } | undefined;
  private status = "Ready";
  private closed = false;
  private changing: Promise<void> | undefined;
  private sessions: SessionSummary[] = [];

  private constructor(readonly info: WebUiInfo, private readonly session: SessionManager) {}

  static async create(info: WebUiInfo, session: SessionManager): Promise<WebUiController> {
    const controller = new WebUiController(info, session);
    controller.turns = restoredTurns(session.history, session.current.id);
    controller.sessions = await session.list();
    return controller;
  }

  snapshot(): WebUiState {
    return structuredClone({ revision: this.revision, info: this.info, turns: this.turns,
      busy: Boolean(this.active || this.changing), approval: this.pending?.approval ?? null, status: this.status,
      current: this.session.current, sessions: this.sessions, persistent: this.session.persistent });
  }

  submit(prompt: string): void {
    this.requireIdle();
    if (!prompt.trim() || Buffer.byteLength(prompt) > 32_768) {
      throw new HarnessError("INPUT", "Enter a message of at most 32768 UTF-8 bytes.");
    }
    if (this.turns.length >= 100) throw new HarnessError("INPUT", "Start a new chat after 100 turns.");
    const turn: WebTurn = { id: randomUUID(), prompt, status: "running", activity: [] };
    this.turns.push(turn);
    this.status = "Working";
    const abort = new AbortController();
    // Install active state before the session can emit events or request approval.
    const done = Promise.resolve().then(async () => {
      try {
        turn.answer = await this.session.run(prompt, { signal: abort.signal,
          onEvent: createTurnReporter((event) => this.observe(turn, event)) });
        turn.status = "answered";
        this.status = "Ready";
      } catch (error) {
        turn.error = formatError(error);
        turn.status = "stopped";
        this.status = abort.signal.aborted ? "Stopped" : "Turn failed";
      } finally {
        this.pending?.finish(false);
        try { this.sessions = await this.session.list(); }
        catch { this.status = "Session list could not be refreshed"; }
        this.active = undefined;
        this.revision++;
      }
    });
    this.active = { abort, done };
    this.revision++;
  }

  reset(): Promise<void> { return this.newSession(); }

  newSession(name?: string): Promise<void> {
    return this.changeSession(() => this.session.newSession(name));
  }

  resume(selector: string): Promise<void> {
    return this.changeSession(() => this.session.resume(selector));
  }

  rename(name: string): Promise<void> {
    return this.changeSession(() => this.session.rename(name), false);
  }

  fork(name?: string): Promise<void> {
    return this.changeSession(() => this.session.fork(name));
  }

  private changeSession(change: () => Promise<unknown>, restore = true): Promise<void> {
    this.requireIdle();
    this.status = "Loading session";
    const done = Promise.resolve().then(async () => {
      try {
        await change();
        if (restore) this.turns = restoredTurns(this.session.history, this.session.current.id);
        this.sessions = await this.session.list();
        this.status = "Ready";
      } catch (error) {
        this.status = "Session change failed";
        throw error;
      } finally {
        this.changing = undefined;
        this.revision++;
      }
    });
    this.changing = done;
    this.revision++;
    return done;
  }

  stop(): void {
    this.active?.abort.abort();
    this.pending?.finish(false);
    if (this.active) this.status = "Stopping";
    this.revision++;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stop();
    await Promise.allSettled([this.active?.done, this.changing]);
  }

  approve(id: string, allowed: boolean): void {
    if (this.pending?.approval.id !== id) throw new HarnessError("STALE_APPROVAL", "This approval is no longer pending.");
    this.pending.finish(allowed);
  }

  requestApproval(kind: "write", request: WriteApprovalRequest, signal?: AbortSignal): Promise<boolean>;
  requestApproval(kind: "shell", request: ShellRequest, signal?: AbortSignal): Promise<boolean>;
  requestApproval(kind: "write" | "shell", request: WriteApprovalRequest | ShellRequest, signal?: AbortSignal): Promise<boolean> {
    if (this.closed || !this.active || signal?.aborted || this.active.abort.signal.aborted) return Promise.resolve(false);
    if (this.pending) throw new HarnessError("APPROVAL_BUSY", "Another operation is awaiting approval.");
    return new Promise((resolve) => {
      const activeSignal = this.active!.abort.signal;
      const cancel = () => finish(false);
      const finish = (allowed: boolean) => {
        signal?.removeEventListener("abort", cancel);
        activeSignal.removeEventListener("abort", cancel);
        this.pending = undefined;
        this.status = "Working";
        this.revision++;
        resolve(allowed);
      };
      this.pending = { approval: structuredClone({ id: randomUUID(), kind, request }) as Approval, finish };
      signal?.addEventListener("abort", cancel, { once: true });
      activeSignal.addEventListener("abort", cancel, { once: true });
      this.status = "Awaiting approval";
      this.revision++;
    });
  }

  private requireIdle(): void {
    if (this.closed) throw new HarnessError("CLOSED", "The Web UI is shutting down.");
    if (this.active || this.changing) throw new HarnessError("SESSION_BUSY", "Stop or finish the current turn first.");
  }

  private observe(turn: WebTurn, event: ReportEvent, child = false): void {
    if (event.type === "subagent_event") { this.observe(turn, event.event, true); return; }
    if (event.type === "execution_report") turn.report = event.report;
    let message: string | undefined;
    const source = child ? "Subagent · " : "";
    if (event.type === "model_request") message = `${source}Model request ${event.iteration}`;
    if (event.type === "tool_result") message = `${source}${event.tool} · ${event.ok ? "completed" : "failed"}`;
    if (event.type === "write_record") message = `${source}Write ${event.record.path} · ${event.record.status}`;
    if (event.type === "shell_record") message = `${source}Command · ${event.record.status}`;
    if (message) {
      turn.activity.push(message);
      if (turn.activity.length > 100) turn.activity.shift();
      this.status = message;
    }
    this.revision++;
  }
}

/** Recover user text and final answers; approval state and UI telemetry are process-local. */
function restoredTurns(history: readonly Message[], sessionId: string): WebTurn[] {
  const turns: WebTurn[] = [];
  let prompt: string | undefined;
  for (const message of history) {
    if (message.role === "user" && typeof message.content === "string") prompt = message.content;
    if (message.role === "assistant" && !message.tool_calls?.length && typeof message.content === "string" && prompt !== undefined) {
      turns.push({ id: `${sessionId}:${turns.length}`, prompt, answer: message.content, status: "answered", activity: [] });
      prompt = undefined;
    }
  }
  return turns;
}
