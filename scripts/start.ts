import { isAbsolute } from "node:path";
import { HarnessError, formatError } from "../src/errors.js";

// pnpm runs scripts in the package root; restore the caller's directory only here.
// Node has already loaded the package-root .env before this module executes.
try {
  const launchDirectory = process.env.INIT_CWD;
  if (launchDirectory?.trim()) {
    if (!isAbsolute(launchDirectory)) throw new Error();
    process.chdir(launchDirectory);
  }
} catch {
  console.error(formatError(new HarnessError("CONFIG", "The pnpm launch directory must be an existing accessible absolute directory.")));
  process.exitCode = 1;
}

if (process.exitCode !== 1) await import("../src/cli.js");
