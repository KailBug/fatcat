import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { HarnessError, checkCancellation } from "../errors.js";
import type { LoopOptions } from "../loop.js";
import type { Message } from "../model.js";
import { AgentSession } from "./agent-session.js";
import type { SessionAgentOptions, SessionRunOptions, SessionTurnResult } from "./agent-session.js";
import { SessionStore, canonicalWorkspace, processAlive } from "./store.js";
import { projectIdOf, sessionName, sessionSummary, workspaceKey } from "./record.js";
import type { SessionRecord, SessionSummary } from "./record.js";
import type { SessionSaveOptions } from "./store.js";
import type { ProjectRecord } from "../project/record.js";
import { joinedProjectRecord, projectJoinPreview } from "../project/operations.js";
import type { ProjectJoinPreview } from "../project/operations.js";
import type { ProjectDeletePreview, ProjectWorkspacePreview } from "../project/management.js";
import { executionIdentity, withSessionIdentity } from "./execution.js";
import type { CompactionOptions, CompactionResult } from "../context/compaction.js";
import type { ContextStatus } from "../context/manager.js";
import { taskIsEnabled } from "../automation/tasks.js";
import type { SessionAutomation } from "../automation/tasks.js";
import { FileChanges } from "../automation/files.js";
import type { SkillCatalog } from "../skills.js";
import { attachmentName, attachmentMediaType, attachmentIdPattern, maxAttachmentBytes, parseAttachmentReference, sameAttachmentTarget } from "../attachments/record.js";
import type { AttachmentInfo, AttachmentTarget, StagedAttachment } from "../attachments/record.js";
import { readAttachmentContent } from "../attachments/read.js";
import type { AttachmentReadOptions, AttachmentReadResult } from "../attachments/read.js";
import { withAttachments } from "../attachments/tools.js";
import type { AttachmentAccess } from "../attachments/tools.js";
import { MemoryAttachments } from "../attachments/memory.js";

export interface AttachmentUploadTarget extends AttachmentTarget {
	name: string;
	size: number;
	uploadId: string;
	draft?: SessionRecord;
}

interface DraftAttachmentScope {
	identity: AttachmentTarget;
	valid: boolean;
}

export interface SessionSelection {
	project?: string;
	continue?: boolean;
	resume?: string;
	fork?: boolean;
	name?: string;
}

export interface SessionOpenOptions {
	workspace: string;
	explicitWorkspace?: boolean;
	store?: SessionStore;
	selection?: SessionSelection;
	persistence?: boolean;
	/** Keep unnamed new sessions off the saved list until the first run (Web UI). */
	deferEmptySessions?: boolean;
	agentForWorkspace?: (workspace: string) => Promise<SessionAgentOptions>;
}

function available(record: SessionRecord): void {
	if ((record.attempt?.status === "running" && processAlive(record.attempt.ownerPid))
		|| (record.activeOperation && processAlive(record.activeOperation.ownerPid))) {
		throw new HarnessError("SESSION_BUSY", "That session is running in another process. Wait for it to finish before managing it.");
	}
}

/** Shared active-session lifecycle for CLI, TUI, and Web UI. */
export class SessionManager {
	private runtime!: AgentSession;
	private busy = false;
	private readonly memory = new Map<string, SessionRecord>();
	private agent: SessionAgentOptions;
	private workspace: string;
	private readonly launchWorkspace: string;
	private readonly store: SessionStore;
	private readonly temporaryAttachments: MemoryAttachments;
	private draftAttachmentScope: DraftAttachmentScope | undefined;
	private readonly draftAttachmentTargets = new WeakMap<AttachmentUploadTarget, DraftAttachmentScope>();
	private attachmentUpdates: Promise<void> = Promise.resolve();
	private readonly idleWaiters = new Set<() => void>();
	readonly persistent: boolean;
	private readonly deferEmptySessions: boolean;
	private readonly agentForWorkspace: SessionOpenOptions["agentForWorkspace"];

	private constructor(agent: SessionAgentOptions, workspace: string, store: SessionStore,
		persistent: boolean, deferEmptySessions: boolean, agentForWorkspace?: SessionOpenOptions["agentForWorkspace"]) {
		this.agent = agent;
		this.workspace = workspace;
		this.launchWorkspace = workspace;
		this.store = store;
		this.temporaryAttachments = new MemoryAttachments({
			getSession: async (id) => this.runtime?.current.id === id ? this.runtime.snapshot : this.memory.get(id),
			saveDraft: (record) => this.persist(record),
		});
		this.persistent = persistent;
		this.deferEmptySessions = deferEmptySessions;
		this.agentForWorkspace = agentForWorkspace;
	}

