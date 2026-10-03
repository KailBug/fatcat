import { createHash } from "node:crypto";
import { mkdir, open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { HarnessError } from "../errors.js";
import { canonicalWorkspace } from "../session/store.js";

/** Fail closed on stale/unknown ownership; never steal a running scheduler's lease. */
export async function acquireAutomationLock(root: string, workspace: string): Promise<() => Promise<void>> {
  const canonical = await canonicalWorkspace(workspace);
  const key = createHash("sha256").update(process.platform === "win32" ? canonical.toLowerCase() : canonical).digest("hex");
  const directory = join(root, "automation-locks");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${key}.lock`);
  let handle;
  try { handle = await open(path, "wx", 0o600); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new HarnessError("AUTOMATION_BUSY", `An automation lock already exists: ${path}. Stop its owner first. After a crash, verify that no runner remains before removing this lock.`);
    }
    throw new HarnessError("AUTOMATION_STORAGE", "Could not acquire the local automation lock.");
  }
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, workspace: canonical })); }
  catch (error) { await handle.close(); await unlink(path); throw error; }
  return async () => { await handle.close(); await unlink(path); };
}
