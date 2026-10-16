import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { temporaryWorkspace } from "../support/workspace.js";

async function setup(t: TestContext) {
	const { workspace, outside } = await temporaryWorkspace(t);
	const root = join(workspace, "project with spaces");
	const launcher = join(root, "dist", "scripts", "test.js");
	await mkdir(join(root, "dist", "scripts"), { recursive: true });
	await copyFile(new URL("../../scripts/test.js", import.meta.url), launcher);
	await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
	async function write(path: string, content = "") {
		const file = join(root, path);
		await mkdir(join(file, ".."), { recursive: true });
		await writeFile(file, content);
	}
	function run() {
		return spawnSync(process.execPath, [launcher], {
			cwd: outside, encoding: "utf8", timeout: 15000, windowsHide: true,
			env: { ...process.env, NODE_TEST_CONTEXT: undefined },
		});
	}
	return { write, run };
}

test("offline runner selects current nested sources and ignores obsolete outputs and support scripts", async (t) => {
	const { write, run } = await setup(t);
	await write("tests/area/current.test.ts");
	await write("tests/area/nested/second.test.ts");
	await write("dist/tests/area/current.test.js", 'console.log("CURRENT_TEST");');
	await write("dist/tests/area/nested/second.test.js", 'console.log("NESTED_TEST");');
	for (const path of ["dist/tests/obsolete.test.js", "dist/tests/area/obsolete.test.js",
		"dist/tests/area/support/helper.js", "dist/scripts/verify/live/verify-live.js"]) {
		await write(path, 'throw new Error("UNEXPECTED_EXECUTION");');
	}
	await write("tests/area/support/helper.ts");
	const result = run();
	assert.equal(result.status, 0, result.stdout + result.stderr);
	assert.match(result.stdout, /CURRENT_TEST/);
	assert.match(result.stdout, /NESTED_TEST/);
	assert.doesNotMatch(result.stdout + result.stderr, /UNEXPECTED_EXECUTION/);
});

test("offline runner rejects missing compiled tests before executing any tests", async (t) => {
	const { write, run } = await setup(t);
	await write("tests/area/current.test.ts");
	await write("tests/area/missing.test.ts");
	await write("dist/tests/area/current.test.js", 'console.log("MUST_NOT_RUN");');
	const result = run();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /Missing compiled test:.*missing\.test\.js/);
	assert.doesNotMatch(result.stdout, /MUST_NOT_RUN/);
});

test("offline runner rejects an empty source inventory instead of falling back to automatic discovery", async (t) => {
	const { write, run } = await setup(t);
	await write("dist/tests/obsolete.test.js", 'console.log("MUST_NOT_RUN");');
	const result = run();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /No offline test sources found/);
	assert.doesNotMatch(result.stdout, /MUST_NOT_RUN/);
});

test("offline runner preserves a failing test exit status", async (t) => {
	const { write, run } = await setup(t);
	await write("tests/area/failing.test.ts");
	await write("dist/tests/area/failing.test.js", 'throw new Error("EXPECTED_FAILURE");');
	const result = run();
	assert.equal(result.status, 1);
	assert.match(result.stdout + result.stderr, /EXPECTED_FAILURE/);
});
