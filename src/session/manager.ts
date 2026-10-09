import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { HarnessError } from "../errors.js";
import type { LoopOptions } from "../loop.js";
import type { Message } from "../model.js";
import { AgentSession } from "./agent-session.js";
import type { SessionAgentOptions, SessionRunOptions, SessionTurnResult } from "./agent-session.js";
import { SessionStore, canonicalWorkspace, processAlive } from "./store.js";
import { sessionName, sessionSummary } from "./record.js";
import type { SessionRecord, SessionSummary } from "./record.js";
import { taskIsEnabled } from "../automation/tasks.js";
import type { SessionAutomation } from "../automation/tasks.js";
import { FileChanges } from "../automation/files.js";
import type { SkillCatalog } from "../skills.js";

export interface SessionSelection {
	continue?: boolean;
	resume?: string;
	fork?: boolean;
	name?: string;
}

export interface SessionOpenOptions {
	workspace: string;
	store?: SessionStore;
	selection?: SessionSelection;
	persistence?: boolean;
	/** Keep unnamed new sessions off the saved list until the first run (Web UI). */
	deferEmptySessions?: boolean;
	agentForWorkspace?: (workspace: string) => Promise<SessionAgentOptions>;
}

function available(record: SessionRecord): void {
	if (record.attempt?.status === "running" && processAlive(record.attempt.ownerPid)) {
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
	private readonly store: SessionStore;
	readonly persistent: boolean;
	private readonly deferEmptySessions: boolean;
	private readonly agentForWorkspace: SessionOpenOptions["agentForWorkspace"];

	private constructor(agent: SessionAgentOptions, workspace: string, store: SessionStore,
		persistent: boolean, deferEmptySessions: boolean, agentForWorkspace?: SessionOpenOptions["agentForWorkspace"]) {
		this.agent = agent;
		this.workspace = workspace;
		this.store = store;
		this.persistent = persistent;
		this.deferEmptySessions = deferEmptySessions;
		this.agentForWorkspace = agentForWorkspace;
	}

	static async open(agent: SessionAgentOptions, options: SessionOpenOptions): Promise<SessionManager> {
		const selection = options.selection ?? {};
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
			await manager.newSession(selection.name);
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
			if (summary.workspace !== workspace) continue;
			if (!summary.automationCount) continue;
			const record = this.persistent ? await this.store.loadAny(summary.id) : await this.selectedRecord(summary.id);
			if (record.workspace !== workspace) continue;
			result.push(...(record.automations ?? []).map((task) => ({
				...structuredClone(task),
				workspace: record.workspace,
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
		options: Pick<LoopOptions, "signal" | "onEvent"> = {}): Promise<string> {
		this.requireIdle();
		this.busy = true;
		try {
			if (sessionId === this.current.id && this.persistent) {
				const latest = await this.store.loadAny(sessionId);
				available(latest);
				if (latest.workspace !== this.workspace) {
					throw new HarnessError("AUTOMATION_INACTIVE", "The session workspace changed. Resume it before running its automation.");
				}
				if (latest.revision !== this.current.revision) {
					this.activate(latest);
				}
			}
			const target = sessionId === this.current.id ? this : await this.automationSession(sessionId);
			const task = target.runtime.snapshot.automations?.find((item) => item.id === taskId);
			if (target.workspace !== this.workspace || !task || !taskIsEnabled(task) || task.lastStatus === "running"
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
			this.busy = false;
		}
	}

	async list(): Promise<SessionSummary[]> {
		return this.persistent ? this.store.listAll() : [...this.memory.values()].map(sessionSummary)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
	}

	async newSession(name?: string): Promise<void> {
		await this.change(async () => {
			const empty = this.emptyRecord(name);
			const record = this.deferEmptySessions && name === undefined ? empty : await this.persist(empty);
			this.activate(record);
		});
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
			const agent = await this.prepareWorkspace(record.workspace);
			this.agent = agent;
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
			const workspace = await canonicalWorkspace(resolve(selected.workspace, path));
			const agent = await this.prepareWorkspace(workspace);
			for (const task of selected.automations ?? []) {
				if (taskIsEnabled(task) && task.trigger.type === "file_changed") {
					await FileChanges.open(workspace, task.trigger.paths);
				}
			}
			const updated = { ...selected, workspace, storageWorkspace: selected.storageWorkspace ?? selected.workspace,
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
			const record = await this.persist({ ...selected, id: randomUUID(), name: name === undefined ? null : sessionName(name),
				title: name === undefined ? `${selected.title.slice(0, 110)} (fork)` : sessionName(name),
				forkedFrom: selected.revision === 0 ? null : selected.id, createdAt: now, updatedAt: now, revision: 0, automations: [] },
			selected.revision === 0 ? undefined : selected);
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
			if (this.deferEmptySessions) {
				// A draft has revision zero and has never entered the saved-session list.
				if (selected.revision > 0) {
					if (this.persistent) {
						await this.store.delete(selected.storageWorkspace ?? selected.workspace, id, selected.revision);
					} else {
						this.memory.delete(id);
					}
				}
				if (active) {
					this.activate(this.emptyRecord());
				}
				return;
			}
			let replacement: SessionRecord | undefined;
			if (this.persistent) {
				replacement = await this.store.delete(selected.storageWorkspace ?? selected.workspace, id, selected.revision,
					active ? { ...this.emptyRecord(), storageWorkspace: selected.storageWorkspace ?? selected.workspace } : undefined);
			} else {
				if (active) {
					replacement = await this.persist(this.emptyRecord());
				}
				this.memory.delete(id);
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
			result = await this.runtime.run(prompt, options);
		} finally {
			this.busy = false;
		}
		// Observers may start a new operation only after the durable turn is settled.
		if (result.completed) options.onEvent?.(result.completed);
		return result.answer;
	}

	private async persist(record: SessionRecord, forkSource?: Pick<SessionRecord, "id" | "revision">): Promise<SessionRecord> {
		if (this.persistent) {
			return this.store.save(record, record.revision, forkSource);
		}
		if (record.name && [...this.memory.values()].some((item) => item.id !== record.id && item.name === record.name)) {
			throw new HarnessError("SESSION_NAME", "That session name is already used. Choose another name.");
		}
		const saved = structuredClone({ ...record, revision: record.revision + 1 });
		this.memory.set(saved.id, saved);
		return saved;
	}

	private emptyRecord(name?: string): SessionRecord {
		const now = new Date().toISOString();
		const validated = name === undefined ? null : sessionName(name);
		return { version: 1, id: randomUUID(), workspace: this.workspace, name: validated,
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
		const runtime = new AgentSession(record, this.agent, {
			persistent: this.persistent,
			saveRecord: (next) => this.persist(next),
			listAutomations: () => this.listAutomations(),
		});
		this.runtime = runtime;
		this.workspace = record.workspace;
	}

	private async change(operation: () => Promise<void>): Promise<void> {
		this.requireIdle();
		this.busy = true;
		try {
			await operation();
		} finally {
			this.busy = false;
		}
	}
	private requireIdle(): void {
		if (this.busy) {
			throw new HarnessError("SESSION_BUSY", "Wait for the active turn or session operation to finish.");
		}
	}
}