	static async open(agent: SessionAgentOptions, options: SessionOpenOptions): Promise<SessionManager> {
		const selection = options.selection ?? {};
		if (selection.project !== undefined && (selection.continue || selection.resume !== undefined || options.persistence === false)) {
			throw new HarnessError("USAGE", "Use --project for a new persistent session; resumed sessions retain their saved project.");
		}
		if (selection.continue && selection.resume !== undefined) {
			throw new HarnessError("USAGE", "Choose either --continue or --resume.");
		}
		if (selection.fork && !selection.continue && selection.resume === undefined) {
			throw new HarnessError("USAGE", "Use --fork-session with --continue or --resume.");
		}
		if (options.persistence === false && (selection.continue || selection.resume !== undefined)) {
			throw new HarnessError("USAGE", "Persistent session selection cannot be used with --no-session-persistence.");
		}
		const manager = new SessionManager(agent, await canonicalWorkspace(options.workspace), options.store ?? new SessionStore(),
			options.persistence !== false, options.deferEmptySessions === true, options.agentForWorkspace);
		if (selection.continue) {
			const latest = (await manager.list())[0];
			if (!latest) {
				throw new HarnessError("SESSION_NOT_FOUND", "There is no previous session. Start a new conversation first.");
			}
			await manager.resume(latest.id);
		} else if (selection.resume !== undefined) {
			await manager.resume(selection.resume);
		} else {
			if (selection.project !== undefined) {
				const project = await manager.selectProject(selection.project);
				if (options.explicitWorkspace && workspaceKey(project.workspace) !== workspaceKey(manager.workspace)) {
					throw new HarnessError("USAGE", "--workspace cannot override a project's working directory.");
				}
			}
			await manager.newSession(selection.name, selection.project);
		}
		if (options.explicitWorkspace && manager.current.projectId
			&& workspaceKey(manager.current.workspace) !== workspaceKey(await canonicalWorkspace(options.workspace))) {
			throw new HarnessError("USAGE", "--workspace cannot override a project's working directory.");
		}
		if (selection.fork) {
			await manager.fork(selection.name);
		} else if ((selection.continue || selection.resume !== undefined) && selection.name) {
			await manager.rename(selection.name);
		}
		return manager;
	}

	get current(): SessionSummary {
		return this.runtime.current;
	}
	get history(): Message[] {
		return this.runtime.history;
	}
	get context(): ContextStatus {
		return this.runtime.context;
	}

	async compact(options: CompactionOptions = {}): Promise<CompactionResult> {
		this.requireIdle();
		this.busy = true;
		let result: CompactionResult;
		try {
			await this.prepareExecution();
			result = await this.runtime.compact(options);
		} finally {
			this.finishOperation();
		}
		options.onEvent?.({ type: "completed", iterations: result.requests });
		return result;
	}
	get skills(): SkillCatalog | undefined {
		return this.agent.skills;
	}
	get automationWorkspace(): string {
		return this.workspace;
	}
	get automationStoreRoot(): string {
		return this.store.root;
	}
	get isBusy(): boolean {
		return this.busy;
	}

	async listAutomations(): Promise<SessionAutomation[]> {
		const workspace = this.workspace;
		const result: SessionAutomation[] = [];
		for (const summary of await this.list()) {
			// Listing sessions globally must not start automation in unrelated projects.
			if (summary.projectError || summary.workspace !== workspace) continue;
			if (!summary.automationCount) continue;
			const record = this.persistent ? await this.store.loadAny(summary.id) : await this.selectedRecord(summary.id);
			if (record.workspace !== workspace) continue;
			result.push(...(record.automations ?? []).map((task) => ({
				...structuredClone(task),
				workspace: record.workspace,
				locationRevision: record.locationRevision ?? 0,
				sessionId: record.id,
				sessionTitle: record.name ?? record.title,
			})));
		}
		return result;
	}

	async manageAutomation(args: unknown, signal?: AbortSignal): Promise<unknown> {
		let result: unknown;
		await this.change(async () => {
			result = await this.runtime.applyAutomation(args, signal);
		});
		return result;
	}

	async manageSessionAutomation(id: string, args: unknown): Promise<void> {
		if (id === this.current.id) {
			await this.manageAutomation(args);
			return;
		}
		await this.change(async () => {
			const target = await this.automationSession(id);
			await target.manageAutomation(args);
		});
	}

