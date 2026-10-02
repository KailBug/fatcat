import { randomBytes } from "node:crypto";
import { extname } from "node:path";
import { HarnessError, checkCancellation } from "../src/errors.js";
import { createWorkspace } from "../src/permissions/workspace.js";
import { readTextFile } from "../src/permissions/text-file.js";

const extensions = new Set([".html", ".htm", ".svg"]);
const lifetimeMs = 60_000;
const maxSnapshots = 8;
type Snapshot = { content: Buffer; contentType: string; expiresAt: number };

/** Only explicit workspace files become short-lived, single-use frame documents. */
export async function createPreviewStore(root: string) {
  // Preview never inherits Free to go access outside the workspace.
  const workspace = await createWorkspace(root);
  const snapshots = new Map<string, Snapshot>();
  let reading = 0;
  let closed = false;

  function prune(): void {
    for (const [id, snapshot] of snapshots) if (snapshot.expiresAt <= Date.now()) snapshots.delete(id);
  }

  return {
    async prepare(path: string, signal?: AbortSignal) {
      if (!path.trim() || path.length > 1024 || !extensions.has(extname(path).toLowerCase())) {
        throw new HarnessError("PREVIEW_PATH", "Enter a workspace-relative .html, .htm or .svg file path (up to 1024 characters).");
      }
      if (closed) throw new HarnessError("CLOSED", "The local server is shutting down.");
      if (reading >= 4) throw new HarnessError("PREVIEW_BUSY", "Too many preview reads. Try again shortly.");
      reading++;
      try {
        const target = await workspace.resolvePath(path, signal);
        if (!target.stat.isFile()) throw new HarnessError("PREVIEW_PATH", "Select an HTML or SVG file, not a directory.");
        const { bytes } = await readTextFile(target, signal, extensions);
        checkCancellation(signal);
        if (closed) throw new HarnessError("CLOSED", "The local server is shutting down.");
        const id = randomBytes(32).toString("hex");
        prune();
        if (snapshots.size >= maxSnapshots) snapshots.delete(snapshots.keys().next().value!);
        snapshots.set(id, { content: bytes, contentType: extname(target.relative).toLowerCase() === ".svg"
          ? "image/svg+xml; charset=utf-8" : "text/html; charset=utf-8", expiresAt: Date.now() + lifetimeMs });
        return { path: target.relative, url: `/preview/${id}`, bytes: bytes.length };
      } catch (error) {
        if (error instanceof HarnessError) throw error;
        throw new HarnessError("PREVIEW_READ", "The preview file could not be read. Check its workspace-relative path and access permissions.");
      } finally { reading--; }
    },
    take(id: string): Snapshot | undefined {
      prune();
      const snapshot = snapshots.get(id);
      snapshots.delete(id);
      return snapshot;
    },
    close(): void { closed = true; snapshots.clear(); },
  };
}

export function previewCsp(origin: string): string {
  return `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors ${origin}; sandbox allow-scripts`;
}
