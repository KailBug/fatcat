import { cp, lstat, readdir, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverSkills } from "../src/skills.js";

const project = fileURLToPath(new URL("../../", import.meta.url));
const source = resolve(project, "src", "skill");
const output = resolve(project, "dist", "src", "skill");

async function checkTree(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || stat.nlink > 1 && stat.isFile()) {
      throw new Error("Built-in skill assets must be regular files and directories without links.");
    }
    if (stat.isDirectory()) await checkTree(path);
  }
}

// Validate the source before replacing generated assets; never silently ship a partial catalog.
const catalog = await discoverSkills({ userHome: source, builtinRoot: source });
if (!catalog.skills.length || catalog.warnings.length || catalog.skills.some((skill) => skill.scope !== "builtin")) {
  throw new Error("Built-in skill validation failed. Check SKILL.md metadata, subsystem directories, and catalog limits.");
}
await checkTree(source);

// The only removable tree is this build's dist/src/skill. Refuse redirected ancestors.
const within = relative(project, output);
if (isAbsolute(within) || within.startsWith(`..${sep}`) || within !== join("dist", "src", "skill")) {
  throw new Error("The built-in skill output must stay inside the project build directory.");
}
for (const directory of [project, join(project, "dist"), join(project, "dist", "src"), output]) {
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("The skill build output cannot contain linked directories.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
await rm(output, { recursive: true, force: true });
await cp(source, output, { recursive: true, force: false, errorOnExist: true });
console.log(`Copied ${catalog.skills.length} built-in skills.`);
