import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseHeadlessOptions, runHeadlessTask } from "../src/headless.js";

const { values } = parseArgs({ options: { config: { type: "string" }, transport: { type: "string" } }, strict: true });
if (!values.config || !values.transport) throw new Error("Usage: headless --config <options.json> --transport <trusted-injected-module.mjs>");
const options = parseHeadlessOptions(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readFile(values.config))));
const injected = await import(pathToFileURL(resolve(values.transport)).href) as { createTransport?: () => typeof fetch };
if (typeof injected.createTransport !== "function") throw new Error("The trusted injection module must export createTransport().");
const controller = new AbortController();
const abort = () => controller.abort();
process.on("SIGINT", abort);
process.on("SIGTERM", abort);
try {
	const result = await runHeadlessTask(options, injected.createTransport, controller.signal);
	process.stdout.write(JSON.stringify(result) + "\n");
	process.exitCode = result.status === "completed" ? 0 : result.status === "cancelled" ? 130 : 1;
} finally {
	process.off("SIGINT", abort);
	process.off("SIGTERM", abort);
}
