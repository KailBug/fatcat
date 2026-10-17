import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInteractiveCommand } from "../../src/commands.js";
import { runSessionCommand } from "../../src/session/commands.js";
import { Session } from "../../src/session/session.js";

describe("host command entry contracts", () => {
	it("preserves validation order for unmanaged conversations through interactive dispatch", async () => {
		const session = new Session({ maxIterations: 1, model: async () => {
			throw new Error("Host commands must not call the model.");
		} });
		const signal = AbortSignal.abort();
		const run = (prompt: string) => runInteractiveCommand(session, prompt, [], { signal });
		await assert.rejects(run("/projects extra"), { code: "USAGE", message: "/projects does not take an argument." });
		for (const prompt of ["/project", "/project create", "/projects", "/attach", "/attachments extra", "/attachment delete bad"]) {
			await assert.rejects(run(prompt), { code: "USAGE", message: "Session management requires a managed conversation." });
		}
		for (const prompt of ["hello", "/unknown", "/projectx", "/attachmentx", "/sessionsx"]) {
			assert.equal(await run(prompt), undefined);
		}
		assert.deepEqual(await run("/clear"), { text: "History cleared.", switched: true });
		assert.deepEqual(session.messages, []);
	});

	it("leaves other capabilities to interactive dispatch", async () => {
		const session = new Session({ maxIterations: 1, model: async () => {
			throw new Error("Host commands must not call the model.");
		} });
		for (const prompt of ["/project", "/projects extra", "/attachments", "/attach file.txt", "/cron", "/skills"]) {
			assert.equal(await runSessionCommand(session, prompt), undefined);
		}
		await assert.rejects(runSessionCommand(session, "/sessions extra"), {
			code: "USAGE", message: "/sessions does not take an argument.",
		});
		assert.deepEqual(await runSessionCommand(session, "/clear"), { text: "History cleared.", switched: true });
		assert.deepEqual(session.messages, []);
	});
});
