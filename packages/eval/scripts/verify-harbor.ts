import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parseHarborTrialResult } from "../src/harbor-result.js";

const { values } = parseArgs({ options: { trial: { type: "string" }, expect: { type: "string" } }, strict: true });
if (!values.trial || !["completed", "failed", "live"].includes(values.expect ?? "")) {
	throw new Error("Usage: verify-harbor --trial <Harbor trial directory> --expect completed|failed|live");
}
const live = values.expect === "live";
const mode = live ? "live" : "injected";
const expectedStatus = live ? "completed" : values.expect;
const root = resolve(values.trial);
const hashes: Record<string, string> = {};
async function read(path: string) {
	const bytes = await readFile(join(root, path));
	hashes[path] = createHash("sha256").update(bytes).digest("hex");
	return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
const raw = JSON.parse(await read("result.json"));
const trial = parseHarborTrialResult(raw);
const result = JSON.parse(await read("agent/fatcat/result.json"));
const evidence = JSON.parse(await read("agent/fatcat/evidence.json"));
assert.equal(trial.agent.name, "fatcat");
assert.deepEqual(trial.agent.model, live ? { name: "deepseek-flash", provider: "deepseek" } : null);
assert.equal(result.evidence, mode);
assert.equal(evidence.evidence, mode);
assert.equal(result.status, expectedStatus);
assert.equal(evidence.status, expectedStatus);
assert.equal(result.cleanup, "removed");
assert.equal(evidence.workspace, "/app");
assert.equal(evidence.platform, "linux");
assert.ok(evidence.session.history.some((message: { role: string }) => message.role === "user")
	|| evidence.session.attempt?.messages?.some((message: { role: string }) => message.role === "user"));
if (!live) assert.deepEqual(trial.usage, { inputTokens: null, cachedInputTokens: null, outputTokens: null, costUsd: null });
if (live) {
	assert.equal(trial.scoring, "scored");
	assert.equal(trial.exception, null);
	assert.ok(trial.rewards?.reward === 0 || trial.rewards?.reward === 1);
	assert.equal(Number((await read("verifier/reward.txt")).trim()), trial.rewards.reward);
	const tests = JSON.parse(await read("verifier/ctrf.json")).results.tests;
	assert.equal(tests.length, 7);
	assert.ok(tests.every((test: { status: string }) => test.status === "passed" || test.status === "failed"));
	assert.equal(tests.every((test: { status: string }) => test.status === "passed"), trial.rewards.reward === 1);
	await read("verifier/test-stdout.txt");
	const ledger = evidence.model;
	assert.equal(ledger.provider, "deepseek");
	assert.equal(ledger.thinking, "high");
	assert.ok(ledger.requests.length > 0 && ledger.requests.length <= ledger.requestLimit && ledger.requestLimit <= 32);
	assert.equal(ledger.requests.length, evidence.requests.length);
	assert.equal(ledger.stoppedReason, null);
	assert.ok(ledger.requests.every((request: { httpStatus: number; responseId: string; responseModel: string }) =>
		request.httpStatus === 200 && request.responseId && request.responseModel));
	assert.ok(ledger.accountedCnyCeiling > 0 && ledger.accountedCnyCeiling <= 10);
	assert.ok(Math.abs(ledger.requests.reduce((sum: number, request: { accountedNanoCny: number }) =>
		sum + request.accountedNanoCny, ledger.priorCostNanoCny) / 1e9 - ledger.accountedCnyCeiling) < 1e-9);
} else if (values.expect === "completed") {
	assert.equal(trial.scoring, "scored");
	assert.equal(trial.exception, null);
	assert.deepEqual(trial.rewards, { reward: 0 });
	assert.equal(evidence.requests.length, 6);
	assert.equal(evidence.writes.length, 2);
	assert.equal(evidence.commands.length, 1);
	assert.equal(evidence.commands[0].exitCode, 0);
	assert.match(evidence.commands[0].stdout, /fatcat-harbor-smoke/);
	assert.equal((await read("verifier/reward.txt")).trim(), "0");
	const tests = JSON.parse(await read("verifier/ctrf.json")).results.tests;
	assert.equal(tests.length, 7);
	assert.deepEqual(tests.filter((test: { status: string }) => test.status === "failed")
		.map((test: { name: string }) => test.name.split("::").at(-1)).sort(), ["test_hidden_exact_match", "test_train_exact_match"]);
	await read("verifier/test-stdout.txt");
} else {
	assert.equal(trial.scoring, "error");
	assert.ok(trial.exception);
	assert.equal(evidence.requests.length, 1);
	assert.equal(evidence.commands.length, 0);
	assert.equal(evidence.session.attempt.status, "failed");
}
await read("agent/console.txt");
await read("agent/input.json");
await read("config.json");
await read("lock.json");
const summary = { evidence: mode, expectation: values.expect, trial: trial.trialName,
	agentStatus: result.status, scoring: trial.scoring, rewards: trial.rewards, exception: trial.exception,
	modelRequestsSentToNetwork: live ? evidence.model.requests.length : 0,
	...(live ? { usage: trial.usage, model: evidence.model } : {}), artifactSha256: hashes };
await writeFile(join(root, live ? "fatcat-live-check.json" : "fatcat-injection-check.json"), JSON.stringify(summary, null, 2) + "\n", { flag: "wx" });
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
