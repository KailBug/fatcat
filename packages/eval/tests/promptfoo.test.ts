import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, it } from "node:test";
import FatcatProvider from "../src/promptfoo-provider.js";
import { deserializeResult } from "../src/result.js";
import { summarizeExperiment } from "../src/summary.js";
import { completion, sessionFixture } from "./fixtures/session.js";

const execute = promisify(execFile);

describe("promptfoo Session provider", () => {
	it("loads the compiled provider through real promptfoo, performs all repetitions and preserves separate grading", async (t) => {
		const config = await sessionFixture(t);
		config.experiment.repetitions = 2;
		const input = join(config.sourceRoot, "runner.json");
		const output = join(config.sourceRoot, "promptfoo-results.json");
		await writeFile(input, JSON.stringify(config));
		const env: NodeJS.ProcessEnv = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (/^(path|systemroot|windir|temp|tmp|comspec|pathext|npm_config_user_agent)$/i.test(key)) env[key] = value;
		}
		Object.assign(env, { PROMPTFOO_CONFIG_DIR: join(config.sourceRoot, "promptfoo-home"), PROMPTFOO_DISABLE_TELEMETRY: "1",
			PROMPTFOO_DISABLE_UPDATE: "1", PROMPTFOO_DISABLE_REMOTE_GENERATION: "1", LOG_LEVEL: "error" });
		await execute(process.execPath, [fileURLToPath(new URL("../../tests/fixtures/promptfoo-run.mjs", import.meta.url)), input, output],
			{ cwd: config.sourceRoot, env, windowsHide: true, timeout: 60000, maxBuffer: 1024 * 1024 });
		const summary = JSON.parse(await readFile(output, "utf8"));
		assert.equal(summary.results.length, 4);
		const records = [];
		for (const row of summary.results) {
			assert.equal(row.response.output, row.vars.sampleId === "read" ? "violet" : "orange");
			assert.equal(row.success, row.vars.sampleId === "read");
			assert.equal(row.response.cached, false);
			const metadata = row.response.metadata;
			const record = deserializeResult(await readFile(join(metadata.artifactDirectory, "result.json"), "utf8"));
			assert.deepEqual(record, metadata.result);
			assert.equal(record.usage.requests, 2);
			records.push(record);
		}
		assert.equal(summarizeExperiment(config.experiment, records).successRate, 0.5);
	});

	it("does not turn unknown usage into zeros, rejects untracked prompts, and forwards cancellation", async (t) => {
		const config = await sessionFixture(t);
		const provider = new FatcatProvider({ config }, { createTransport: () => async () => completion("violet", undefined, null) });
		await assert.rejects(provider.callApi("different instructions", { vars: { sampleId: "read" } }), /sample ID/);
		const response = await provider.callApi("read", { vars: { sampleId: "read" } });
		assert.equal(response.tokenUsage, undefined);
		assert.equal(response.cost, undefined);
		const cancelled = await provider.callApi("other", { vars: { sampleId: "other" } }, { abortSignal: AbortSignal.abort() });
		assert.equal(cancelled.metadata!.result.status, "cancelled");
		assert.equal(cancelled.output, undefined);
		assert.match(cancelled.error!, /CANCELLED/);
	});
});
