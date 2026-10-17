import { readFileSync } from "node:fs";

// Resolve the installed CLI manifest independently of the launch directory.
const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

export const VERSION: string = packageJson.version;
