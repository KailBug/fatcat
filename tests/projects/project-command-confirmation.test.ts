import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";
import { runInteractiveCommand } from "../../src/commands.js";
import { runSessionCommand } from "../../src/session/commands.js";
import { SessionManager } from "../../src/session/manager.js";
import { SessionStore } from "../../src/session/store.js";
import { temporaryWorkspace } from "../support/workspace.js";

async function fixture(t: TestContext) {
	const { base, workspace, outside } = await temporaryWorkspace(t);
	const session = await SessionManager.open({ maxIterations: 1, model: async () => {
		throw new Error("Host commands must not request a model response.");
	} }, { workspace, store: new SessionStore({ root: join(base, "sessions") }) });
	const project = await session.createProject("Shared", outside);
	const originalId = session.current.id;
	await session.newSession("Other");
	const otherId = session.current.id;
	await session.resume(originalId);
	const preview = await runSessionCommand(session, `/project join ${project.id}`);
	const token = /Confirm with \/project confirm ([a-f0-9-]+)/.exec(preview!.text)?.[1];
	assert.ok(token);
	return { session, project, originalId, otherId, confirm: `/project confirm ${token}` };
}

describe("project command confirmation across dispatch boundaries", () => {
	for (const action of ["new", "clear", "reset", "fork", "resume", "project use"]) {
		it(`invalidates approval after /${action}, even after returning to the original session`, async (t) => {
			const { session, project, originalId, otherId, confirm } = await fixture(t);
			const command = action === "resume" ? `/resume ${otherId}`
				: action === "project use" ? `/project use ${project.id}` : `/${action}`;
			assert.equal((await runInteractiveCommand(session, command))!.switched, true);
			// Bypass command dispatch on return so this cannot hide a missing invalidation.
			await session.resume(originalId);
			await assert.rejects(runSessionCommand(session, confirm), {
				code: "USAGE", message: "No matching project confirmation. Use /project join again.",
			});
			assert.equal(session.current.projectId, undefined);
			assert.deepEqual(session.history, []);
		});
	}

	it("retains approval through failed selection and read-only commands", async (t) => {
		const { session, project, originalId, confirm } = await fixture(t);
		await assert.rejects(runInteractiveCommand(session, "/resume missing-session"));
		await assert.rejects(runInteractiveCommand(session, "/project use missing-project"));
		for (const command of ["/sessions", "/projects", "/attachments", "/workspace", "/cron list"]) {
			assert.equal((await runInteractiveCommand(session, command))!.switched, false);
		}
		assert.equal(session.current.id, originalId);
		assert.equal((await runInteractiveCommand(session, confirm))!.switched, true);
		assert.equal(session.current.projectId, project.id);
		assert.deepEqual(session.history, []);
	});
});
