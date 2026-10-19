import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, realpath, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AttachmentStore } from "../attachments/store.js";
import { HarnessError } from "../errors.js";
import { ProjectStore } from "../project/store.js";
import { projectName } from "../project/record.js";
import type { ProjectRecord } from "../project/record.js";
import { maxProjectMembers, movedProjectSession, projectMemberFingerprint } from "../project/management.js";
import type { ProjectDeletePreview, ProjectImpact, ProjectSessionMove, ProjectWorkspacePreview } from "../project/management.js";
import { invalidSession, isRecord } from "./history.js";
import { decodeSessionRecord, encodeSessionRecord, projectIdOf, sessionIdPattern, sessionSummary, workspaceKey } from "./record.js";
import type { SessionRecord, SessionSummary } from "./record.js";
import type { SessionExecutionIdentity } from "./execution.js";
import { listSessionDirectories, maxSessionSnapshotBytes, publishSessionSnapshot, readSessionSnapshot,
  removeSessionSnapshot, sessionDirectory } from "./snapshots.js";

interface ProjectMember extends SessionSummary {
  storageWorkspace: string;
  enabledAutomationCount: number;
  allAutomationCount: number;
}

export interface SessionSaveOptions {
  attemptOwner?: { ownerPid: number; startedAt: string };
  operationId?: string;
  attachmentRevisionExpected?: number;
  memoryFingerprintExpected?: string;
}
export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

export async function canonicalWorkspace(workspace: string): Promise<string> {
  try {
    const path = await realpath(workspace);
    if (!(await stat(path)).isDirectory()) throw new Error();
    return path;
  } catch { throw new HarnessError("SESSION_WORKSPACE", "The session workspace must be an accessible directory."); }
}

/** Versioned atomic snapshots; no credentials, permission grants, or live handles. */
export class SessionStore {
  readonly root: string;
  readonly projects: ProjectStore;
  readonly attachments: AttachmentStore;
  constructor(options: { root?: string } = {}) {
    const root = options.root ?? process.env.FATCAT_SESSION_DIR ?? join(homedir(), ".fatcat", "sessions");
    if (!root.trim()) throw new HarnessError("SESSION_STORAGE", "FATCAT_SESSION_DIR must not be empty.");
    this.root = resolve(root);
    this.projects = new ProjectStore({ root: this.root });
    this.attachments = new AttachmentStore({ root: this.root, sessions: {
      load: (id) => this.loadAnyUnlocked(id),
      prepareDraft: (record) => this.prepareAttachmentDraft(record),
      publish: (record) => publishSessionSnapshot(this.root, record),
      remove: (id, workspace) => removeSessionSnapshot(this.root, workspace, id),
    } });
  }

  async list(workspace: string): Promise<SessionSummary[]> {
    const canonical = await canonicalWorkspace(workspace);
    return (await this.listAll()).filter((item) => workspaceKey(item.workspace) === workspaceKey(canonical));
  }

  async renameProject(id: string, name: string, expectedRevision: number): Promise<ProjectRecord> {
    const normalized = projectName(name);
    return this.projectManagement(id, expectedRevision, async (project) => {
      if (project.name === normalized) return project;
      const updated = { ...project, name: normalized, updatedAt: new Date().toISOString(), revision: project.revision + 1 };
      await this.attachments.publishProject(updated);
      return updated;
    });
  }

  async previewProjectWorkspace(id: string, path: string, expectedRevision?: number): Promise<ProjectWorkspacePreview> {
    return this.projectManagement(id, expectedRevision, async (project, members) => ({
      ...await this.projectImpact(project, members), fromWorkspace: project.workspace,
      toWorkspace: await canonicalWorkspace(resolve(project.workspace, path)),
    }));
  }

