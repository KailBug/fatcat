import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { temporaryWorkspace } from "../support/workspace.js";

describe("CLI workspace package", () => {
	it("loads its callable entry without executing argv and rejects undeclared paths", async (t) => {
		const { workspace } = await temporaryWorkspace(t);
		const script = `
			import assert from 'node:assert/strict';
			process.argv = [process.execPath, 'fixture', '--version'];
			const interrupts = process.listenerCount('SIGINT');
			const input = process.stdin.listenerCount('data');
			const cwd = process.cwd();
			globalThis.fetch = async () => { throw new Error('Import must not request a model'); };
			const { runCli } = await import(${JSON.stringify(import.meta.resolve("@fatcat/cli"))});
			assert.equal(typeof runCli, 'function');
			assert.equal(process.exitCode, undefined);
			assert.equal(process.listenerCount('SIGINT'), interrupts);
			assert.equal(process.stdin.listenerCount('data'), input);
			assert.equal(process.cwd(), cwd);
		`;
		assert.equal(execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
			cwd: workspace, encoding: "utf8", windowsHide: true, timeout: 10000,
		}), "");
		for (const entry of ["src/cli.js", "dist/cli.js", "cli/run", "chat", "terminal"]) {
			await assert.rejects(import(`@fatcat/cli/${entry}`), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
		}
	});
});
