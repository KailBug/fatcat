import assert from "node:assert/strict";
import test from "node:test";
import { QuestionCoordinator, withAskUser } from "@fatcat/runtime/tools/ask-user";
import { defaultTools } from "@fatcat/runtime/tools";

test("clarifications require fresh answers, reject replay and clear on cancellation", async () => {
	const coordinator = new QuestionCoordinator();
	const abort = new AbortController();
	const pending = coordinator.request({ question: "Which?", options: ["A", "B"] }, abort.signal);
	const id = coordinator.snapshot()!.id;
	await assert.rejects(coordinator.request({ question: "Again?" }), { code: "QUESTION_BUSY" });
	assert.throws(() => coordinator.answer(id, " "), { code: "INVALID_ARGUMENTS" });
	coordinator.answer(id, "Free text");
	assert.equal(await pending, "Free text");
	assert.equal(coordinator.snapshot(), null);
	assert.throws(() => coordinator.answer(id, "replay"), { code: "STALE_QUESTION" });
	const cancelled = coordinator.request({ question: "Wait?" }, abort.signal);
	abort.abort();
	await assert.rejects(cancelled, { code: "CANCELLED" });
	assert.equal(coordinator.snapshot(), null);
});

test("ask_user validates before host input, bounds each turn and returns skip distinctly", async () => {
	let calls = 0;
	const tools = withAskUser(defaultTools, async () => { calls++; return calls === 1 ? null : "custom"; });
	for (const args of [null, { question: "" }, { question: "\u001b[31m" }, { question: "Which?", options: ["A", "A"] }, { question: "Q", extra: true }]) {
		const result = await tools.execute("ask_user", JSON.stringify(args));
		assert.equal(result.ok, false);
	}
	assert.equal(calls, 0);
	assert.deepEqual(await tools.execute("ask_user", '{"question":"Which?"}'), { ok: true, result: { status: "skipped" } });
	for (let index = 0; index < 3; index++) assert.equal((await tools.execute("ask_user", '{"question":"Which?"}')).ok, true);
	assert.deepEqual(await tools.execute("ask_user", '{"question":"Again?"}'), { ok: false, error: { code: "QUESTION_LIMIT", message: "At most four questions per user turn." } });
	assert.equal((await tools.forTurn!().execute("ask_user", '{"question":"New turn?"}')).ok, true);
	assert.equal(calls, 5);
	assert.equal(withAskUser(defaultTools), defaultTools);
});