	private async automationSession(id: string): Promise<SessionManager> {
		const record = await this.selectedRecord(id);
		available(record);
		if (!this.persistent) {
			throw new HarnessError("AUTOMATION_UNAVAILABLE", "Background sessions require persistence.");
		}
		return SessionManager.open(this.agent, { workspace: this.workspace, store: this.store,
			...(this.agentForWorkspace ? { agentForWorkspace: this.agentForWorkspace } : {}), selection: { resume: record.id } });
	}

	async runAutomation(sessionId: string, taskId: string, scheduledAt: number, paths: string[],
		options: Pick<LoopOptions, "signal" | "onEvent"> & { locationRevision?: number } = {}): Promise<string> {
		this.requireIdle();
		this.busy = true;
		try {
			if (sessionId === this.current.id && this.persistent) {
				const latest = await this.store.loadAny(sessionId);
				available(latest);
				if (latest.projectError || latest.workspace !== this.workspace
					|| (latest.locationRevision ?? 0) !== (this.current.locationRevision ?? 0)) {
					throw new HarnessError("AUTOMATION_INACTIVE", "The session workspace changed. Resume it before running its automation.");
				}
				if (latest.revision !== this.current.revision) {
					this.activate(latest);
				}
			}
			const target = sessionId === this.current.id ? this : await this.automationSession(sessionId);
			const task = target.runtime.snapshot.automations?.find((item) => item.id === taskId);
			if (target.workspace !== this.workspace
				|| (options.locationRevision !== undefined && options.locationRevision !== (target.current.locationRevision ?? 0))
				|| !task || !taskIsEnabled(task) || task.lastStatus === "running"
				|| (task.lastScheduledAt !== undefined && scheduledAt <= task.lastScheduledAt)) {
				throw new HarnessError("AUTOMATION_INACTIVE", "This activation is no longer eligible in the selected workspace.");
			}
			const expiry = AbortSignal.timeout(Math.max(1, task.expiresAt - Date.now()));
			if (target === this) {
				this.busy = false;
			}
			return await target.run(task.prompt, { ...options,
				signal: options.signal ? AbortSignal.any([options.signal, expiry]) : expiry, automation: { taskId, scheduledAt, paths } });
		} finally {
			this.finishOperation();
		}
	}

	async list(): Promise<SessionSummary[]> {
		return this.persistent ? this.store.listAll() : [...this.memory.values()].map(sessionSummary)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
	}

	async listProjects(): Promise<ProjectRecord[]> {
		return this.persistent ? this.store.projects.list() : [];
	}

	async createProject(name: string, workspace: string): Promise<ProjectRecord> {
		let created!: ProjectRecord;
		await this.change(async () => {
			this.requirePersistentProject();
			created = await this.store.projects.create(name, resolve(this.workspace || this.launchWorkspace, workspace));
		});
		return created;
	}

	async renameProject(id: string, name: string, expectedRevision: number): Promise<void> {
		await this.change(async () => {
			this.requirePersistentProject();
			const project = await this.store.renameProject(id, name, expectedRevision);
			if (this.current.projectId !== id) return;
			const record = this.runtime.snapshot;
			let updated: SessionRecord;
			if (record.revision > 0) updated = await this.store.loadAny(record.id);
			else if (workspaceKey(record.workspace) !== workspaceKey(project.workspace)) updated = joinedProjectRecord(record, project);
			else updated = { ...record, projectName: project.name, projectRevision: project.revision };
			if (!updated.projectError) this.agent = await this.prepareWorkspace(updated.workspace);
			this.activate(updated);
		});
	}

	async previewProjectWorkspace(id: string, path: string, expectedRevision?: number): Promise<ProjectWorkspacePreview> {
		let preview!: ProjectWorkspacePreview;
		await this.change(async () => {
			this.requirePersistentProject();
			preview = await this.store.previewProjectWorkspace(id, path, expectedRevision);
		});
		return preview;
	}

