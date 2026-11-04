import assert from "node:assert/strict";
import test from "node:test";
import { runAgentTurn } from "@fatcat/runtime/loop";
import { HarnessError } from "@fatcat/runtime/errors";
import { createTurnReporter, type ReportEvent } from "@fatcat/runtime/execution-report";
import type { Tools } from "@fatcat/runtime/tools";

for (const outcome of ["ok", "error", "cancelled", "threw"] as const) {
	test(`tool metadata records ${outcome} without recording bodies or changing terminal behavior`, async () => {
		const events: ReportEvent[] = [];
		const tools: Tools = { definitions: [], execute: async () => {
			if (outcome === "cancelled") throw new HarnessError("CANCELLED", "private cancellation reason");
			if (outcome === "threw") throw new Error("private stack");
			return outcome === "ok" ? { ok: true, result: "private result" } : { ok: false, error: { code: "CONFLICT", message: "private reason" } };
		} };
		const pending = runAgentTurn("Fixture", [], { tools, maxIterations: 2, onEvent: createTurnReporter((event) => events.push(event)),
			model: async (messages) => messages.at(-1)?.role === "user"
				? { message: { role: "assistant", content: null, toolCalls: [{ id: "one", name: "fixture", arguments: '{"text":"private input 😀"}' }] } }
				: { message: { role: "assistant", content: "Done" } } });
		if (outcome === "cancelled" || outcome === "threw") await assert.rejects(pending);
		else assert.equal((await pending).answer, "Done");
		const report = events.find((event) => event.type === "execution_report");
		assert.ok(report?.type === "execution_report");
		const execution = report.report.toolExecutions![0]!;
		assert.equal(execution.status, outcome);
		assert.equal(execution.inputBytes, Buffer.byteLength('{"text":"private input 😀"}'));
		assert.equal(execution.parentCallId, null);
		assert.ok(execution.durationMs >= 0);
		assert.equal(execution.outputBytes === null, outcome === "cancelled" || outcome === "threw");
		assert.doesNotMatch(JSON.stringify(events), /private/);
		assert.equal(events.filter((event) => event.type === "tool_result").length, outcome === "ok" || outcome === "error" ? 1 : 0);
	});
}

test("tool observations retain parent/child identity and deduplicate repeat delivery", () => {
	const events: ReportEvent[] = [];
	const observe = createTurnReporter((event) => events.push(event));
	const event = { type: "tool_execution" as const, iteration: 1, callId: "same", tool: "read", status: "ok" as const,
		errorCode: null, durationMs: 1, inputBytes: 2, outputBytes: 10 };
	observe(event); observe(event);
	observe({ type: "subagent_event", callId: "child", event });
	observe({ type: "completed", iterations: 2 });
	const report = events.at(-1)!;
	assert.ok(report.type === "execution_report");
	assert.deepEqual(report.report.toolExecutions!.map((item) => item.parentCallId), [null, "child"]);
});
