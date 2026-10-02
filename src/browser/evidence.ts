import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { HarnessError } from "../errors.js";
import { createWorkspace } from "../permissions/workspace.js";
import { readBrowserFile } from "../permissions/browser.js";

export const evidenceDirectory = "fatcat-browser-evidence";
export const evidenceId = /^[a-f0-9]{32}$/;
const maxEvidenceBytes = 8 * 1024 * 1024;

/** Generated evidence never overwrites files and can only be addressed by an opaque run ID. */
export async function saveBrowserEvidence(root: string, id: string, report: unknown, png?: Buffer) {
  if (!evidenceId.test(id)) throw new HarnessError("BROWSER_EVIDENCE", "Invalid evidence ID.");
  const scope = await createWorkspace(root);
  const candidate = join(scope.root, evidenceDirectory);
  try { await mkdir(candidate); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const directory = await scope.resolvePath(evidenceDirectory);
  if (!directory.stat.isDirectory()) throw new HarnessError("BROWSER_EVIDENCE", "The evidence directory is unavailable.");
  async function publish(extension: string, bytes: Buffer): Promise<string> {
    if (bytes.length > maxEvidenceBytes) throw new HarnessError("BROWSER_EVIDENCE", "Browser evidence exceeds 8 MiB.");
    const path = `${evidenceDirectory}/${id}.${extension}`;
    const target = await scope.resolveNewFile(path);
    const file = await open(target.absolute, "wx", 0o600);
    try { await file.writeFile(bytes); await file.sync(); }
    finally { await file.close(); }
    return path;
  }
  const screenshotPath = png ? await publish("png", png) : null;
  const reportPath = await publish("json", Buffer.from(JSON.stringify(report, null, 2), "utf8"));
  return { reportPath, screenshotPath };
}

export async function readBrowserEvidence(root: string, id: string, kind: "report" | "screenshot") {
  if (!evidenceId.test(id)) throw new HarnessError("BROWSER_EVIDENCE", "Invalid evidence ID.");
  const scope = await createWorkspace(root);
  return readBrowserFile(scope, `${evidenceDirectory}/${id}.${kind === "report" ? "json" : "png"}`, undefined, maxEvidenceBytes);
}