	async changeProjectWorkspace(preview: ProjectWorkspacePreview): Promise<void> {
		await this.change(async () => {
			this.requirePersistentProject();
			const active = this.current.projectId === preview.projectId;
			const record = this.runtime.snapshot;
			const agent = active ? await this.prepareWorkspace(preview.toWorkspace) : undefined;
			let draft: SessionRecord | undefined;
			if (active && record.revision === 0 && workspaceKey(record.workspace) !== workspaceKey(preview.toWorkspace)) {
				const project = await this.store.projects.load(preview.projectId);
				draft = joinedProjectRecord(record, { ...project, workspace: preview.toWorkspace });
			}
			const project = await this.store.changeProjectWorkspace(preview);
			if (!active) return;
			const updated = record.revision === 0
				? { ...(draft ?? record), projectName: project.name, projectRevision: project.revision }
				: await this.store.loadAny(record.id);
			if (!updated.projectError) {
				this.agent = agent && workspaceKey(updated.workspace) === workspaceKey(preview.toWorkspace)
					? agent : await this.prepareWorkspace(updated.workspace);
			}
			this.activate(updated);
		});
	}

	async previewProjectDelete(id: string, expectedRevision?: number): Promise<ProjectDeletePreview> {
		let preview!: ProjectDeletePreview;
		await this.change(async () => {
			this.requirePersistentProject();
			preview = await this.store.previewProjectDelete(id, expectedRevision);
		});
		return preview;
	}

	async deleteProject(preview: ProjectDeletePreview): Promise<void> {
		await this.change(async () => {
			this.requirePersistentProject();
			const active = this.current.projectId === preview.projectId;
			// Prepare the independent replacement before deleting any persistent data.
			const agent = active ? await this.prepareWorkspace(this.launchWorkspace) : undefined;
			const replacement = active ? this.emptyRecord(undefined, undefined, this.launchWorkspace) : undefined;
			await this.store.deleteProject(preview);
			if (replacement && agent) {
				if (this.draftAttachmentScope) this.draftAttachmentScope.valid = false;
				this.agent = agent;
				this.activate(replacement);
			}
		});
	}

	private async selectProject(selector: string): Promise<ProjectRecord> {
		this.requirePersistentProject();
		const projects = await this.store.projects.list();
		const exact = projects.find((project) => project.id === selector);
		if (exact) return this.store.projects.load(exact.id);
		const matches = projects.filter((project) => project.name === selector);
		if (matches.length > 1) throw new HarnessError("PROJECT_AMBIGUOUS", "More than one project has that name. Use its exact ID.");
		if (!matches.length) throw new HarnessError("PROJECT_NOT_FOUND", "No matching project exists. Use /projects.");
		return this.store.projects.load(matches[0]!.id);
	}

	async newSession(name?: string, projectId?: string | null): Promise<void> {
		await this.change(async () => {
			const target = projectId === undefined ? this.runtime?.current.projectId : projectId;
			const project = target ? await this.selectProject(target) : undefined;
			const workspace = project ? project.workspace : this.workspace || this.launchWorkspace;
			const agent = await this.prepareWorkspace(workspace);
			const empty = this.emptyRecord(name, project, workspace);
			const record = this.deferEmptySessions && name === undefined ? empty : await this.persist(empty);
			this.agent = agent;
			this.activate(record);
		});
	}

	async previewProjectJoin(projectId: string, sessionId?: string): Promise<ProjectJoinPreview> {
		let preview!: ProjectJoinPreview;
		await this.change(async () => {
			const record = await this.joinTarget(sessionId);
			available(record);
			const project = await this.selectProject(projectId);
			await this.prepareWorkspace(project.workspace);
			preview = projectJoinPreview(record, project);
			if (record.revision > 0) {
				const sharing = await this.store.attachments.sharingState(executionIdentity(record));
				preview.attachmentCount = sharing.count;
				preview.attachmentRevision = sharing.revision;
				preview.attachmentFingerprint = sharing.fingerprint;
			}
		});
		return preview;
	}

	async joinProject(preview: ProjectJoinPreview): Promise<void> {
		await this.change(async () => {
			this.requirePersistentProject();
			const selected = await this.joinTarget(preview.sessionId);
			available(selected);
			const project = await this.store.projects.load(preview.projectId);
			if (projectIdOf(selected) === project.id) return;
			const current = projectJoinPreview(selected, project);
			if (selected.revision > 0) {
				const sharing = await this.store.attachments.sharingState(executionIdentity(selected));
				current.attachmentCount = sharing.count;
				current.attachmentRevision = sharing.revision;
				current.attachmentFingerprint = sharing.fingerprint;
			}
			if (Object.keys(current).some((key) => current[key as keyof ProjectJoinPreview] !== preview[key as keyof ProjectJoinPreview])) {
				throw new HarnessError("SESSION_CONFLICT", "The session or project changed. Review a fresh move preview before confirming.");
			}
			const agent = await this.prepareWorkspace(project.workspace);
			const updated = joinedProjectRecord(selected, project);
			const saved = selected.revision === 0 ? updated : await this.persist(updated, undefined,
				{ attachmentRevisionExpected: preview.attachmentRevision });
			if (selected.id === this.current.id) {
				this.agent = agent;
				this.activate(saved);
			}
		});
	}

