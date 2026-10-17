import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runInteractiveCommand } from "../../src/commands.js";
import { automationCommandPrompt } from "../../src/automation/commands.js";
import { Session } from "../../src/session/session.js";

describe("cron command routing", () => {
	it("keeps natural-language scheduling separate from local management syntax", async () => {
		const session = new Session({ maxIterations: 1, model: async () => {
			throw new Error("Command parsing must not call the model.");
		} });
		for (const description of ["every five minutes review changes", "tomorrow\nreview tests", "listening for changes"]) {
			const prompt = `/cron ${description}  `;
			assert.equal(automationCommandPrompt(prompt), `Schedule in this conversation: ${description}`);
			assert.equal(await runInteractiveCommand(session, prompt), undefined);
		}
		for (const prompt of ["/cron", "/cron list", "/cron pause task", "/cron resume task", "/cron delete task"]) {
			assert.equal(automationCommandPrompt(prompt), undefined);
			await assert.rejects(runInteractiveCommand(session, prompt), {
				code: "AUTOMATION_UNAVAILABLE", message: "Automation requires a saved session.",
			});
		}
		for (const prompt of ["/cron list task extra", "/cron pause task extra", "/cronx", "/CRON", " /cron list"]) {
			assert.equal(automationCommandPrompt(prompt), undefined);
			assert.equal(await runInteractiveCommand(session, prompt), undefined);
		}
		assert.deepEqual(session.messages, []);
	});
});
