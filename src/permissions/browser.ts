import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { extname, relative } from "node:path";
import { checkCancellation, HarnessError } from "../errors.js";
import type { Workspace } from "./workspace.js";
import type { ApproveBrowser, PermissionState } from "./types.js";
import type { BrowserRequest } from "../browser/protocol.js";

export const browserMime = new Map(Object.entries({ ".html": "text/html", ".htm": "text/html", ".svg": "image/svg+xml",
  ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".txt": "text/plain",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2" }));

export async function authorizeBrowser(state: PermissionState, request: BrowserRequest, approve?: ApproveBrowser, signal?: AbortSignal): Promise<void> {
  checkCancellation(signal);
  if (state.permission === "read-only" || state.shellPermission === "deny") {
    throw new HarnessError("PERMISSION_DENIED", "Browser execution is disabled by read-only, Plan or shell-deny permissions.");
  }
  if (state.shellPermission === "ask") {
    if (!approve) throw new HarnessError("PERMISSION_DENIED", "Browser execution requires interactive approval or explicit shell execution permission.");
    const allowed = await approve(structuredClone(request), signal);
    checkCancellation(signal);
    if (!allowed) throw new HarnessError("PERMISSION_DENIED", "Browser execution was denied.");
  }
}

/** Read only regular, bounded workspace assets, even when other tools use Free to go. */
export async function readBrowserFile(workspace: Workspace, path: string, signal?: AbortSignal, limit = 2 * 1024 * 1024) {
  checkCancellation(signal);
  const target = await workspace.resolvePath(path, signal);
  const type = browserMime.get(extname(target.absolute).toLowerCase());
  if (!type || !target.stat.isFile()) throw new HarnessError("BROWSER_FILE", "Only supported workspace page assets can be opened.");
  const file = await open(target.absolute, "r");
  try {
    const identity = await file.stat();
    if (!identity.isFile() || identity.nlink > 1 || identity.dev !== target.stat.dev || identity.ino !== target.stat.ino) {
      throw new HarnessError("PATH_NOT_ALLOWED", "The browser asset changed during path validation.");
    }
    if (identity.size > limit) throw new HarnessError("BROWSER_FILE_LIMIT", "The browser asset exceeds its byte limit.");
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      checkCancellation(signal);
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    checkCancellation(signal);
    if (size > limit) throw new HarnessError("BROWSER_FILE_LIMIT", "The browser asset exceeds its byte limit.");
    const bytes = Buffer.from(buffer.subarray(0, size));
    if (type.startsWith("text/") || type === "image/svg+xml" || type === "application/json") {
      try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
      catch { throw new HarnessError("BROWSER_FILE", "Browser text assets must be UTF-8."); }
    }
    return { path: relative(workspace.root, target.absolute).replaceAll("\\", "/"), type, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
  } finally { await file.close(); }
}
