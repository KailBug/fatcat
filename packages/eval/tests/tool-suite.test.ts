import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { toolCases, runToolCase, gradeToolCase } from "../src/tool-suite.js";

for (const sample of toolCases.filter((item) => item.split === "development")) {
	test(`injected tools baseline: ${sample.id}`, async () => {
		const result = await runToolCase(sample);
		assert.equal(result.passed, true, result.failure ?? "No failure detail");
		assert.ok(result.calls > 0);
		assert.ok(result.inputBytes > 0 && result.outputBytes > 0);
		assert.equal(result.report!.tokenUsage.parent.totals, null);
		assert.equal(result.report!.taskVerification, "not_assessed");
	});
}

test("file grader rejects a completion claim or regression despite historical successful execution", async (t) => {
	const sample = toolCases[0];
	const result = await runToolCase(sample);
	assert.equal(result.passed, true, result.failure ?? "No failure detail");
	const workspace = await mkdtemp(join(tmpdir(), "fatcat-grader-control-"));
	t.after(() => rm(workspace, { recursive: true, force: true }));
	await writeFile(join(workspace, "source.txt"), "wrong\n");
	await assert.rejects(gradeToolCase(sample, workspace, [{ role: "assistant", content: "Everything is fixed" }], result.report!, []));
	await writeFile(join(workspace, "source.txt"), "correct\n");
	await gradeToolCase(sample, workspace, [], result.report!, []);
});
