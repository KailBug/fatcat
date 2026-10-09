import { readFileSync } from "node:fs";

// Compiled modules live in dist/src; the repository manifest owns the version.
const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

export const VERSION: string = packageJson.version;
