import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";

async function directory(t: TestContext) {
	const root = await mkdtemp(join(tmpdir(), "fatcat-eval-package-"));
	const workspace = join(root, "project with spaces");
	await mkdir(workspace);
	t.after(() => rm(root, { recursive: true, force: true }));
	async function write(path: string, content: string) {
		const file = join(workspace, path);
		await mkdir(join(file, ".."), { recursive: true });
		await writeFile(file, content);
	}
	function run(path: string) {
		return spawnSync(process.execPath, [join(workspace, path)], {
			cwd: root, encoding: "utf8", timeout: 15000, windowsHide: true,
			env: { ...process.env, NODE_TEST_CONTEXT: undefined },
		});
	}
	return { workspace, write, run };
}

describe("eval package integration", () => {
	it("selects source tests from an unrelated directory and fails on missing, empty or failed tests", async (t) => {
		const { workspace, write, run } = await directory(t);
		await write("package.json", '{"type":"module"}');
		await write("dist/scripts/test.js", "");
		await copyFile(new URL("../scripts/test.js", import.meta.url), join(workspace, "dist/scripts/test.js"));
		await write("dist/tests/obsolete.test.js", 'throw new Error("STALE_OUTPUT");');
		assert.match(run("dist/scripts/test.js").stderr, /No eval test sources/);
		await write("tests/nested/current.test.ts", "");
		assert.match(run("dist/scripts/test.js").stderr, /Missing compiled test/);
		await write("dist/tests/nested/current.test.js", 'console.log("CURRENT_TEST");');
		const passed = run("dist/scripts/test.js");
		assert.equal(passed.status, 0, passed.stdout + passed.stderr);
		assert.match(passed.stdout, /CURRENT_TEST/);
		assert.doesNotMatch(passed.stdout + passed.stderr, /STALE_OUTPUT/);
		await write("dist/tests/nested/current.test.js", 'throw new Error("EXPECTED_FAILURE");');
		assert.equal(run("dist/scripts/test.js").status, 1);
	});

	it("checks eval tests and scripts, blocks product dependencies on eval and keeps internal imports verification-only", async (t) => {
		const { workspace, write, run } = await directory(t);
		await write("package.json", '{"version":"0.1.0","type":"module","devDependencies":{}}');
		await write("scripts/check-packages.mjs", await readFile(new URL("../../../../scripts/check-packages.mjs", import.meta.url), "utf8"));
		for (const name of ["runtime", "commands", "tui", "webui", "cli", "verification", "eval"]) {
			const directories = name === "verification" ? ["tests", "verify", "scripts"] : name === "eval" ? ["src", "tests", "scripts"] : ["src"];
			for (const path of directories) await mkdir(join(workspace, "packages", name, path), { recursive: true });
			await write(`packages/${name}/package.json`, JSON.stringify({ name: `@fatcat/${name}`, version: "0.1.0", exports: {}, devDependencies: {} }));
		}
		assert.equal(run("scripts/check-packages.mjs").status, 0);
		await write("packages/runtime/package.json", JSON.stringify({ name: "@fatcat/runtime", exports: {}, devDependencies: { "@fatcat/eval": "workspace:*" } }));
		assert.match(run("scripts/check-packages.mjs").stderr, /Workspace dependency direction/);
		await write("packages/runtime/package.json", JSON.stringify({
			name: "@fatcat/runtime",
			exports: {
				"./session/manager": {
					types: "./dist/session/manager.d.ts",
					import: "./dist/session/manager.js",
				},
				"./internal/*": {
					types: "./dist/*.d.ts",
					import: "./dist/*.js",
				},
			},
		}));
		await write("packages/eval/package.json", JSON.stringify({
			name: "@fatcat/eval",
			exports: {},
			dependencies: {
				"@fatcat/runtime": "workspace:*",
			},
		}));
		await write(
			"packages/eval/tests/boundary.test.ts",
			'import "@fatcat/runtime/session/manager";',
		);
		const publicImport = run("scripts/check-packages.mjs");
		assert.equal(publicImport.status, 0, publicImport.stdout + publicImport.stderr);
		await write("packages/eval/tests/boundary.test.ts", 'import "@fatcat/runtime/internal/model";');
		assert.match(run("scripts/check-packages.mjs").stderr, /Internal package subpaths are for verification only/);
		await write("packages/eval/tests/boundary.test.ts", 'import "undeclared-dependency";');
		assert.match(run("scripts/check-packages.mjs").stderr, /direct dependency/);
		await write("packages/eval/tests/boundary.test.ts", "");
		await write("packages/eval/scripts/run.ts", 'import "../../runtime/src/model.js";');
		assert.match(run("scripts/check-packages.mjs").stderr, /Package-relative imports/);
	});
});
