import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { HarnessError, checkCancellation } from "../errors.js";
import type { PermissionPolicy } from "./policy.js";

function denied(): never {
  throw new HarnessError("PATH_NOT_ALLOWED", "Use an allowed relative path inside the selected workspace.");
}

function allowedName(name: string): boolean {
  return !name.startsWith(".") && name.toLowerCase() !== "node_modules"
    && !/[<>:"|?*\x00-\x1f]/.test(name) && !/[. ]$/.test(name)
    && !/^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(name);
}

/** Keep one default root while applying the live policy to each filesystem operation. */
export async function createWorkspace(workspace: string, permissionPolicy?: PermissionPolicy) {
  let root: string;
  try {
    if (!workspace.trim()) throw new Error();
    root = await realpath(resolve(workspace));
    if (!(await lstat(root)).isDirectory()) throw new Error();
  } catch {
    throw new HarnessError("CONFIG", "Workspace must be an existing accessible directory.");
  }
  function unrestricted(): boolean { return permissionPolicy?.snapshot().fileAccess === "unrestricted"; }

  async function resolvePath(path: string, signal?: AbortSignal) {
    const lease = permissionPolicy?.beginOperation();
    try { return await resolveExisting(path, signal); }
    finally { lease?.release(); }
  }

  async function resolveExisting(path: string, signal?: AbortSignal) {
    checkCancellation(signal);
    if (unrestricted()) {
      const canonical = await realpath(resolve(root, path));
      const identity = await stat(canonical);
      if (!identity.isFile() && !identity.isDirectory()) {
        throw new HarnessError("UNSUPPORTED_FILE", "Only regular files and directories can be accessed.");
      }
      checkCancellation(signal);
      return { absolute: canonical, relative: canonical, stat: identity, unrestricted: true };
    }
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
    return { absolute: canonical, relative: parts.join("/") || ".", stat: await lstat(canonical), unrestricted: false };
  }

  async function resolveNewFile(path: string, signal?: AbortSignal) {
    const lease = permissionPolicy?.beginOperation();
    try { return await resolveNew(path, signal); }
    finally { lease?.release(); }
  }

  async function resolveNew(path: string, signal?: AbortSignal) {
    checkCancellation(signal);
    if (unrestricted()) {
      const requested = resolve(root, path);
      const parent = await resolveExisting(dirname(requested), signal);
      if (!parent.stat.isDirectory()) {
        throw new HarnessError("UNSUPPORTED_FILE", "A new file requires an existing parent directory.");
      }
      const absolute = join(parent.absolute, basename(requested));
      try { await lstat(absolute); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          checkCancellation(signal);
          return { absolute, relative: absolute, parent, unrestricted: true };
        }
        throw error;
      }
      throw new HarnessError("WRITE_CONFLICT", "The new file already exists; read it and use an exact edit instead.");
    }
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
        return { absolute, relative: [...parts, name].join("/"), parent, unrestricted: false };
      }
      throw error;
    }
    throw new HarnessError("WRITE_CONFLICT", "The new file already exists; read it and use an exact edit instead.");
  }

  return { root, resolvePath, resolveNewFile, permissionPolicy };
}

export type Workspace = Awaited<ReturnType<typeof createWorkspace>>;
