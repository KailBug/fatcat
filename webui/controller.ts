import { randomUUID } from "node:crypto";
import { HarnessError, formatError } from "../src/errors.js";
import { createTurnReporter } from "../src/execution-report.js";
import type { ExecutionReport, ReportEvent } from "../src/execution-report.js";
import type { Message } from "../src/model.js";
import type { SessionManager } from "../src/session/manager.js";
import type { SessionSummary } from "../src/session/store.js";
import type { ShellRequest } from "../src/tools/shell.js";
import type { WriteApprovalRequest } from "../src/tools/write.js";
import { ApprovalCoordinator } from "../src/permissions/approval.js";
import { PermissionPolicy } from "../src/permissions/policy.js";
import type { PermissionMode } from "../src/permissions/policy.js";
import { WebContextUsage } from "./context-usage.js";
import type { ContextUsage } from "./context-usage.js";

export type WebUiInfo = {
  provider: string; model: string; workspace: string;
  permission: string; shellPermission: string; webPermission: string;
  maxIterations: number; maxRequestBytes: number; skills: number; warnings: string[];
};
export type { PendingApproval as Approval } from "../src/permissions/approval.js";
import type { PendingApproval as Approval } from "../src/permissions/approval.js";
export type WebTurn = {
  id: string; prompt: string; answer?: string; error?: string;
  status: "running" | "answered" | "stopped";
  activity: string[]; report?: ExecutionReport;
};
export type WebUiState = {
  revision: number; info: WebUiInfo; turns: WebTurn[]; busy: boolean;
  approval: Approval | null; status: string;
  current: SessionSummary; sessions: SessionSummary[]; persistent: boolean;
  contextUsage: ContextUsage;
  permissionMode: ReturnType<PermissionPolicy["snapshot"]>;
};

/** Browser tabs share one selected session, active turn and pending approval. */
export class WebUiController {
  private turns: WebTurn[] = [];
  private revision = 0;
  private active: { abort: AbortController; done: Promise<void> } | undefined;
  private readonly approvals: ApprovalCoordinator;
  private status = "Ready";
  private closed = false;
  private changing: Promise<void> | undefined;
  private sessions: SessionSummary[] = [];
  private readonly contextUsage: WebContextUsage;

  private constructor(readonly info: WebUiInfo, private readonly session: SessionManager,
    private readonly permissionPolicy?: PermissionPolicy) {
    this.contextUsage = new WebContextUsage(info.provider, info.model);
    this.approvals = new ApprovalCoordinator(() => {
      this.status = this.approvals.snapshot() ? "Awaiting approval" : "Working";
      this.revision++;
    });
  }

  static async create(info: WebUiInfo, session: SessionManager, permissionPolicy?: PermissionPolicy): Promise<WebUiController> {
    const controller = new WebUiController(info, session, permissionPolicy);
    controller.turns = restoredTurns(session.history, session.current.id);
    controller.sessions = await session.list();
    return controller;
  }

  snapshot(): WebUiState {
    // A controller without an injected tool policy cannot authorize a mode change.
    const permissionMode = this.permissionPolicy?.snapshot() ?? {
      mode: "custom" as const, permission: this.info.permission as "ask" | "read-only" | "workspace-write",
      shellPermission: this.info.shellPermission as "ask" | "deny" | "allow", availableModes: [] as PermissionMode[],
      fileAccess: "workspace" as const, networkAccess: "public" as const,
    };
    return structuredClone({ revision: this.revision, info: this.info, turns: this.turns,
      busy: Boolean(this.active || this.changing), approval: this.approvals.snapshot(), status: this.status,
      current: this.session.current, sessions: this.sessions, persistent: this.session.persistent,
      contextUsage: this.contextUsage.snapshot(), permissionMode });
  }

  selectPermissionMode(mode: PermissionMode): void {
    this.requireIdle();
    if (!this.permissionPolicy) throw new HarnessError("PERMISSION_DENIED", "Permission selection is not available for this tool configuration.");
    this.permissionPolicy.select(mode);
    const permissions = this.permissionPolicy.snapshot();
    this.info.permission = permissions.permission;
    this.info.shellPermission = permissions.shellPermission;
    this.revision++;
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
        this.approvals.deny();
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

  rename(name: string, id?: string): Promise<void> {
    return this.changeSession(() => this.session.rename(name, id), false);
  }

  fork(name?: string, id?: string): Promise<void> {
    return this.changeSession(() => this.session.fork(name, id));
  }

  deleteSession(id: string, revision?: number): Promise<void> {
    const selectedRevision = revision ?? this.sessions.find((item) => item.id === id)?.revision;
    return this.changeSession(() => this.session.delete(id, selectedRevision), id === this.session.current.id);
  }

  private changeSession(change: () => Promise<unknown>, restore = true): Promise<void> {
    this.requireIdle();
    this.status = "Loading session";
    const done = Promise.resolve().then(async () => {
      try {
        await change();
        if (restore) {
          this.turns = restoredTurns(this.session.history, this.session.current.id);
          this.contextUsage.reset();
        }
        this.sessions = await this.session.list();
        this.status = "Ready";
      } catch (error) {
        // Expose fresh metadata for a newly confirmed retry without replacing the active transcript.
        try { this.sessions = await this.session.list(); } catch { /* Keep the original operation error. */ }
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
    this.approvals.deny();
    if (this.active) this.status = "Stopping";
    this.revision++;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.stop();
    await Promise.allSettled([this.active?.done, this.changing]);
  }

  approve(id: string, allowed: boolean): void {
    this.approvals.approve(id, allowed);
  }

  requestApproval(kind: "write", request: WriteApprovalRequest, signal?: AbortSignal): Promise<boolean>;
  requestApproval(kind: "shell", request: ShellRequest, signal?: AbortSignal): Promise<boolean>;
  requestApproval(kind: "write" | "shell", request: WriteApprovalRequest | ShellRequest, signal?: AbortSignal): Promise<boolean> {
    if (this.closed || !this.active || signal?.aborted || this.active.abort.signal.aborted) return Promise.resolve(false);
    const waitingSignal = signal ? AbortSignal.any([signal, this.active.abort.signal]) : this.active.abort.signal;
    return kind === "write" ? this.approvals.request(kind, request as WriteApprovalRequest, waitingSignal)
      : this.approvals.request(kind, request as ShellRequest, waitingSignal);
  }

  private requireIdle(): void {
    if (this.closed) throw new HarnessError("CLOSED", "The Web UI is shutting down.");
    if (this.active || this.changing) throw new HarnessError("SESSION_BUSY", "Stop or finish the current turn first.");
  }

  private observe(turn: WebTurn, event: ReportEvent, child = false): void {
    if (event.type === "subagent_event") { this.observe(turn, event.event, true); return; }
    if (!child) this.contextUsage.observe(event);
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
