import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { toolCases, runToolCase } from "../src/tool-suite.js";

const [split = "development", output] = process.argv.slice(2);
if (!["development", "holdout", "all"].includes(split) || process.argv.length > 4) throw new Error("Use development|holdout|all [output.json].");
const selected = toolCases.filter((sample) => split === "all" || sample.split === split);
const results = [];
for (const sample of selected) results.push(await runToolCase(sample));
const passed = results.filter((result) => result.passed).length;
const summary = { version: 1, evidence: "injected", level: "contract", policy: "scripted-tools-v1", split,
	code: { commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim(),
		dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", windowsHide: true }).trim()),
		suiteSha256: createHash("sha256").update(await readFile(new URL("../src/tool-suite.js", import.meta.url))).digest("hex") },
	environment: { node: process.version, platform: process.platform, architecture: process.arch },
	planned: selected.length, passed, failed: selected.length - passed, successRate: passed / selected.length,
	notice: "Injected contract baseline; not model tool-selection quality, benchmark performance or token savings. Repeated calls are candidates for review, not proven redundant calls.",
	results };
if (output) await writeFile(resolve(output), JSON.stringify(summary, null, 2), { flag: "wx" });
console.log(JSON.stringify({ ...summary, results: results.map(({ history: _history, traces: _traces, responses: _responses, finalState: _state, report: _report, ...result }) => result) }, null, 2));
process.exitCode = passed === selected.length ? 0 : 1;
