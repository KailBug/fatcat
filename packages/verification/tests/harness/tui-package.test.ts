import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { temporaryWorkspace } from "../support/workspace.js";

describe("TUI workspace package", () => {
	it("loads its entry from another directory without taking terminal ownership", async (t) => {
		const { workspace } = await temporaryWorkspace(t);
		const script = `
			import assert from 'node:assert/strict';
			const raw = process.stdin.isRaw;
			const interrupts = process.listenerCount('SIGINT');
			const input = process.stdin.listenerCount('data');
			globalThis.fetch = async () => { throw new Error('Import must not request a model'); };
			const { runTui } = await import(${JSON.stringify(import.meta.resolve("@fatcat/tui"))});
			assert.equal(typeof runTui, 'function');
			assert.equal(process.stdin.isRaw, raw);
			assert.equal(process.listenerCount('SIGINT'), interrupts);
			assert.equal(process.stdin.listenerCount('data'), input);
		`;
		assert.equal(execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
			cwd: workspace, encoding: "utf8", windowsHide: true, timeout: 10000,
		}), "");
		for (const entry of ["src/index.js", "dist/index.js", "app", "view"]) {
			await assert.rejects(import(`@fatcat/tui/${entry}`), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
		}
	});
});
