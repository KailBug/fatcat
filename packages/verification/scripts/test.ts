import { spawnSync } from "node:child_process";
import { globSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const project = fileURLToPath(new URL("../../", import.meta.url));
const sources = globSync("tests/**/*.test.ts", { cwd: project }).sort();
if (sources.length === 0) throw new Error("No offline test sources found.");

// Select current sources so outputs left by a move or branch switch cannot run.
const files = sources.map((source) => join(project, "dist", source.replace(/\.ts$/, ".js")));
for (const file of files) {
	if (!statSync(file, { throwIfNoEntry: false })?.isFile()) {
		throw new Error(`Missing compiled test: ${file}. Run pnpm run build first.`);
	}
}

const result = spawnSync(process.execPath, ["--test", ...process.argv.slice(2), ...files], {
	cwd: project,
	stdio: "inherit",
	windowsHide: true,
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
