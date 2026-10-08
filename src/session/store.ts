import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, realpath, rename, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { HarnessError } from "../errors.js";
import type { Message } from "../model.js";
import { invalidSession, isRecord, validateHistory } from "./history.js";
import { decodeBoundTasks } from "../automation/tasks.js";
import type { BoundTask } from "../automation/tasks.js";

const maxFileBytes = 64 * 1024 * 1024;
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export type SessionAttempt = {
  prompt: string; startedAt: string; updatedAt: string; ownerPid: number;
  status: "running" | "failed" | "cancelled"; code: string | null; messages: Message[];
};
export type SessionRecord = {
  version: 1; id: string; workspace: string; name: string | null; title: string;
  /** Original storage bucket, retained when the execution workspace changes. */
  storageWorkspace?: string;
  createdAt: string; updatedAt: string; revision: number; forkedFrom: string | null;
  history: Message[]; attempt: SessionAttempt | null;
  automations?: BoundTask[];
};
export type SessionSummary = {
  id: string; workspace: string; name: string | null; title: string;
  createdAt: string; updatedAt: string; revision: number; turnCount: number;
  forkedFrom: string | null; interrupted: boolean;
  automationCount?: number;
};

export function sessionSummary(record: SessionRecord): SessionSummary {
  return { id: record.id, workspace: record.workspace, name: record.name, title: record.title,
    createdAt: record.createdAt, updatedAt: record.updatedAt, revision: record.revision,
    turnCount: record.history.filter((message) => message.role === "user").length,
    forkedFrom: record.forkedFrom, interrupted: record.attempt !== null,
    ...(record.automations?.length ? { automationCount: record.automations.length } : {}) };
}

export function sessionName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 120 || /[\x00-\x1f\x7f]/.test(name)) {
    throw new HarnessError("SESSION_NAME", "Use a non-empty session name of at most 120 characters without control characters.");
  }
  return name;
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

function workspaceKey(workspace: string): string {
  return createHash("sha256").update(process.platform === "win32" ? workspace.toLowerCase() : workspace).digest("hex");
}
function date(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}
function decode(value: unknown, workspace: string, id: string): SessionRecord {
  if (!isRecord(value) || value.version !== 1 || value.id !== id || !idPattern.test(id)
    || typeof value.workspace !== "string"
    || (value.storageWorkspace !== undefined && (typeof value.storageWorkspace !== "string" || !isAbsolute(value.storageWorkspace)))
    || workspaceKey(String(value.storageWorkspace ?? value.workspace)) !== workspaceKey(workspace)
    || !isAbsolute(value.workspace) || (value.name !== null && typeof value.name !== "string")
    || typeof value.title !== "string" || value.title.length > 120 || /[\x00-\x1f\x7f]/.test(value.title)
    || !date(value.createdAt) || !date(value.updatedAt) || !Number.isSafeInteger(value.revision)
    || Number(value.revision) < 1 || (value.forkedFrom !== null && (typeof value.forkedFrom !== "string" || !idPattern.test(value.forkedFrom)))) return invalidSession();
  let name: string | null = null;
  if (value.name !== null) {
    try { name = sessionName(value.name as string); } catch { return invalidSession(); }
    if (name !== value.name) return invalidSession();
  }
  const history = validateHistory(value.history);
  let attempt: SessionAttempt | null = null;
  if (value.attempt !== null) {
    const raw = value.attempt;
    if (!isRecord(raw) || typeof raw.prompt !== "string" || !raw.prompt.trim() || !date(raw.startedAt)
      || !date(raw.updatedAt) || !Number.isSafeInteger(raw.ownerPid) || Number(raw.ownerPid) < 1
      || !["running", "failed", "cancelled"].includes(String(raw.status))
      || (raw.code !== null && (typeof raw.code !== "string" || !/^[A-Z_]{1,80}$/.test(raw.code)))) return invalidSession();
    const messages = validateHistory(raw.messages, false);
    if (messages.length && (messages.length <= history.length
      || JSON.stringify(messages.slice(0, history.length)) !== JSON.stringify(history)
      || messages[history.length || 1]?.role !== "user"
      || messages[history.length || 1]?.content !== raw.prompt
      || messages.filter((message) => message.role === "user").length
        !== history.filter((message) => message.role === "user").length + 1)) return invalidSession();
    attempt = { prompt: raw.prompt, startedAt: raw.startedAt, updatedAt: raw.updatedAt,
      ownerPid: Number(raw.ownerPid), status: raw.status as SessionAttempt["status"],
      code: raw.code as string | null, messages };
  }
  return { version: 1, id, workspace: value.workspace, name, title: value.title, createdAt: value.createdAt,
    ...(value.storageWorkspace === undefined ? {} : { storageWorkspace: String(value.storageWorkspace) }),
    updatedAt: value.updatedAt, revision: Number(value.revision), forkedFrom: value.forkedFrom as string | null,
    history, attempt, ...(value.automations === undefined ? {} : { automations: decodeBoundTasks(value.automations) }) };
}

/** Versioned atomic snapshots; no credentials, permission grants, or live handles. */
export class SessionStore {
  readonly root: string;
  constructor(options: { root?: string } = {}) {
    const root = options.root ?? process.env.FATCAT_SESSION_DIR ?? join(homedir(), ".fatcat", "sessions");
    if (!root.trim()) throw new HarnessError("SESSION_STORAGE", "FATCAT_SESSION_DIR must not be empty.");
    this.root = resolve(root);
  }

  async list(workspace: string): Promise<SessionSummary[]> {
    const canonical = await canonicalWorkspace(workspace);
    return (await this.listAll()).filter((item) => workspaceKey(item.workspace) === workspaceKey(canonical));
  }

