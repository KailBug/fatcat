import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runHeadlessTask } from "../src/headless.js";
import { createTransport } from "./fixtures/harbor-smoke.js";
import { createTransport as failureTransport } from "./fixtures/harbor-failure.js";

test("Harbor injection runs actual tools and retains a deliberately incorrect submission", async (t) => {
	const root = await mkdtemp(join(tmpdir(), "fatcat-harbor-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const task = join(root, "task with spaces");
	await mkdir(join(task, "data"), { recursive: true });
	await writeFile(join(task, "data/train.tsv"), "sample\tchanged\n");
	const options = { taskCwd: task, instruction: "Original task 'quotes'\nsecond line", resultDirectory: join(root, "result"),
		permission: { files: "workspace-write" as const, shell: "allow" as const }, requests: 8, durationMs: 30000 };
	const result = await runHeadlessTask(options, createTransport);
	assert.equal(result.status, "completed");
	assert.equal(result.cleanup, "removed");
	assert.equal(await readFile(join(task, "ordering.txt"), "utf8"), "injected-identity\n");
	const evidence = JSON.parse(await readFile(result.evidenceFile, "utf8"));
	assert.equal(evidence.options.instruction, options.instruction);
	assert.equal(evidence.requests.length, 6);
	assert.equal(evidence.writes.length, 2);
	assert.equal(evidence.commands.length, 1);
	assert.equal(evidence.commands[0].exitCode, 0);
	assert.match(evidence.commands[0].stdout, /fatcat-harbor-smoke/);
	await assert.rejects(access(evidence.temporaryRoot), { code: "ENOENT" });
	const failed = await runHeadlessTask({ ...options, resultDirectory: join(root, "failed") }, failureTransport);
	assert.equal(failed.status, "failed");
	assert.equal(failed.cleanup, "removed");
	const interrupted = JSON.parse(await readFile(failed.evidenceFile, "utf8"));
	assert.equal(interrupted.requests.length, 1);
	assert.equal(interrupted.session.attempt.status, "failed");
});