  async changeProjectWorkspace(preview: ProjectWorkspacePreview): Promise<ProjectRecord> {
    return this.projectManagement(preview.projectId, preview.projectRevision, async (project, members) => {
      const workspace = await canonicalWorkspace(preview.toWorkspace);
      const current: ProjectWorkspacePreview = { ...await this.projectImpact(project, members),
        fromWorkspace: project.workspace, toWorkspace: workspace };
      this.requireProjectPreview(current, preview);
      if (workspaceKey(project.workspace) === workspaceKey(workspace)) return project;
      const now = new Date().toISOString();
      const updated = { ...project, workspace, revision: project.revision + 1, updatedAt: now };
      const moves: ProjectSessionMove[] = [];
      for (const member of members) {
        const move: ProjectSessionMove = { id: member.id, storageWorkspace: member.storageWorkspace,
          projectId: project.id, expectedRevision: member.revision, locationRevision: member.locationRevision ?? 0,
          fromWorkspace: project.workspace, toWorkspace: workspace, changedAt: now, changeId: randomUUID() };
        const record = await this.read(member.storageWorkspace, member.id);
        const moved = movedProjectSession(record, move);
        const encoded = encodeSessionRecord(moved);
        if (Buffer.byteLength(JSON.stringify(encoded)) > maxSessionSnapshotBytes) {
          throw new HarnessError("SESSION_LIMIT", "A project session cannot fit another directory change within the 64 MiB storage limit.");
        }
        decodeSessionRecord(encoded, member.storageWorkspace, member.id);
        moves.push(move);
      }
      await this.attachments.publishProject(updated, moves);
      return updated;
    });
  }

  async previewProjectDelete(id: string, expectedRevision?: number): Promise<ProjectDeletePreview> {
    return this.projectManagement(id, expectedRevision, async (project, members) => {
      const impact = await this.projectImpact(project, members, true);
      return { ...impact, workspace: project.workspace,
        deleteAttachmentCount: impact.attachmentCount - impact.retainedAttachmentCount };
    });
  }

  async deleteProject(preview: ProjectDeletePreview): Promise<void> {
    await this.projectManagement(preview.projectId, preview.projectRevision, async (project, members) => {
      const impact = await this.projectImpact(project, members, true);
      const current: ProjectDeletePreview = { ...impact, workspace: project.workspace,
        deleteAttachmentCount: impact.attachmentCount - impact.retainedAttachmentCount };
      this.requireProjectPreview(current, preview);
      await this.attachments.deleteProject(project.id, members.map((member) => ({ id: member.id, storageWorkspace: member.storageWorkspace })));
    });
  }

  private async projectManagement<T>(id: string, expectedRevision: number | undefined,
    operation: (project: ProjectRecord, members: ProjectMember[]) => Promise<T>): Promise<T> {
    return this.attachments.withMetadata(() => this.projects.withProjectUnlocked(id, expectedRevision,
      async (project) => operation(project, await this.projectMembers(project.id))));
  }

  private async projectMembers(projectId: string): Promise<ProjectMember[]> {
    const members: ProjectMember[] = [];
    for (const directory of await listSessionDirectories(this.root)) {
      for (const file of await readdir(directory)) {
        if (!file.endsWith(".json") || !sessionIdPattern.test(file.slice(0, -5))) continue;
        // A corrupt snapshot may hide membership; management fails closed instead of leaving it orphaned.
        const record = await this.readDirectory(directory, file.slice(0, -5));
        if (projectIdOf(record) !== projectId) continue;
        this.requireAvailable(record);
        if (members.some((member) => member.id === record.id)) throw new HarnessError("SESSION_AMBIGUOUS", "Duplicate project session identity in storage.");
        if (members.length >= maxProjectMembers) throw new HarnessError("PROJECT_LIMIT", "A project operation supports at most 1000 saved sessions.");
        members.push({ ...sessionSummary(record), storageWorkspace: record.storageWorkspace ?? record.workspace,
          enabledAutomationCount: record.automations?.filter((task) => task.enabled).length ?? 0,
          allAutomationCount: record.automations?.length ?? 0 });
      }
    }
    return members.sort((left, right) => left.id.localeCompare(right.id));
  }