  async listAll(): Promise<SessionSummary[]> {
    const summaries: SessionSummary[] = [];
    for (const directory of await this.directories()) {
      for (const file of await readdir(directory)) {
        if (!file.endsWith(".json") || !idPattern.test(file.slice(0, -5))) continue;
        try { summaries.push(sessionSummary(await this.readDirectory(directory, file.slice(0, -5)))); }
        catch (error) {
          if (!(error instanceof HarnessError && ["SESSION_CORRUPT", "SESSION_INVALID", "SESSION_NOT_FOUND"].includes(error.code))) throw error;
        }
      }
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  }

  async loadAny(selector: string): Promise<SessionRecord> {
    if (!idPattern.test(selector)) {
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
    if (idPattern.test(selector)) {
      const record = await this.loadAny(selector);
      if (workspaceKey(record.workspace) !== workspaceKey(canonical)) throw new HarnessError("SESSION_NOT_FOUND", "No matching session exists in this workspace.");
      return record;
    }
    const records = (await this.list(canonical)).filter((record) => record.name === selector || record.title === selector);
    if (!records.length) throw new HarnessError("SESSION_NOT_FOUND", "No matching session exists in this workspace. Use /sessions.");
    if (records.length > 1) throw new HarnessError("SESSION_AMBIGUOUS", "More than one session matches. Resume with the exact session ID.");
    return this.loadAny(records[0]!.id);
  }

  async save(record: SessionRecord, expectedRevision: number, forkSource?: Pick<SessionRecord, "id" | "revision">): Promise<SessionRecord> {
    const workspace = record.storageWorkspace ?? await canonicalWorkspace(record.workspace);
    if (!idPattern.test(record.id)) return invalidSession();
    const directory = this.directory(workspace);
    let release: (() => Promise<void>) | undefined;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      release = await this.lock(directory);
      let previous: SessionRecord | undefined;
      if (forkSource) {
        if (!idPattern.test(forkSource.id)) return invalidSession();
        const source = await this.read(workspace, forkSource.id);
        if (source.revision !== forkSource.revision) {
          throw new HarnessError("SESSION_CONFLICT", "The source session changed in another process. Resume it again before forking.");
        }
        if (source.attempt?.status === "running" && processAlive(source.attempt.ownerPid)) {
          throw new HarnessError("SESSION_BUSY", "That session is running in another process. Wait for it to finish before forking.");
        }
      }
      try { previous = await this.read(workspace, record.id); }
      catch (error) { if (!(error instanceof HarnessError && error.code === "SESSION_NOT_FOUND")) throw error; }
      if ((previous?.revision ?? 0) !== expectedRevision) {
        throw new HarnessError("SESSION_CONFLICT", "The saved session changed in another process. Resume it again or fork before continuing.");
      }
      if (record.name && previous?.name !== record.name
        && (await this.records(workspace)).some((item) => item.id !== record.id && item.name === record.name)) {
        throw new HarnessError("SESSION_NAME", "That session name is already used in this workspace. Choose another name.");
      }
      const saved = decode({ ...record, revision: expectedRevision + 1 }, workspace, record.id);
      await this.publish(directory, saved);
      return structuredClone(saved);
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      throw new HarnessError("SESSION_STORAGE", "Could not save session data. Check the local session directory and available disk space.");
    } finally {
      await release?.();
    }
  }

  /** Remove only an exact workspace ID, optionally publishing an empty replacement first. */
  async delete(workspace: string, id: string, expectedRevision: number, replacement?: SessionRecord): Promise<SessionRecord | undefined> {
    const canonical = workspace;
    if (!idPattern.test(id)) throw new HarnessError("SESSION_NOT_FOUND", "No matching session exists in this workspace. Use /sessions.");
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
      if (previous.attempt?.status === "running" && processAlive(previous.attempt.ownerPid)) {
        throw new HarnessError("SESSION_BUSY", "That session is running in another process. Wait for it to finish before deleting.");
      }
      if (replacement) {
        if (replacement.revision !== 0 || replacement.id === id || !idPattern.test(replacement.id)
          || workspaceKey(replacement.storageWorkspace ?? replacement.workspace) !== workspaceKey(canonical)
          || replacement.name !== null || replacement.history.length || replacement.attempt !== null) return invalidSession();
        try {
          await this.read(canonical, replacement.id);
          throw new HarnessError("SESSION_CONFLICT", "The replacement session already exists. Try deleting again.");
        } catch (error) {
          if (!(error instanceof HarnessError && error.code === "SESSION_NOT_FOUND")) throw error;
        }
        published = decode({ ...replacement, revision: 1 }, canonical, replacement.id);
        await this.publish(directory, published);
      }
      try { await unlink(join(directory, `${id}.json`)); }
      catch (error) {
        if (published) await unlink(join(directory, `${published.id}.json`)).catch(() => {});
        throw error;
      }
      return published && structuredClone(published);
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      throw new HarnessError("SESSION_STORAGE", "Could not delete session data. Check the local session directory.");
    } finally { await release?.(); }
  }

  private async publish(directory: string, record: SessionRecord): Promise<void> {
    const json = JSON.stringify(record);
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
      if (!file.endsWith(".json") || !idPattern.test(file.slice(0, -5))) continue;
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
      if (!isRecord(parsed) || typeof parsed.workspace !== "string") return invalidSession();
      const storageWorkspace = String(parsed.storageWorkspace ?? parsed.workspace);
      if (this.directory(storageWorkspace) !== directory) return invalidSession();
      return decode(parsed, storageWorkspace, id);
    } catch (error) {
      if (error instanceof HarnessError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new HarnessError("SESSION_NOT_FOUND", "No matching session exists in this workspace. Use /sessions.");
      }
      throw new HarnessError("SESSION_STORAGE", "Could not read the saved session.");
    } finally { await handle?.close(); }
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
