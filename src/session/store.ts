import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, realpath, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { HarnessError } from "../errors.js";
import { ProjectStore } from "../project/store.js";
import type { ProjectRecord } from "../project/record.js";
import { invalidSession, isRecord } from "./history.js";
import { decodeSessionRecord, encodeSessionRecord, projectIdOf, sessionIdPattern, sessionSummary, workspaceKey } from "./record.js";
import type { SessionRecord, SessionSummary } from "./record.js";

const maxFileBytes = 64 * 1024 * 1024;

export interface SessionSaveOptions {
  attemptOwner?: { ownerPid: number; startedAt: string };
  operationId?: string;
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
  constructor(options: { root?: string } = {}) {
    const root = options.root ?? process.env.FATCAT_SESSION_DIR ?? join(homedir(), ".fatcat", "sessions");
    if (!root.trim()) throw new HarnessError("SESSION_STORAGE", "FATCAT_SESSION_DIR must not be empty.");
    this.root = resolve(root);
    this.projects = new ProjectStore({ root: this.root });
  }

  async list(workspace: string): Promise<SessionSummary[]> {
    const canonical = await canonicalWorkspace(workspace);
    return (await this.listAll()).filter((item) => workspaceKey(item.workspace) === workspaceKey(canonical));
  }

  async listAll(): Promise<SessionSummary[]> {
    const summaries: SessionSummary[] = [];
    for (const directory of await this.directories()) {
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
    if (!sessionIdPattern.test(selector)) {
      const matches = (await this.listAll()).filter((item) => item.name === selector || item.title === selector);
      if (!matches.length) throw new HarnessError("SESSION_NOT_FOUND", "No matching session exists. Use /sessions.");
      if (matches.length > 1) throw new HarnessError("SESSION_AMBIGUOUS", "More than one session matches. Resume with the exact session ID.");
      return this.loadAny(matches[0]!.id);
    }
    let selected: SessionRecord | undefined;
    for (const directory of await this.directories()) {
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

  private async directories(): Promise<string[]> {
    try {
      const entries = await readdir(this.root, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))
        .map((entry) => join(this.root, entry.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new HarnessError("SESSION_STORAGE", "Could not list the local session directory.");
    }
  }

  async load(workspace: string, selector: string): Promise<SessionRecord> {
    const canonical = await canonicalWorkspace(workspace);
    if (sessionIdPattern.test(selector)) {
      const record = await this.loadAny(selector);
      if (workspaceKey(record.workspace) !== workspaceKey(canonical)) throw new HarnessError("SESSION_NOT_FOUND", "No matching session exists in this workspace.");
      return record;
    }
    const records = (await this.list(canonical)).filter((record) => record.name === selector || record.title === selector);
    if (!records.length) throw new HarnessError("SESSION_NOT_FOUND", "No matching session exists in this workspace. Use /sessions.");
    if (records.length > 1) throw new HarnessError("SESSION_AMBIGUOUS", "More than one session matches. Resume with the exact session ID.");
    return this.loadAny(records[0]!.id);
  }

  async save(record: SessionRecord, expectedRevision: number, forkSource?: Pick<SessionRecord, "id" | "revision">,
    options: SessionSaveOptions = {}): Promise<SessionRecord> {
    const projectId = projectIdOf(record);
    if (projectId) {
      if (record.projectRevision === undefined) throw new HarnessError("PROJECT_CONFLICT", "Refresh the project before saving its session.");
      return this.projects.withProject(projectId, record.projectRevision, async (project) => {
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
    const directory = this.directory(workspace);
    let release: (() => Promise<void>) | undefined;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      release = await this.lock(directory);
      let previous: SessionRecord | undefined;
      if (forkSource) {
        if (!sessionIdPattern.test(forkSource.id)) return invalidSession();
        const source = await this.read(workspace, forkSource.id);
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
      await this.publish(directory, saved);
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
    if (!sessionIdPattern.test(id)) throw new HarnessError("SESSION_NOT_FOUND", "No matching session exists in this workspace. Use /sessions.");
    const previous = await this.read(workspace, id);
    const projectId = projectIdOf(previous);
    if (projectId) {
      return this.projects.withProject(projectId, previous.projectRevision,
        () => this.deleteLocked(workspace, id, expectedRevision, replacement));
    }
    return this.deleteLocked(workspace, id, expectedRevision, replacement);
  }

  private async deleteLocked(workspace: string, id: string, expectedRevision: number,
    replacement?: SessionRecord): Promise<SessionRecord | undefined> {
    const canonical = workspace;
    if (!sessionIdPattern.test(id)) throw new HarnessError("SESSION_NOT_FOUND", "No matching session exists in this workspace. Use /sessions.");
    const directory = this.directory(canonical);
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
        await this.publish(directory, published);
      }
      try { await unlink(join(directory, `${id}.json`)); }
      catch (error) {
        if (published) await unlink(join(directory, `${published.id}.json`)).catch(() => {});
        throw error;
      }
      return published && this.projectProjection(published);
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      throw new HarnessError("SESSION_STORAGE", "Could not delete session data. Check the local session directory.");
    } finally { await release?.(); }
  }

  private async publish(directory: string, record: SessionRecord): Promise<void> {
    const json = JSON.stringify(encodeSessionRecord(record));
    if (Buffer.byteLength(json) > maxFileBytes) throw new HarnessError("SESSION_LIMIT", "Session data exceeds the 64 MiB storage limit. Start a new session.");
    const temporary = join(directory, `${record.id}.${randomUUID()}.tmp`);
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(json, "utf8"); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, join(directory, `${record.id}.json`));
    } finally { await unlink(temporary).catch(() => {}); }
  }

  private directory(workspace: string): string { return join(this.root, workspaceKey(workspace)); }

  private async records(workspace: string): Promise<SessionRecord[]> {
    let files: string[];
    try { files = await readdir(this.directory(workspace)); }
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
    return this.readDirectory(this.directory(workspace), id);
  }

  private async readDirectory(directory: string, id: string): Promise<SessionRecord> {
    let handle;
    try {
      handle = await open(join(directory, `${id}.json`), "r");
      const info = await handle.stat();
      if (!info.isFile() || info.size > maxFileBytes) return invalidSession();
      // Read a bounded buffer even if another writer changes the file after stat.
      const bytes = Buffer.alloc(Math.min(info.size + 1, maxFileBytes + 1));
      let count = 0;
      while (count < bytes.length) {
        const next = await handle.read(bytes, count, bytes.length - count, count);
        if (!next.bytesRead) break;
        count += next.bytesRead;
      }
      if (count > maxFileBytes || count !== info.size) return invalidSession();
      const json = bytes.subarray(0, count).toString("utf8");
      if (!Buffer.from(json, "utf8").equals(bytes.subarray(0, count))) return invalidSession();
      let parsed: unknown;
      try { parsed = JSON.parse(json); } catch { return invalidSession(); }
      if (!isRecord(parsed) || (parsed.version === 1 ? typeof parsed.workspace !== "string" : typeof parsed.storageWorkspace !== "string")) return invalidSession();
      const storageWorkspace = String(parsed.storageWorkspace ?? parsed.workspace);
      if (this.directory(storageWorkspace) !== directory) return invalidSession();
      return this.projectProjection(decodeSessionRecord(parsed, storageWorkspace, id));
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new HarnessError("SESSION_NOT_FOUND", "No matching session exists in this workspace. Use /sessions.");
      }
      throw new HarnessError("SESSION_STORAGE", "Could not read the saved session.");
    } finally { await handle?.close(); }
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
      const selected = project ?? await this.projects.load(id);
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
