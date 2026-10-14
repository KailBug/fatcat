import { randomUUID } from "node:crypto";
import { HarnessError, formatError } from "../src/errors.js";
import { createTurnReporter } from "../src/execution-report.js";
import { isContextCommand, runContextCommand } from "../src/context/commands.js";
import { isMemoryCommand, runMemoryCommand } from "../src/memory/commands.js";
import type { ExecutionReport, ReportEvent } from "../src/execution-report.js";
import type { Message } from "../src/model.js";
import type { SessionManager } from "../src/session/manager.js";
import type { SessionSummary } from "../src/session/record.js";
import type { ShellRequest } from "../src/tools/shell.js";
import type { WriteApprovalRequest } from "../src/tools/write.js";
import { ApprovalCoordinator } from "../src/permissions/approval.js";
import { PermissionPolicy } from "../src/permissions/policy.js";
import type { PermissionMode } from "../src/permissions/policy.js";
import { WebContextUsage } from "./context-usage.js";
import type { ContextUsage } from "./context-usage.js";
import type { BrowserRequest } from "../src/browser/protocol.js";
import { ConversationAutomations } from "../src/automation/conversations.js";
import { newBoundTask } from "../src/automation/tasks.js";
import type { SessionAutomation } from "../src/automation/tasks.js";
import type { Activation } from "../src/automation/scheduler.js";
import { FileChanges } from "../src/automation/files.js";
import { automationCommandPrompt } from "../src/commands.js";
import type { WorkspacePicker } from "./folder-picker.js";
import type { ProjectRecord } from "../src/project/record.js";
import { ProjectJoinConfirmations } from "./projects.js";
import type { ProjectJoinConfirmation } from "./projects.js";
import { WebAttachments } from "./attachments.js";
import { ProjectManagementConfirmations } from "./project-management.js";
import type { ProjectManagementConfirmation } from "./project-management.js";
import { attachmentEvidence } from "./attachment-evidence.js";
import type { AttachmentEvidence } from "./attachment-evidence.js";

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
  automation?: boolean;
  contextOperation?: boolean;
  sources?: AttachmentEvidence;
};
export type WebUiState = {
  revision: number; info: WebUiInfo; turns: WebTurn[]; busy: boolean;
  approval: Approval | null; status: string;
  current: SessionSummary; sessions: SessionSummary[]; persistent: boolean;
  contextUsage: ContextUsage;
  permissionMode: ReturnType<PermissionPolicy["snapshot"]>;
  automations: SessionAutomation[]; automationNotice: string;
  runningSessionId: string | null;
  projects: ProjectRecord[];
  attachmentRevision: number;
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
  private workspaceSelection: AbortController | undefined;
  private sessions: SessionSummary[] = [];
  private projects: ProjectRecord[] = [];
  private readonly projectConfirmations = new ProjectJoinConfirmations();
  private readonly projectManagement = new ProjectManagementConfirmations();
  private readonly contextUsage: WebContextUsage;
  private automationTasks: SessionAutomation[] = [];
  private automationNotice = "";
  private runningSessionId: string | null = null;
  private automationService: ConversationAutomations | undefined;
  private attachmentRevision = 0;
  readonly attachments: WebAttachments;

  private constructor(readonly info: WebUiInfo, private readonly session: SessionManager,
    private readonly permissionPolicy?: PermissionPolicy) {
    this.contextUsage = new WebContextUsage(info.provider, info.model);
    this.attachments = new WebAttachments(session, async () => {
      this.attachmentRevision++;
      this.revision++;
      try { this.sessions = await session.list(); }
      catch { this.status = "The file change was saved, but the session list could not be refreshed."; }
    });
    this.approvals = new ApprovalCoordinator(() => {
      this.status = this.approvals.snapshot() ? "Awaiting approval" : "Working";
      this.revision++;
    });
  }

  static async create(info: WebUiInfo, session: SessionManager, permissionPolicy?: PermissionPolicy): Promise<WebUiController> {
    const controller = new WebUiController(info, session, permissionPolicy);
    controller.updateWorkspace();
    controller.turns = restoredTurns(session.history, session.current.id);
    controller.sessions = await session.list();
    controller.projects = await session.listProjects();
    controller.automationTasks = await session.listAutomations();
    controller.automationService = new ConversationAutomations(session, {
      idle: () => !controller.active && !controller.changing && !controller.closed,
      run: async (task, activation) => {
        controller.startTurn(task.prompt, { task, activation });
        await controller.active?.done;
      },
      changed: async () => { controller.automationTasks = await session.listAutomations(); controller.sessions = await session.list(); controller.revision++; },
      error: (message) => { controller.automationNotice = message; controller.revision++; },
    });
    controller.automationService.start();
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
      contextUsage: this.contextUsage.snapshot(), permissionMode, automations: this.automationTasks,
      automationNotice: this.automationNotice, runningSessionId: this.runningSessionId, projects: this.projects,
      attachmentRevision: this.attachmentRevision });
  }

  get fileWorkspace(): string | undefined {
    return this.session.current.projectError ? undefined : this.info.workspace || undefined;
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
    this.startTurn(automationCommandPrompt(prompt) ?? prompt);
  }

  private startTurn(prompt: string, automatic?: { task: SessionAutomation; activation: Activation }): void {
    this.requireIdle();
    if (!prompt.trim() || Buffer.byteLength(prompt) > 32_768) {
      throw new HarnessError("INPUT", "Enter a message of at most 32768 UTF-8 bytes.");
    }
    const memoryCommand = !automatic && isMemoryCommand(prompt);
    const contextCommand = !automatic && (isContextCommand(prompt) || memoryCommand);
    if (!automatic && !contextCommand && this.turns.filter((turn) => !turn.contextOperation).length >= 100) {
      throw new HarnessError("INPUT", "Start a new chat after 100 turns.");
    }
    if (contextCommand && this.turns.filter((turn) => turn.contextOperation).length >= 20) {
      this.turns.splice(this.turns.findIndex((turn) => turn.contextOperation), 1);
    }
    const turn: WebTurn = { id: randomUUID(), prompt, status: "running", activity: [],
      ...(automatic ? { automation: true } : {}), ...(contextCommand ? { contextOperation: true } : {}) };
    const visible = !automatic || automatic.task.sessionId === this.session.current.id;
    if (visible) this.turns.push(turn);
    this.runningSessionId = automatic?.task.sessionId ?? this.session.current.id;
    this.status = automatic ? `Automation · ${automatic.task.sessionTitle}` : "Working";
    const abort = new AbortController();
    const historyStart = this.session.history.length;
    // Install active state before the session can emit events or request approval.
    const done = Promise.resolve().then(async () => {
      try {
        const options = { signal: abort.signal, onEvent: createTurnReporter((event) => this.observe(turn, event, false, visible && !contextCommand)) };
        turn.answer = memoryCommand ? (await runMemoryCommand(this.session, prompt, options))!.text
          : contextCommand ? (await runContextCommand(this.session, prompt, options))!.text : automatic
          ? await this.session.runAutomation(automatic.task.sessionId, automatic.task.id, automatic.activation.scheduledAt, automatic.activation.paths ?? [],
            { ...options, ...(automatic.task.locationRevision === undefined ? {} : { locationRevision: automatic.task.locationRevision }) })
          : await this.session.run(prompt, options);
        if (contextCommand && /^\/compact(?:\s|$)/.test(prompt)) this.contextUsage.reset();
        turn.status = "answered";
        if (visible && !contextCommand) turn.sources = attachmentEvidence(this.session.history.slice(historyStart));
        this.status = "Ready";
      } catch (error) {
        turn.error = formatError(error);
        turn.status = "stopped";
        this.status = abort.signal.aborted ? "Stopped" : "Turn failed";
      } finally {
        this.approvals.deny();
        try { this.sessions = await this.session.list(); this.automationTasks = await this.session.listAutomations(); }
        catch { this.status = "Session list could not be refreshed"; }
        this.active = undefined;
        this.runningSessionId = null;
        this.revision++;
      }
    });
    this.active = { abort, done };
    this.revision++;
  }

  reset(): Promise<void> { return this.newSession(); }

  newSession(name?: string, projectId?: string | null): Promise<void> {
    return this.changeSession(() => this.session.newSession(name, projectId));
  }

  chooseProjectWorkspace(name: string, picker: WorkspacePicker, signal: AbortSignal): Promise<void> {
    return this.changeSession(async () => {
      if (this.closed || signal.aborted) return;
      if (!this.session.persistent) throw new HarnessError("INPUT", "Projects require persistent sessions.");
      const cancelled = new AbortController();
      this.workspaceSelection = cancelled;
      try {
        const selectionSignal = AbortSignal.any([signal, cancelled.signal]);
        const path = await picker(this.session.current.workspace, selectionSignal);
        if (path === null || selectionSignal.aborted) return;
        await this.session.createProject(name, path);
      } finally { this.workspaceSelection = undefined; }
    }, false);
  }

  async previewProjectJoin(projectId: string, sessionId: string): Promise<ProjectJoinConfirmation> {
    let confirmation: ProjectJoinConfirmation | undefined;
    await this.changeSession(async () => {
      confirmation = this.projectConfirmations.create(await this.session.previewProjectJoin(projectId, sessionId));
    }, false);
    return confirmation!;
  }

  joinProject(token: string): Promise<void> {
    return this.changeSession(async () => {
      const preview = this.projectConfirmations.take(token);
      await this.session.joinProject(preview);
      this.approvals.deny();
      if (preview.sessionId === this.session.current.id) this.contextUsage.reset();
    }, false);
  }

  renameProject(id: string, name: string, revision: number): Promise<void> {
    return this.changeSession(() => this.session.renameProject(id, name, revision), false);
  }

  async chooseProjectWorkspaceChange(id: string, revision: number, picker: WorkspacePicker,
    signal: AbortSignal): Promise<ProjectManagementConfirmation | null> {
    let confirmation: ProjectManagementConfirmation | null = null;
    await this.changeSession(async () => {
      const project = (await this.session.listProjects()).find((item) => item.id === id);
      if (!project) throw new HarnessError("PROJECT_NOT_FOUND", "The project is no longer available.");
      if (project.revision !== revision) throw new HarnessError("PROJECT_CONFLICT", "The project changed. Reopen its menu and review it again.");
      if (this.closed || signal.aborted) return;
      const cancelled = new AbortController();
      this.workspaceSelection = cancelled;
      try {
        const selectionSignal = AbortSignal.any([signal, cancelled.signal]);
        const path = await picker(project.workspace, selectionSignal);
        if (path === null || selectionSignal.aborted) return;
        confirmation = this.projectManagement.create({ kind: "workspace",
          preview: await this.session.previewProjectWorkspace(id, path, revision) });
      } finally { this.workspaceSelection = undefined; }
    }, false);
    return confirmation;
  }

  async previewProjectDelete(id: string, revision: number): Promise<ProjectManagementConfirmation> {
    let confirmation: ProjectManagementConfirmation | undefined;
    await this.changeSession(async () => {
      confirmation = this.projectManagement.create({ kind: "delete", preview: await this.session.previewProjectDelete(id, revision) });
    }, false);
    return confirmation!;
  }

  changeProjectWorkspace(token: string): Promise<void> {
    return this.changeSession(async () => {
      const confirmation = this.projectManagement.take(token);
      if (confirmation.kind !== "workspace") throw new HarnessError("PROJECT_CONFLICT", "Review the workspace change before confirming it.");
      await this.session.changeProjectWorkspace(confirmation.preview);
      this.approvals.deny();
      if (this.session.current.projectId === confirmation.preview.projectId) this.contextUsage.reset();
      this.attachmentRevision++;
    }, false);
  }

  deleteProject(token: string): Promise<void> {
    return this.changeSession(async () => {
      const confirmation = this.projectManagement.take(token);
      if (confirmation.kind !== "delete") throw new HarnessError("PROJECT_CONFLICT", "Review the project deletion before confirming it.");
      const activeProject = this.session.current.projectId === confirmation.preview.projectId;
      await this.session.deleteProject(confirmation.preview);
      this.approvals.deny();
      if (activeProject) {
        this.turns = restoredTurns(this.session.history, this.session.current.id);
        this.contextUsage.reset();
      }
      this.attachmentRevision++;
    }, false);
  }

  resume(selector: string): Promise<void> {
    return this.changeSession(() => this.session.resume(selector));
  }

  setWorkspace(path: string, id?: string): Promise<void> {
    return this.changeSession(() => this.session.setWorkspace(path, id), id === undefined || id === this.session.current.id);
  }

  chooseWorkspace(id: string, picker: WorkspacePicker, signal: AbortSignal): Promise<void> {
    return this.changeSession(async () => {
      if (this.closed || signal.aborted) return;
      const selected = id === this.session.current.id ? this.session.current : this.sessions.find((item) => item.id === id);
      if (!selected) throw new HarnessError("SESSION_NOT_FOUND", "No matching session exists.");
      if (selected.projectId) throw new HarnessError("INPUT", "Project sessions use the project workspace. It cannot be changed per session.");
      const cancelled = new AbortController();
      this.workspaceSelection = cancelled;
      try {
        const selectionSignal = AbortSignal.any([signal, cancelled.signal]);
        const path = await picker(selected.workspace, selectionSignal);
        if (path === null || selectionSignal.aborted) return;
        await this.session.setWorkspace(path, id);
        if (id === this.session.current.id) {
          this.turns = restoredTurns(this.session.history, this.session.current.id);
          this.contextUsage.reset();
        }
      } finally { this.workspaceSelection = undefined; }
    }, false);
  }

  private updateWorkspace(): void {
    this.info.workspace = this.session.current.workspace;
    if (this.session.skills) {
      this.info.skills = this.session.skills.skills.length;
      this.info.warnings = [...this.session.skills.warnings];
    }
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

  async createAutomation(value: unknown, sessionId?: string): Promise<void> {
    this.requireIdle();
    const task = newBoundTask(value);
    await this.changeSession(async () => {
      if (task.trigger.type === "file_changed") {
        const workspace = sessionId ? (await this.session.list()).find((item) => item.id === sessionId)?.workspace : this.info.workspace;
        if (!workspace) throw new HarnessError("SESSION_NOT_FOUND", "No matching session exists.");
        await FileChanges.open(workspace, task.trigger.paths);
      }
      if (!sessionId) await this.session.newSession();
      await this.session.manageSessionAutomation(sessionId ?? this.session.current.id, { action: "create", ...(value as object) });
    }, !sessionId);
  }

  manageAutomation(sessionId: string, id: string, action: "pause" | "resume" | "delete"): Promise<void> {
    return this.changeSession(() => this.session.manageSessionAutomation(sessionId, { action, id }), false);
  }

  private changeSession(change: () => Promise<unknown>, restore = true): Promise<void> {
    this.requireIdle();
    this.status = "Loading session";
    const done = Promise.resolve().then(async () => {
      try {
        await change();
        this.updateWorkspace();
        if (restore) {
          this.turns = restoredTurns(this.session.history, this.session.current.id);
          this.contextUsage.reset();
        }
        this.sessions = await this.session.list();
        this.projects = await this.session.listProjects();
        this.automationTasks = await this.session.listAutomations();
        this.status = "Ready";
      } catch (error) {
        // Expose fresh metadata for a newly confirmed retry without replacing the active transcript.
        try { this.sessions = await this.session.list(); } catch { /* Keep the original operation error. */ }
        try { this.projects = await this.session.listProjects(); } catch { /* Keep the original operation error. */ }
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
    this.workspaceSelection?.abort();
    this.approvals.deny();
    if (this.active) this.status = "Stopping";
    this.revision++;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.attachments.close();
    this.stop();
    await Promise.allSettled([this.active?.done, this.changing]);
    await this.automationService?.close();
  }

  approve(id: string, allowed: boolean): void {
    this.approvals.approve(id, allowed);
  }

  requestApproval(kind: "write", request: WriteApprovalRequest, signal?: AbortSignal): Promise<boolean>;
  requestApproval(kind: "shell", request: ShellRequest, signal?: AbortSignal): Promise<boolean>;
  requestApproval(kind: "browser", request: BrowserRequest, signal?: AbortSignal): Promise<boolean>;
  requestApproval(kind: "write" | "shell" | "browser", request: WriteApprovalRequest | ShellRequest | BrowserRequest, signal?: AbortSignal): Promise<boolean> {
    if (this.closed || !this.active || signal?.aborted || this.active.abort.signal.aborted) return Promise.resolve(false);
    const waitingSignal = signal ? AbortSignal.any([signal, this.active.abort.signal]) : this.active.abort.signal;
    if (kind === "browser") return this.approvals.request(kind, request as BrowserRequest, waitingSignal);
    return kind === "write" ? this.approvals.request(kind, request as WriteApprovalRequest, waitingSignal)
      : this.approvals.request(kind, request as ShellRequest, waitingSignal);
  }

  private requireIdle(): void {
    if (this.closed) throw new HarnessError("CLOSED", "The Web UI is shutting down.");
    if (this.active || this.changing) throw new HarnessError("SESSION_BUSY", "Stop or finish the current turn first.");
  }

  private observe(turn: WebTurn, event: ReportEvent, child = false, visible = true): void {
    if (event.type === "subagent_event") { this.observe(turn, event.event, true, visible); return; }
    if (!child && visible) this.contextUsage.observe(event);
    if (event.type === "execution_report") turn.report = event.report;
    let message: string | undefined;
    const source = child ? "Subagent · " : "";
    if (event.type === "model_request") message = `${source}${event.purpose === "compaction" ? "Summary" : event.purpose === "document" ? "Document" : "Model"} request ${event.iteration}`;
    if (event.type === "compaction_start") message = "Request limit reached; compacting older turns";
    if (event.type === "compaction_end") message = `Context compacted: ${event.beforeBytes} to ${event.afterBytes} conversation bytes; continuing current request`;
    if (event.type === "tool_result") message = `${source}${event.tool} · ${event.ok ? "completed" : "failed"}`;
    if (event.type === "write_record") message = `${source}Write ${event.record.path} · ${event.record.status}`;
    if (event.type === "shell_record") message = `${source}Command · ${event.record.status}`;
    if (event.type === "browser_record") message = `${source}Browser ${event.record.path} · ${event.record.status}`;
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
  let start = 0;
  for (const [index, message] of history.entries()) {
    if (message.role === "user" && typeof message.content === "string") { prompt = message.content; start = index; }
    if (message.role === "assistant" && !message.tool_calls?.length && typeof message.content === "string" && prompt !== undefined) {
      turns.push({ id: `${sessionId}:${turns.length}`, prompt, answer: message.content, status: "answered", activity: [],
        sources: attachmentEvidence(history.slice(start, index + 1)) });
      prompt = undefined;
    }
  }
  return turns;
}
