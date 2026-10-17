import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runInteractiveCommand } from "@fatcat/commands";
import { runSessionCommand } from "@fatcat/commands/session";
import { SessionManager } from "@fatcat/runtime/session/manager";
import { SessionStore } from "@fatcat/runtime/session/store";
import { temporaryWorkspace } from "../support/workspace.js";

describe("commands workspace package", () => {
	it("loads its declared host entries while keeping implementation paths private", async () => {
		const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.resolve("@fatcat/commands")), "utf8")) as {
			exports: Record<string, unknown>;
		};
		for (const entry of Object.keys(manifest.exports)) {
			await import(`@fatcat/commands${entry === "." ? "" : entry.slice(1)}`);
		}
		for (const entry of ["src/commands.js", "dist/commands.js", "project/commands", "utils/command", "internal/project/commands"]) {
			await assert.rejects(import(`@fatcat/commands/${entry}`), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
		}
	});

	it("shares confirmation invalidation across package entries using the same runtime manager", async (t) => {
		const { base, workspace, outside } = await temporaryWorkspace(t);
		const session = await SessionManager.open({ maxIterations: 1, model: async () => {
			throw new Error("Host commands must not request a model response.");
		} }, { workspace, store: new SessionStore({ root: join(base, "sessions") }) });
		const project = await session.createProject("Shared", outside);
		const originalId = session.current.id;
		const preview = await runInteractiveCommand(session, `/project join ${project.id}`);
		const token = /Confirm with \/project confirm ([a-f0-9-]+)/.exec(preview!.text)?.[1];
		assert.ok(token);
		assert.equal((await runSessionCommand(session, "/new"))!.switched, true);
		await session.resume(originalId);
		await assert.rejects(runInteractiveCommand(session, `/project confirm ${token}`), {
			code: "USAGE", message: "No matching project confirmation. Use /project join again.",
		});
		assert.equal(session.current.projectId, undefined);
		assert.deepEqual(session.history, []);
	});
});
