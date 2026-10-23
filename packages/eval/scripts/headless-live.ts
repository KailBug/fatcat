import { readFile, unlink } from "node:fs/promises";
import { parseArgs } from "node:util";
import { deepseekPricing } from "../src/deepseek-budget.js";
import { createDeepSeekHeadlessModel } from "../src/deepseek-headless.js";
import { parseHeadlessOptions, runHeadlessSession } from "../src/headless.js";

const { values } = parseArgs({ options: { config: { type: "string" }, "key-file": { type: "string" },
	"prior-cost-nano-cny": { type: "string" } }, strict: true });
if (!values.config || !values["key-file"]) throw new Error("Usage: headless-live --config <options.json> --key-file <temporary-credential-file>");
let apiKey: string;
try {
	apiKey = (await readFile(values["key-file"], "utf8")).trim();
} finally {
	await unlink(values["key-file"]);
}
if (!apiKey) throw new Error("A DeepSeek API key is required.");
const options = parseHeadlessOptions(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readFile(values.config))), "live");
if (new Date(Date.now() + options.durationMs).toISOString().slice(0, 10) !== deepseekPricing.checkedOn) {
	throw new Error("Recheck and update the dated DeepSeek pricing profile before a live run.");
}
const prior = values["prior-cost-nano-cny"] ?? "0";
if (!/^\d+$/.test(prior)) throw new Error("Prior cost must be a decimal integer nanoyuan ceiling.");
const model = createDeepSeekHeadlessModel(options.requests, apiKey, fetch, Number(prior));
const controller = new AbortController();
const abort = () => controller.abort();
process.on("SIGINT", abort);
process.on("SIGTERM", abort);
try {
	const result = await runHeadlessSession(options, model, controller.signal);
	process.stdout.write(JSON.stringify(result) + "\n");
	process.exitCode = result.status === "completed" ? 0 : result.status === "cancelled" ? 130 : 1;
} finally {
	process.off("SIGINT", abort);
	process.off("SIGTERM", abort);
}
