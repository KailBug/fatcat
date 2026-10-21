import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { HarnessError } from "../errors.js";
import { invalidSession, isRecord } from "./history.js";
import { decodeSessionRecord, encodeSessionRecord, sessionIdPattern, workspaceKey } from "./record.js";
import type { SessionRecord } from "./record.js";

export const maxSessionSnapshotBytes = 64 * 1024 * 1024;

export function sessionDirectory(root: string, workspace: string): string {
  return join(root, workspaceKey(workspace));
}

export async function listSessionDirectories(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && /^[a-f0-9]{64}$/.test(entry.name))
      .map((entry) => join(root, entry.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new HarnessError("SESSION_STORAGE", "Could not list the local session directory.");
  }
}

/** Read the stored record only; effective project state is resolved by SessionStore. */
export async function readSessionSnapshot(root: string, directory: string, id: string): Promise<SessionRecord> {
  let handle;
  try {
    handle = await open(join(directory, `${id}.json`), "r");
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxSessionSnapshotBytes) return invalidSession();
    // Read a bounded buffer even if another writer changes the file after stat.
    const bytes = Buffer.alloc(Math.min(info.size + 1, maxSessionSnapshotBytes + 1));
    let count = 0;
    while (count < bytes.length) {
      const next = await handle.read(bytes, count, bytes.length - count, count);
      if (!next.bytesRead) break;
      count += next.bytesRead;
    }
    if (count > maxSessionSnapshotBytes || count !== info.size) return invalidSession();
    const json = bytes.subarray(0, count).toString("utf8");
    if (!Buffer.from(json, "utf8").equals(bytes.subarray(0, count))) return invalidSession();
    let parsed: unknown;
    try { parsed = JSON.parse(json); } catch { return invalidSession(); }
    if (!isRecord(parsed) || typeof parsed.storageWorkspace !== "string") return invalidSession();
    const storageWorkspace = parsed.storageWorkspace;
    if (sessionDirectory(root, storageWorkspace) !== directory) return invalidSession();
    return decodeSessionRecord(parsed, storageWorkspace, id);
  } catch (error) {
    if (error instanceof HarnessError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new HarnessError("SESSION_NOT_FOUND", "No matching session exists in this workspace. Use /sessions.");
    }
    throw new HarnessError("SESSION_STORAGE", "Could not read the saved session.");
  } finally { await handle?.close(); }
}

/** File publication only; callers retain validation, locks and transaction recovery. */
export async function publishSessionSnapshot(root: string, record: SessionRecord): Promise<void> {
  const directory = sessionDirectory(root, record.storageWorkspace ?? record.workspace);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const json = JSON.stringify(encodeSessionRecord(record));
  if (Buffer.byteLength(json) > maxSessionSnapshotBytes) throw new HarnessError("SESSION_LIMIT", "Session data exceeds the 64 MiB storage limit. Start a new session.");
  const temporary = join(directory, `${record.id}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(json, "utf8"); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, join(directory, `${record.id}.json`));
  } finally { await unlink(temporary).catch(() => {}); }
}

export async function removeSessionSnapshot(root: string, workspace: string, id: string): Promise<void> {
  if (!sessionIdPattern.test(id)) return invalidSession();
  await unlink(join(sessionDirectory(root, workspace), `${id}.json`)).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
}