  private async projectImpact(project: ProjectRecord, members: ProjectMember[], allAutomations = false): Promise<ProjectImpact> {
    return { projectId: project.id, projectRevision: project.revision, projectName: project.name,
      sessionCount: members.length, automationCount: members.reduce((total, member) => total
        + (allAutomations ? member.allAutomationCount : member.enabledAutomationCount), 0),
      memberFingerprint: projectMemberFingerprint(members), ...await this.attachments.projectImpact(project.id, members.map((member) => member.id)) };
  }

  private requireProjectPreview<T extends ProjectImpact>(current: T, supplied: T): void {
    if (Object.keys(current).some((key) => current[key as keyof T] !== supplied[key as keyof T])) {
      throw new HarnessError("PROJECT_CONFLICT", "The project, its sessions or its attachments changed. Review a fresh project preview before confirming.");
    }
  }

  async listAll(): Promise<SessionSummary[]> {
    return this.attachments.withMetadata(() => this.listAllUnlocked(), false);
  }

  private async listAllUnlocked(): Promise<SessionSummary[]> {
    const summaries: SessionSummary[] = [];
    for (const directory of await listSessionDirectories(this.root)) {
      for (const file of await readdir(directory)) {
        if (!file.endsWith(".json") || !sessionIdPattern.test(file.slice(0, -5))) continue;
        try { summaries.push(sessionSummary(await this.readDirectory(directory, file.slice(0, -5)))); }
        catch (error) {
          if (!(error instanceof HarnessError && ["SESSION_CORRUPT", "SESSION_INVALID", "SESSION_NOT_FOUND"].includes(error.code))) throw error;
        }
      }
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }

  async loadAny(selector: string): Promise<SessionRecord> {
    return this.attachments.withMetadata(() => this.loadAnyUnlocked(selector), false);
  }

  /** Keep Memory access and project/session management under the same identity gate. */
  async withMemorySession<T>(identity: SessionExecutionIdentity, operation: () => Promise<T>, draft?: SessionRecord,
    owner?: { ownerPid: number; startedAt: string }, preview = false): Promise<T> {
    return this.attachments.withMetadata(async () => {
      let record: SessionRecord;
      try {
        record = await this.loadAnyUnlocked(identity.sessionId);
      } catch (error) {
        if (!(error instanceof HarnessError && error.code === "SESSION_NOT_FOUND")
          || draft?.revision !== 0 || draft.id !== identity.sessionId) throw error;
        if (await this.attachments.isSessionDeletedUnlocked(identity.sessionId)) throw error;
        record = await this.projectProjection(draft);
      }
      if (record.projectError) throw new HarnessError("PROJECT_UNAVAILABLE", record.projectError);
      if (projectIdOf(record) !== identity.projectId || (record.locationRevision ?? 0) !== identity.locationRevision
        || record.projectRevision !== identity.projectRevision || workspaceKey(record.workspace) !== workspaceKey(identity.workspace)) {
        throw new HarnessError("MEMORY_SCOPE_CHANGED", "The executing session's Memory scope changed. Resume it before continuing.");
      }
      if (owner && (record.attempt?.status !== "running" || record.attempt.ownerPid !== owner.ownerPid
        || record.attempt.startedAt !== owner.startedAt)) {
        throw new HarnessError("MEMORY_SOURCE", "The user turn no longer owns this session's Memory operation.");
      }
      return operation();
    }, false, preview);
  }

  private async loadAnyUnlocked(selector: string): Promise<SessionRecord> {
    if (!sessionIdPattern.test(selector)) {
      const matches = (await this.listAllUnlocked()).filter((item) => item.name === selector || item.title === selector);
      if (!matches.length) throw new HarnessError("SESSION_NOT_FOUND", "No matching session exists. Use /sessions.");
      if (matches.length > 1) throw new HarnessError("SESSION_AMBIGUOUS", "More than one session matches. Resume with the exact session ID.");
      return this.loadAnyUnlocked(matches[0]!.id);
    }
    let selected: SessionRecord | undefined;
    for (const directory of await listSessionDirectories(this.root)) {
      let record: SessionRecord;
      try { record = await this.readDirectory(directory, selector); }
      catch (error) {
        if (error instanceof HarnessError && error.code === "SESSION_NOT_FOUND") continue;
        throw error;
      }
      if (selected) throw new HarnessError("SESSION_AMBIGUOUS", "Duplicate session ID in storage. Resolve the duplicate before continuing.");
      selected = record;
    }
    if (!selected) throw new HarnessError("SESSION_NOT_FOUND", "No matching session exists. Use /sessions.");
    return selected;
  }

  async load(workspace: string, selector: string): Promise<SessionRecord> {
    const canonical = await canonicalWorkspace(workspace);
    return this.attachments.withMetadata(() => this.loadUnlocked(canonical, selector), false);
  }

  private async loadUnlocked(canonical: string, selector: string): Promise<SessionRecord> {
    if (sessionIdPattern.test(selector)) {
      const record = await this.loadAnyUnlocked(selector);
      if (workspaceKey(record.workspace) !== workspaceKey(canonical)) throw new HarnessError("SESSION_NOT_FOUND", "No matching session exists in this workspace.");
      return record;
    }
    const records = (await this.listAllUnlocked()).filter((record) => workspaceKey(record.workspace) === workspaceKey(canonical)
      && (record.name === selector || record.title === selector));
    if (!records.length) throw new HarnessError("SESSION_NOT_FOUND", "No matching session exists in this workspace. Use /sessions.");
    if (records.length > 1) throw new HarnessError("SESSION_AMBIGUOUS", "More than one session matches. Resume with the exact session ID.");
    return this.loadAnyUnlocked(records[0]!.id);
  }

  async save(record: SessionRecord, expectedRevision: number, forkSource?: Pick<SessionRecord, "id" | "revision">,
    options: SessionSaveOptions = {}): Promise<SessionRecord> {
    return this.attachments.withMetadata(() => this.saveWithProject(record, expectedRevision, forkSource, options));
  }

  private async saveWithProject(record: SessionRecord, expectedRevision: number,
    forkSource: Pick<SessionRecord, "id" | "revision"> | undefined, options: SessionSaveOptions): Promise<SessionRecord> {
    const projectId = projectIdOf(record);
    if (projectId) {
      if (record.projectRevision === undefined) throw new HarnessError("PROJECT_CONFLICT", "Refresh the project before saving its session.");
      return this.projects.withProjectUnlocked(projectId, record.projectRevision, async (project) => {
        const workspace = await canonicalWorkspace(project.workspace);
        if (workspaceKey(record.workspace) !== workspaceKey(workspace)) {
          throw new HarnessError("PROJECT_CONFLICT", "The session workspace does not match its project. Refresh it before continuing.");
        }
        return this.saveLocked(record, expectedRevision, forkSource, options, project);
      });
    }
    return this.saveLocked(record, expectedRevision, forkSource, options);
  }

  private async saveLocked(record: SessionRecord, expectedRevision: number,
    forkSource: Pick<SessionRecord, "id" | "revision"> | undefined, options: SessionSaveOptions,
    project?: ProjectRecord): Promise<SessionRecord> {
    const workspace = record.storageWorkspace ?? await canonicalWorkspace(record.workspace);
    if (!sessionIdPattern.test(record.id)) return invalidSession();
    const directory = sessionDirectory(this.root, workspace);
    let release: (() => Promise<void>) | undefined;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      release = await this.lock(directory);
      let previous: SessionRecord | undefined;
      let source: SessionRecord | undefined;
      if (forkSource) {
        if (!sessionIdPattern.test(forkSource.id)) return invalidSession();
        source = await this.read(workspace, forkSource.id);
        if (source.revision !== forkSource.revision) {
          throw new HarnessError("SESSION_CONFLICT", "The source session changed in another process. Resume it again before forking.");
        }
        this.requireAvailable(source);
        if (source.projectError) throw new HarnessError("PROJECT_UNAVAILABLE", source.projectError);
        if (projectIdOf(source) !== projectIdOf(record)) {
          throw new HarnessError("PROJECT_LOCATION", "A fork must retain its source session's project.");
        }
      }
      try { previous = await this.read(workspace, record.id); }
      catch (error) { if (!(error instanceof HarnessError && error.code === "SESSION_NOT_FOUND")) throw error; }
      if ((previous?.revision ?? 0) !== expectedRevision) {
        throw new HarnessError("SESSION_CONFLICT", "The saved session changed in another process. Resume it again or fork before continuing.");
      }
      if (previous) this.requireAvailable(previous, options);
      if (previous && projectIdOf(previous) && projectIdOf(previous) !== projectIdOf(record)) {
        throw new HarnessError("PROJECT_LOCATION", "Leaving or moving between projects is not supported yet.");
      }
      if (record.name && previous?.name !== record.name
        && (await this.records(workspace)).some((item) => item.id !== record.id && item.name === record.name)) {
        throw new HarnessError("SESSION_NAME", "That session name is already used in this workspace. Choose another name.");
      }
      const saved = decodeSessionRecord(encodeSessionRecord({ ...record, revision: expectedRevision + 1,
        storageWorkspace: workspace }), workspace, record.id);
      await this.attachments.publishSession(saved, previous, source, options.attachmentRevisionExpected, options.memoryFingerprintExpected);
      return this.projectProjection(saved, project);
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      throw new HarnessError("SESSION_STORAGE", "Could not save session data. Check the local session directory and available disk space.");
    } finally {
      await release?.();
    }
  }

