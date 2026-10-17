import { createHash } from "node:crypto";
import { extname } from "node:path";
import { HarnessError } from "../errors.js";
import { readTextFile, textExtensions } from "../permissions/text-file.js";
import { createWorkspace } from "../permissions/workspace.js";
import type { Workspace } from "../permissions/workspace.js";

/** Poll explicit text files so editor rename/replacement saves do not lose a watcher. */
export class FileChanges {
  private baseline = new Map<string, string>();
  private constructor(private readonly access: Workspace, private readonly paths: readonly string[]) {}

  static async open(workspace: string, paths: readonly string[], signal?: AbortSignal) {
    if (paths.some((path) => !textExtensions.has(extname(path).toLowerCase()))) {
      throw new HarnessError("AUTOMATION_CONFIG", "Watch paths must use supported text file extensions.");
    }
    const monitor = new FileChanges(await createWorkspace(workspace), [...new Set(paths)]);
    await monitor.poll(signal);
    return monitor;
  }

  async poll(signal?: AbortSignal): Promise<string[]> {
    const next = new Map<string, string>();
    for (const path of this.paths) next.set(path, await this.fingerprint(path, signal));
    const changed = [...next].filter(([path, value]) => this.baseline.has(path) && this.baseline.get(path) !== value)
      .map(([path]) => path);
    this.baseline = next;
    return changed;
  }

  private async fingerprint(path: string, signal?: AbortSignal): Promise<string> {
    try {
      const target = await this.access.resolvePath(path, signal);
      if (!target.stat.isFile()) throw new HarnessError("AUTOMATION_CONFIG", "Watch paths must identify text files, not directories.");
      const { bytes } = await readTextFile(target, signal);
      return createHash("sha256").update(bytes).digest("hex");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // Missing files are allowed only under an existing, independently validated parent.
      await this.access.resolveNewFile(path, signal);
      return "missing";
    }
  }
}
