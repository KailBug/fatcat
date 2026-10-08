import { opendir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { HarnessError } from "../src/errors.js";
import { canonicalWorkspace } from "../src/session/store.js";

export interface WorkspaceDirectory {
  path: string;
  parent: string;
  home: string;
  roots: string[];
  entries: { name: string; path: string; directory: boolean }[];
  truncated: boolean;
}

/** User-only directory picker. Never exposed to the model or workspace tools. */
export async function listWorkspaceDirectory(path: string, current: string): Promise<WorkspaceDirectory> {
  const canonical = await canonicalWorkspace(resolve(current, path));
  const entries: WorkspaceDirectory["entries"] = [];
  let truncated = false;
  try {
    for await (const entry of await opendir(canonical)) {
      if (entries.length === 1000) { truncated = true; break; }
      entries.push({ name: entry.name, path: join(canonical, entry.name), directory: entry.isDirectory() });
    }
  } catch { throw new HarnessError("SESSION_WORKSPACE", "Could not list this directory. Enter another accessible path."); }
  const roots: string[] = [];
  if (process.platform === "win32") {
    for (const drive of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      const root = `${drive}:\\`;
      if (await stat(root).then((info) => info.isDirectory(), () => false)) roots.push(root);
    }
  } else roots.push("/");
  entries.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  return { path: canonical, parent: dirname(canonical), home: homedir(), roots, entries, truncated };
}