	private requirePersistentProject(): void {
		if (!this.persistent) throw new HarnessError("PROJECT_UNAVAILABLE", "Projects require persistent sessions.");
	}

	private get attachments() {
		return this.persistent ? this.store.attachments : this.temporaryAttachments;
	}

	/** Capture the initiating identity once; streaming never reads the UI's later selection. */
	async beginAttachmentUpload(sessionId: string, name: string, size: number, uploadId: string = randomUUID()): Promise<AttachmentUploadTarget> {
		let target!: AttachmentUploadTarget;
		await this.attachmentChange(async () => {
			if (!Number.isSafeInteger(size) || size < 0 || size > maxAttachmentBytes || !attachmentIdPattern.test(uploadId)) {
				throw new HarnessError("ATTACHMENT_LIMIT", "Provide a valid upload ID and a file of at most 16 MiB.");
			}
			const record = await this.joinTarget(sessionId);
			if (record.projectError) throw new HarnessError("PROJECT_UNAVAILABLE", record.projectError);
			const normalized = attachmentName(name);
			attachmentMediaType(normalized);
			target = { ...executionIdentity(record), name: normalized, size, uploadId,
				...(record.revision === 0 ? { draft: structuredClone(record) } : {}) };
			if (target.draft && this.draftAttachmentScope) this.draftAttachmentTargets.set(target, this.draftAttachmentScope);
		});
		return target;
	}

