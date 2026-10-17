import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { temporaryWorkspace } from "../support/workspace.js";

describe("runtime workspace package", () => {
	it("loads every declared host entry and rejects source and build-directory imports", async () => {
		const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.resolve("@fatcat/runtime/agent")), "utf8")) as {
			exports: Record<string, { types: string; import: string }>;
		};
		for (const subpath of Object.keys(manifest.exports).filter((entry) => !entry.includes("*"))) {
			const name = `@fatcat/runtime/${subpath.slice(2)}`;
			await import(name);
		}
		for (const name of ["@fatcat/runtime/src/agent.js", "@fatcat/runtime/dist/agent.js", "@fatcat/runtime/cli"]) {
			await assert.rejects(import(name), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
		}
	});

	it("runs from an unrelated working directory with package-local built-in skills", async (t) => {
		const { workspace } = await temporaryWorkspace(t);
		const script = `
			import assert from 'node:assert/strict';
			import { createAgent } from ${JSON.stringify(import.meta.resolve("@fatcat/runtime/agent"))};
			import { Session } from ${JSON.stringify(import.meta.resolve("@fatcat/runtime/session/session"))};
			import { discoverSkills } from ${JSON.stringify(import.meta.resolve("@fatcat/runtime/skills"))};
			const catalog = await discoverSkills({ userHome: process.cwd() });
			assert.equal(catalog.skills.filter(skill => skill.scope === 'builtin').length, 7);
			assert.deepEqual(catalog.warnings, []);
			const agent = createAgent({ provider: 'deepseek', region: 'global', apiKey: 'offline-package-only',
				model: 'deepseek-flash', requestTimeoutMs: 1000, maxIterations: 1, maxRequestBytes: 262144 },
				undefined, async () => Response.json({ choices: [{ finish_reason: 'stop',
					message: { role: 'assistant', content: 'Package execution verified' } }] }));
			const session = new Session(agent);
			assert.equal(await session.run('Package smoke'), 'Package execution verified');
			console.log('runtime-package-ok');
		`;
		assert.equal(execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
			cwd: workspace, encoding: "utf8", windowsHide: true, timeout: 15000,
		}).trim(), "runtime-package-ok");
	});
});