  /** Remove only an exact workspace ID, optionally publishing an empty replacement first. */
  async delete(workspace: string, id: string, expectedRevision: number, replacement?: SessionRecord): Promise<SessionRecord | undefined> {
    return this.attachments.withMetadata(() => this.deleteWithProject(workspace, id, expectedRevision, replacement));
  }

  private async deleteWithProject(workspace: string, id: string, expectedRevision: number,
    replacement?: SessionRecord): Promise<SessionRecord | undefined> {
    if (!sessionIdPattern.test(id)) throw new HarnessError("SESSION_NOT_FOUND", "No matching session exists in this workspace. Use /sessions.");
    const previous = await this.read(workspace, id);
    const projectId = projectIdOf(previous);
    if (projectId) {
      return this.projects.withProjectUnlocked(projectId, previous.projectRevision,
        () => this.deleteLocked(workspace, id, expectedRevision, replacement));
    }
    return this.deleteLocked(workspace, id, expectedRevision, replacement);
  }

  private async deleteLocked(workspace: string, id: string, expectedRevision: number,
    replacement?: SessionRecord): Promise<SessionRecord | undefined> {
    const canonical = workspace;
    if (!sessionIdPattern.test(id)) throw new HarnessError("SESSION_NOT_FOUND", "No matching session exists in this workspace. Use /sessions.");
    const directory = sessionDirectory(this.root, canonical);
    let release: (() => Promise<void>) | undefined;
    let published: SessionRecord | undefined;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      release = await this.lock(directory);
      const previous = await this.read(canonical, id);
      if (previous.revision !== expectedRevision) {
        throw new HarnessError("SESSION_CONFLICT", "The saved session changed in another process. Refresh it before deleting.");
      }
      this.requireAvailable(previous);
      if (replacement) {
        if (replacement.revision !== 0 || replacement.id === id || !sessionIdPattern.test(replacement.id)
          || workspaceKey(replacement.storageWorkspace ?? replacement.workspace) !== workspaceKey(canonical)
          || replacement.name !== null || replacement.history.length || replacement.attempt !== null) return invalidSession();
        if (projectIdOf(replacement) !== projectIdOf(previous)) {
          throw new HarnessError("PROJECT_LOCATION", "The replacement session must retain the current project.");
        }
        try {
          await this.read(canonical, replacement.id);
          throw new HarnessError("SESSION_CONFLICT", "The replacement session already exists. Try deleting again.");
        } catch (error) {
          if (!(error instanceof HarnessError && error.code === "SESSION_NOT_FOUND")) throw error;
        }
        const projectId = projectIdOf(replacement);
        if (projectId) {
          // A replacement keeps the deleted session's project; this operation never joins another project.
          if (projectId !== projectIdOf(previous) || replacement.projectRevision !== previous.projectRevision
            || replacement.workspace !== previous.workspace || previous.projectError) {
            throw new HarnessError("PROJECT_CONFLICT", "The replacement session must retain the current project and workspace.");
          }
        }
        published = decodeSessionRecord(encodeSessionRecord({ ...replacement, revision: 1,
          storageWorkspace: canonical }), canonical, replacement.id);
      }
      await this.attachments.deleteSession(previous, published);
      return published && this.projectProjection(published);
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      throw new HarnessError("SESSION_STORAGE", "Could not delete session data. Check the local session directory.");
    } finally { await release?.(); }
  }

  private async prepareAttachmentDraft(record: SessionRecord): Promise<SessionRecord> {
    if (record.revision !== 0 || !sessionIdPattern.test(record.id)) return invalidSession();
    try {
      await this.loadAnyUnlocked(record.id);
      throw new HarnessError("SESSION_CONFLICT", "The upload draft was already saved. Refresh the session before continuing.");
    } catch (error) {
      if (!(error instanceof HarnessError && error.code === "SESSION_NOT_FOUND")) throw error;
    }
    const workspace = record.storageWorkspace ?? await canonicalWorkspace(record.workspace);
    const prepare = async (project?: ProjectRecord): Promise<SessionRecord> => {
      const resolved = await canonicalWorkspace(project?.workspace ?? record.workspace);
      if (workspaceKey(resolved) !== workspaceKey(record.workspace) || record.projectError) {
        throw new HarnessError("PROJECT_CONFLICT", "The upload draft's workspace changed. Refresh the session before continuing.");
      }
      if (record.name && (await this.records(workspace)).some((item) => item.name === record.name)) {
        throw new HarnessError("SESSION_NAME", "That session name is already used in this workspace. Choose another name.");
      }
      const saved = decodeSessionRecord(encodeSessionRecord({ ...record, revision: 1,
        storageWorkspace: workspace }), workspace, record.id);
      return this.projectProjection(saved, project);
    };
    const projectId = projectIdOf(record);
    if (!projectId) return prepare();
    if (record.projectRevision === undefined) throw new HarnessError("PROJECT_CONFLICT", "Refresh the project before saving its session.");
    return this.projects.withProjectUnlocked(projectId, record.projectRevision, prepare);
  }

  private async records(workspace: string): Promise<SessionRecord[]> {
    let files: string[];
    try { files = await readdir(sessionDirectory(this.root, workspace)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new HarnessError("SESSION_STORAGE", "Could not list the local session directory.");
    }
    if (files.length > 10000) throw new HarnessError("SESSION_LIMIT", "Too many entries in this workspace's session directory.");
    const records: SessionRecord[] = [];
    for (const file of files.sort()) {
      if (!file.endsWith(".json") || !sessionIdPattern.test(file.slice(0, -5))) continue;
      // A damaged session remains selectable by ID for an explicit diagnostic.
      try { records.push(await this.read(workspace, file.slice(0, -5))); }
      catch (error) { if (!(error instanceof HarnessError && error.code === "SESSION_CORRUPT")) throw error; }
    }
    return records;
  }

  private async read(workspace: string, id: string): Promise<SessionRecord> {
    return this.readDirectory(sessionDirectory(this.root, workspace), id);
  }

  private async readDirectory(directory: string, id: string): Promise<SessionRecord> {
    const record = await readSessionSnapshot(this.root, directory, id);
    return this.projectProjection(record);
  }

  private requireAvailable(record: SessionRecord, options: SessionSaveOptions = {}): void {
    const attempt = record.attempt;
    if (attempt?.status === "running" && processAlive(attempt.ownerPid)
      && (attempt.ownerPid !== process.pid || options.attemptOwner?.ownerPid !== attempt.ownerPid
        || options.attemptOwner.startedAt !== attempt.startedAt)) {
      throw new HarnessError("SESSION_BUSY", "That session has an active turn. Wait for it to finish before managing it.");
    }
    const operation = record.activeOperation;
    if (operation && processAlive(operation.ownerPid) && (operation.ownerPid !== process.pid || options.operationId !== operation.id)) {
      throw new HarnessError("SESSION_BUSY", "That session has an active compaction. Wait for it to finish before managing it.");
    }
  }

  private async projectProjection(record: SessionRecord, project?: ProjectRecord): Promise<SessionRecord> {
    const id = projectIdOf(record);
    if (!id) return structuredClone(record);
    try {
      const selected = project ?? await this.projects.loadUnlocked(id);
      const workspace = await canonicalWorkspace(selected.workspace);
      return { ...structuredClone(record), workspace, projectName: selected.name, projectRevision: selected.revision };
    } catch (error) {
      if (!(error instanceof HarnessError)) throw error;
      return { ...structuredClone(record), workspace: "", projectError: `${error.code}: ${error.message}` };
    }
  }

  private async lock(directory: string): Promise<() => Promise<void>> {
    const path = join(directory, "store.lock");
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const handle = await open(path, "wx", 0o600);
        try { await handle.writeFile(JSON.stringify({ pid: process.pid })); }
        catch (error) { await handle.close(); await unlink(path).catch(() => {}); throw error; }
        return async () => { await handle.close().catch(() => {}); await unlink(path).catch(() => {}); };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let owner: unknown;
        try { owner = JSON.parse(await readFile(path, "utf8")); }
        catch { throw new HarnessError("SESSION_BUSY", "The session store lock is incomplete or still being written. Try again shortly; if its process crashed, remove store.lock only after confirming no session store operation is running."); }
        if (isRecord(owner) && Number.isSafeInteger(owner.pid) && Number(owner.pid) > 0 && !processAlive(Number(owner.pid))) {
          await this.recoverLock(path);
          continue;
        }
        throw new HarnessError("SESSION_BUSY", "The session store is busy in another process. Try again shortly.");
      }
    }
    throw new HarnessError("SESSION_BUSY", "The session store could not be locked. Try again shortly.");
  }

  private async recoverLock(path: string): Promise<void> {
    // Serialize recovery and re-read inside the gate. Two stale readers must
    // never delete a lock that the other reader has already replaced.
    let gate;
    try { gate = await open(`${path}.recovery`, "wx", 0o600); }
    catch { throw new HarnessError("SESSION_BUSY", "Session lock recovery is busy. If a recovery process crashed, remove store.lock.recovery only after confirming no session store operation is running."); }
    try {
      let owner: unknown;
      try { owner = JSON.parse(await readFile(path, "utf8")); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw new HarnessError("SESSION_BUSY", "The session store lock is incomplete. Remove store.lock only after confirming no session store operation is running.");
      }
      if (!isRecord(owner) || !Number.isSafeInteger(owner.pid) || Number(owner.pid) < 1 || processAlive(Number(owner.pid))) {
        throw new HarnessError("SESSION_BUSY", "The session store is busy in another process. Try again shortly.");
      }
      await unlink(path);
    } finally {
      await gate.close().catch(() => {});
      await unlink(`${path}.recovery`).catch(() => {});
    }
  }
}