	async uploadAttachment(target: AttachmentUploadTarget, body: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<AttachmentInfo> {
		const repository = this.attachments;
		let attachment!: AttachmentInfo;
		let staged: StagedAttachment | undefined;
		try {
			staged = await repository.stageUpload(target, { uploadId: target.uploadId, name: target.name }, body, signal);
			checkCancellation(signal);
			if (staged.size !== target.size) throw new HarnessError("ATTACHMENT_SIZE", "The upload size did not match the selected file.");
			await this.attachmentChange(async () => {
				checkCancellation(signal);
				if (target.draft) {
					const scope = this.draftAttachmentTargets.get(target);
					if (!scope?.valid || !sameAttachmentTarget(scope.identity, target)) {
						throw new HarnessError("ATTACHMENT_TARGET_CHANGED", "The upload draft was moved or deleted. Start a new upload in the intended session.");
					}
				}
				const result = await repository.completeUpload(target.uploadId, target.draft, staged!.stageToken);
				attachment = result.attachment;
				if (result.session.id === this.current.id) this.activate(result.session);
			}, true, signal);
			return attachment;
		} finally {
			if (staged) await repository.discardUpload(target.uploadId, staged.stageToken);
		}
	}

	async importAttachment(path: string, signal?: AbortSignal): Promise<AttachmentInfo> {
		this.requireIdle();
		const identity = this.current;
		const reader = this.agent.tools?.readImportFile;
		if (!reader) throw new HarnessError("ATTACHMENT_UNAVAILABLE", "This host does not provide guarded local file import.");
		const source = await reader(path, signal);
		if (this.current.id !== identity.id || this.current.locationRevision !== identity.locationRevision) {
			throw new HarnessError("ATTACHMENT_CONFLICT", "The target session changed during import. Try again in the intended session.");
		}
		const target = await this.beginAttachmentUpload(identity.id, source.name, source.bytes.byteLength);
		return this.uploadAttachment(target, (async function* () { yield source.bytes; })(), signal);
	}

	async listAttachments(sessionId?: string, includeRemoved = false): Promise<AttachmentInfo[]> {
		const record = await this.joinTarget(sessionId);
		if (record.projectError) throw new HarnessError("PROJECT_UNAVAILABLE", record.projectError);
		if (record.revision === 0 && !projectIdOf(record)) return [];
		return this.attachments.list(executionIdentity(record), { includeRemoved, ...(record.revision === 0 ? { draft: record } : {}) });
	}

	async readAttachment(reference: string, options: AttachmentReadOptions & { sessionId?: string; signal?: AbortSignal } = {}): Promise<AttachmentReadResult> {
		const record = await this.joinTarget(options.sessionId);
		const source = await this.attachments.read(executionIdentity(record), parseAttachmentReference(reference), {
			...(options.signal ? { signal: options.signal } : {}), ...(record.revision === 0 ? { draft: record } : {}) });
		return readAttachmentContent(source.attachment, source.bytes, options, options.signal);
	}

	async downloadAttachment(sessionId: string, reference: string, signal?: AbortSignal): Promise<{ record: AttachmentInfo; bytes: Uint8Array }> {
		const record = await this.joinTarget(sessionId);
		const source = await this.attachments.read(executionIdentity(record), parseAttachmentReference(reference), {
			...(signal ? { signal } : {}), ...(record.revision === 0 ? { draft: record } : {}) });
		return { record: source.attachment, bytes: source.bytes };
	}

	async removeAttachment(sessionId: string, reference: string, expected?: { locationRevision: number; scopeRevision: number }): Promise<void> {
		await this.change(async () => {
			const record = await this.joinTarget(sessionId);
			if (expected && expected.locationRevision !== (record.locationRevision ?? 0)) {
				throw new HarnessError("ATTACHMENT_CONFLICT", "The sharing scope changed. Review this file operation again.");
			}
			await this.attachments.remove(executionIdentity(record), parseAttachmentReference(reference), expected?.scopeRevision);
		});
	}

	async deleteAttachment(sessionId: string, reference: string, expected?: { locationRevision: number; scopeRevision: number }): Promise<void> {
		await this.change(async () => {
			const record = await this.joinTarget(sessionId);
			if (expected && expected.locationRevision !== (record.locationRevision ?? 0)) {
				throw new HarnessError("ATTACHMENT_CONFLICT", "The sharing scope changed. Review this file operation again.");
			}
			await this.attachments.delete(executionIdentity(record), parseAttachmentReference(reference), expected?.scopeRevision);
		});
	}

	private async joinTarget(id?: string): Promise<SessionRecord> {
		const selected = await this.selectedRecord(id);
		return this.persistent && selected.revision > 0 ? this.store.loadAny(selected.id) : selected;
	}

	async reset(): Promise<void> {
		await this.newSession();
	}

	async resume(selector: string): Promise<void> {
		await this.change(async () => {
			let record: SessionRecord;
			if (this.persistent) {
				record = await this.store.loadAny(selector);
			} else {
				const records = [...this.memory.values()].filter((item) => item.id === selector || item.name === selector || item.title === selector);
				if (!records.length) {
					throw new HarnessError("SESSION_NOT_FOUND", "No matching in-memory session exists.");
				}
				if (records.length > 1) {
					throw new HarnessError("SESSION_AMBIGUOUS", "More than one session matches. Resume with the exact session ID.");
				}
				record = structuredClone(records[0]!);
			}
			available(record);
			if (!record.projectError) this.agent = await this.prepareWorkspace(record.workspace);
			this.activate(record);
		});
	}

	async rename(name: string, id?: string): Promise<void> {
		await this.change(async () => {
			const selected = await this.selectedRecord(id);
			available(selected);
			const validated = sessionName(name);
			const renamed = await this.persist({ ...selected, name: validated, title: validated, updatedAt: new Date().toISOString() });
			if (renamed.id === this.current.id) {
				this.activate(renamed);
			}
		});
	}

	async setWorkspace(path: string, id?: string): Promise<void> {
		await this.change(async () => {
			const selected = await this.selectedRecord(id);
			available(selected);
			if (projectIdOf(selected)) {
				throw new HarnessError("PROJECT_WORKSPACE", "Project sessions use the project's working directory. Change it from the project menu.");
			}
			const workspace = await canonicalWorkspace(resolve(selected.workspace, path));
			const agent = await this.prepareWorkspace(workspace);
			for (const task of selected.automations ?? []) {
				if (taskIsEnabled(task) && task.trigger.type === "file_changed") {
					await FileChanges.open(workspace, task.trigger.paths);
				}
			}
			const updated = { ...selected, workspace, location: { kind: "standalone" as const, workspace },
				locationRevision: (selected.locationRevision ?? 0) + 1, storageWorkspace: selected.storageWorkspace ?? selected.workspace,
				updatedAt: new Date().toISOString() };
			const saved = selected.revision === 0 ? updated : await this.persist(updated);
			if (selected.id === this.current.id) {
				this.agent = agent;
				this.activate(saved);
			}
		});
	}

	private async prepareWorkspace(workspace: string): Promise<SessionAgentOptions> {
		const canonical = await canonicalWorkspace(workspace);
		if (this.agentForWorkspace) {
			return this.agentForWorkspace(canonical);
		}
		if (canonical !== this.workspace && this.agent.tools?.workspaceRoot !== undefined) {
			throw new HarnessError("SESSION_WORKSPACE", "This host must provide an agent factory to switch tool workspaces.");
		}
		return this.agent;
	}

	async fork(name?: string, id?: string): Promise<void> {
		await this.change(async () => {
			const selected = await this.selectedRecord(id);
			available(selected);
			const agent = await this.prepareWorkspace(selected.workspace);
			const now = new Date().toISOString();
			const { activeOperation: _operation, ...source } = selected;
			const record = await this.persist({ ...source, id: randomUUID(), name: name === undefined ? null : sessionName(name),
				title: name === undefined ? `${selected.title.slice(0, 110)} (fork)` : sessionName(name),
				forkedFrom: selected.revision === 0 ? null : selected.id, createdAt: now, updatedAt: now, revision: 0, automations: [] },
			selected.revision === 0 ? undefined : selected);
			if (!this.persistent) this.temporaryAttachments.forkSession(selected.id, record.id);
			this.agent = agent;
			this.activate(record);
		});
	}

	async delete(id: string, expectedRevision?: number): Promise<void> {
		await this.change(async () => {
			const selected = expectedRevision !== undefined && this.persistent
				? await this.store.loadAny(id) : await this.selectedRecord(id);
			if (selected.id !== id) {
				throw new HarnessError("SESSION_NOT_FOUND", "No matching session ID exists in this workspace.");
			}
			if (expectedRevision !== undefined && selected.revision !== expectedRevision) {
				throw new HarnessError("SESSION_CONFLICT", "The saved session changed. Refresh it before deleting.");
			}
			available(selected);
			const active = id === this.current.id;
			const project = projectIdOf(selected) ? await this.store.projects.load(projectIdOf(selected)!) : undefined;
			if (selected.projectError) throw new HarnessError("PROJECT_UNAVAILABLE", selected.projectError);
			if (this.deferEmptySessions) {
				// A draft has revision zero and has never entered the saved-session list.
				if (selected.revision === 0 && this.draftAttachmentScope?.identity.sessionId === id) {
					this.draftAttachmentScope.valid = false;
				}
				if (selected.revision > 0) {
					if (this.persistent) {
						await this.store.delete(selected.storageWorkspace ?? selected.workspace, id, selected.revision);
					} else {
						this.memory.delete(id);
						this.temporaryAttachments.deleteSession(id);
					}
				}
				if (active) {
					this.activate(this.emptyRecord(undefined, project));
				}
				return;
			}
			let replacement: SessionRecord | undefined;
			if (this.persistent) {
				replacement = await this.store.delete(selected.storageWorkspace ?? selected.workspace, id, selected.revision,
					active ? { ...this.emptyRecord(undefined, project), storageWorkspace: selected.storageWorkspace ?? selected.workspace } : undefined);
			} else {
				if (active) {
					replacement = await this.persist(this.emptyRecord());
				}
				this.memory.delete(id);
				this.temporaryAttachments.deleteSession(id);
			}
			if (replacement) {
				this.activate(replacement);
			}
		});
	}

	async run(prompt: string, options: SessionRunOptions = {}): Promise<string> {
		this.requireIdle();
		this.busy = true;
		let result: SessionTurnResult;
		try {
			await this.prepareExecution();
			result = await this.runtime.run(prompt, options);
		} finally {
			this.finishOperation();
		}
		// Observers may start a new operation only after the durable turn is settled.
		if (result.completed) options.onEvent?.(result.completed);
		return result.answer;
	}

	private async prepareExecution(): Promise<void> {
		await this.runtime.retrySettlement();
		const record = this.runtime.snapshot;
		if (record.projectError) throw new HarnessError("PROJECT_UNAVAILABLE", record.projectError);
		if (projectIdOf(record)) {
			const project = await this.store.projects.load(projectIdOf(record)!);
			if (project.revision !== record.projectRevision || workspaceKey(project.workspace) !== workspaceKey(record.workspace)) {
				throw new HarnessError("SESSION_CONFLICT", "The project changed. Resume the session before continuing.");
			}
			await canonicalWorkspace(project.workspace);
		}
		if (this.persistent && record.revision > 0) {
			const latest = await this.store.loadAny(record.id);
			available(latest);
			if (latest.revision !== record.revision) throw new HarnessError("SESSION_CONFLICT", "The saved session changed. Resume it before continuing.");
		}
	}

	private async persist(record: SessionRecord, forkSource?: Pick<SessionRecord, "id" | "revision">,
		options?: SessionSaveOptions): Promise<SessionRecord> {
		if (this.persistent) {
			return this.store.save(record, record.revision, forkSource, options);
		}
		if (record.name && [...this.memory.values()].some((item) => item.id !== record.id && item.name === record.name)) {
			throw new HarnessError("SESSION_NAME", "That session name is already used. Choose another name.");
		}
		const saved = structuredClone({ ...record, revision: record.revision + 1 });
		this.memory.set(saved.id, saved);
		this.temporaryAttachments.retainReferences(saved);
		return saved;
	}

	private emptyRecord(name?: string, project?: ProjectRecord, workspace = this.workspace): SessionRecord {
		const now = new Date().toISOString();
		const validated = name === undefined ? null : sessionName(name);
		const location = project ? { kind: "project" as const, projectId: project.id }
			: { kind: "standalone" as const, workspace };
		return { version: 2, id: randomUUID(), workspace, location, locationRevision: 0, name: validated,
			...(project ? { projectName: project.name, projectRevision: project.revision } : {}),
			title: validated ?? "New session", createdAt: now, updatedAt: now, revision: 0,
			forkedFrom: null, history: [], attempt: null };
	}

	private async selectedRecord(id?: string): Promise<SessionRecord> {
		if (id === undefined || id === this.current.id) {
			return this.runtime.snapshot;
		}
		const record = this.persistent ? await this.store.loadAny(id) : this.memory.get(id);
		if (!record || record.id !== id) {
			throw new HarnessError("SESSION_NOT_FOUND", "No matching session ID exists in this workspace.");
		}
		return structuredClone(record);
	}

	private activate(record: SessionRecord): void {
		const identity = executionIdentity(record);
		const access: AttachmentAccess = {
			list: async (signal) => {
				checkCancellation(signal);
				return this.attachments.list(identity);
			},
			read: async (reference, options) => {
				const source = await this.attachments.read(identity, parseAttachmentReference(reference), { pin: true, ...(options.signal ? { signal: options.signal } : {}) });
				return readAttachmentContent(source.attachment, source.bytes, options, options.signal);
			},
		};
		const agent = this.agent.forSession ? this.agent.forSession(identity, this.agent, access)
			: { ...this.agent, ...(this.agent.tools ? { tools: withAttachments(this.agent.tools, access) } : {}),
				model: withSessionIdentity(this.agent.model, identity) };
		const runtime = new AgentSession(record, agent, {
			persistent: this.persistent,
			saveRecord: (next, options) => this.persist(next, undefined, options),
			listAutomations: () => this.listAutomations(),
		});
		const draftScope = this.draftAttachmentScope;
		if (draftScope?.identity.sessionId === identity.sessionId && !sameAttachmentTarget(draftScope.identity, identity)) {
			draftScope.valid = false;
		}
		// Switching away preserves the captured draft; changing that draft's scope revokes it.
		this.draftAttachmentScope = record.revision === 0
			? draftScope?.valid && sameAttachmentTarget(draftScope.identity, identity) ? draftScope : { identity, valid: true }
			: undefined;
		this.runtime = runtime;
		this.workspace = record.workspace;
	}

	private async change(operation: () => Promise<void>): Promise<void> {
		this.requireIdle();
		this.busy = true;
		try {
			await this.runtime?.retrySettlement();
			await operation();
		} finally {
			this.finishOperation();
		}
	}
	private attachmentChange(operation: () => Promise<void>, wait = false, signal?: AbortSignal): Promise<void> {
		const pending = this.attachmentUpdates.then(async () => {
			if (wait) await this.waitUntilIdle(signal);
			return this.change(operation);
		});
		this.attachmentUpdates = pending.catch(() => {});
		return pending;
	}
	private async waitUntilIdle(signal?: AbortSignal): Promise<void> {
		checkCancellation(signal);
		while (this.busy) {
			await new Promise<void>((resolve) => {
				const done = () => {
					this.idleWaiters.delete(done);
					signal?.removeEventListener("abort", done);
					resolve();
				};
				this.idleWaiters.add(done);
				signal?.addEventListener("abort", done, { once: true });
				if (signal?.aborted) done();
			});
			checkCancellation(signal);
		}
	}
	private finishOperation(): void {
		this.busy = false;
		for (const done of this.idleWaiters) done();
	}
	private requireIdle(): void {
		if (this.busy) {
			throw new HarnessError("SESSION_BUSY", "Wait for the active turn or session operation to finish.");
		}
	}
}
