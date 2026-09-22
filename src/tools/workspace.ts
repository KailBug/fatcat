import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { HarnessError, checkCancellation } from "../errors.js";

function denied(): never {
  throw new HarnessError("PATH_NOT_ALLOWED", "Use an allowed relative path inside the selected workspace.");
}

function allowedName(name: string): boolean {
  return !name.startsWith(".") && name.toLowerCase() !== "node_modules"
    && !/[<>:"|?*\x00-\x1f]/.test(name) && !/[. ]$/.test(name)
    && !/^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(name);
}

/** Resolve allowed workspace paths without exposing the absolute root to the model. */
export async function createWorkspace(workspace: string) {
  let root: string;
  try {
    if (!workspace.trim()) throw new Error();
    root = await realpath(resolve(workspace));
    if (!(await lstat(root)).isDirectory()) throw new Error();
  } catch {
    throw new HarnessError("CONFIG", "Workspace must be an existing accessible directory.");
  }
  //check the path and permission
  async function resolvePath(path: string, signal?: AbortSignal) {
    if (isAbsolute(path) || win32.isAbsolute(path)) denied();
    const parts = path.replaceAll("\\", "/").split("/").filter((part) => part !== "" && part !== ".");
    if (parts.some((part) => !allowedName(part))) denied();
    let target = root;
    for (const part of ["", ...parts]) {
      checkCancellation(signal);
      if (part) target = join(target, part);
      const stat = await lstat(target);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || (stat.isFile() && stat.nlink > 1)) denied();
    }
    const canonical = await realpath(target);
    const within = relative(root, canonical);
    if (within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) denied();
    // Check canonical names as well, including Windows short-name aliases.
    if (within && within.split(sep).some((part) => !allowedName(part))) denied();
    checkCancellation(signal);
    return { absolute: canonical, relative: parts.join("/") || ".", stat: await lstat(canonical) };
  }

  async function resolveNewFile(path: string, signal?: AbortSignal) {
    if (isAbsolute(path) || win32.isAbsolute(path)) denied();
    const parts = path.replaceAll("\\", "/").split("/").filter((part) => part !== "" && part !== ".");
    if (!parts.length || parts.some((part) => !allowedName(part))) denied();
    const name = parts.pop()!;
    const parent = await resolvePath(parts.join("/") || ".", signal);
    if (!parent.stat.isDirectory()) denied();
    const absolute = join(parent.absolute, name);
    try {
      await lstat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { absolute, relative: [...parts, name].join("/"), parent };
      }
      throw error;
    }
    throw new HarnessError("WRITE_CONFLICT", "The new file already exists; read it and use an exact edit instead.");
  }

  return { resolvePath, resolveNewFile };
}

export type Workspace = Awaited<ReturnType<typeof createWorkspace>>;
