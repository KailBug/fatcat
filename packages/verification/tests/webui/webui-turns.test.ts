import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";
import { HarnessError } from "@fatcat/runtime/errors";
import type { Message } from "@fatcat/runtime/model-types";
import type { SessionRunOptions } from "@fatcat/runtime/session/agent-session";
import { defaultModelSelection } from "@fatcat/runtime/model-catalog";
import { SessionManager } from "@fatcat/runtime/session/manager";
import { SessionStore } from "@fatcat/runtime/session/store";
import { WebUiController } from "@fatcat/webui/internal/controller";
import { restoredTurns } from "@fatcat/webui/internal/turns";
import { temporaryWorkspace } from "../support/workspace.js";

async function setup(t: TestContext) {
	const { base, workspace } = await temporaryWorkspace(t);
	const manager = await SessionManager.open({
        modelSelection: defaultModelSelection("deepseek"),
		model: async (_messages, _signal, observe) => {
			observe?.({ type: "model_usage", usage: { promptTokens: 42, completionTokens: 1, totalTokens: 43 } });
			return { message: { role: "assistant", content: "Done" }, toolCalls: [] };
		},
		maxIterations: 1,
	}, { workspace, store: new SessionStore({ root: join(base, "sessions") }) });
	const controller = await WebUiController.create({
		provider: "deepseek", model: "offline", workspace, permission: "ask", shellPermission: "deny",
		webPermission: "deny", maxIterations: 1, maxRequestBytes: 262144, skills: 0, warnings: [],
	}, manager);
	t.after(() => controller.close());
	return { controller, manager };
}

async function finished(controller: WebUiController): Promise<void> {
	const deadline = performance.now() + 10000;
	while (controller.snapshot().busy) {
		assert.ok(performance.now() < deadline, "Controller did not become idle");
		await delay(5);
	}
}

describe("Web UI turn and display boundaries", () => {
	it("installs active state before synchronous approval and retains the lock through final refresh", async (t) => {
		const { controller, manager } = await setup(t);
		let approvalId = "";
		const run = t.mock.method(manager, "run", async (_prompt: string, options?: SessionRunOptions) => {
			assert.equal(controller.snapshot().busy, true);
			const approval = controller.requestApproval("write", {
				path: "note.txt", operation: "create", newText: "note", bytes: 4,
			}, options?.signal);
			approvalId = controller.snapshot().approval!.id;
			controller.stop();
			assert.equal(await approval, false);
			assert.equal(options?.signal?.aborted, true);
			throw new HarnessError("CANCELLED", "Fixture stopped.");
		});
		const list = manager.list.bind(manager);
		t.mock.method(manager, "list", async () => {
			assert.equal(controller.snapshot().busy, true);
			assert.equal(controller.snapshot().approval, null);
			assert.throws(() => controller.submit("Too early"), { code: "SESSION_BUSY" });
			return list();
		});
		controller.submit("Ask immediately");
		await finished(controller);
		assert.equal(run.mock.callCount(), 1);
		assert.equal(controller.snapshot().status, "Stopped");
		assert.equal(controller.snapshot().runningSessionId, null);
		assert.equal(controller.snapshot().turns[0]?.status, "stopped");
		assert.equal(controller.snapshot().turns[0]?.sources, undefined);
		assert.throws(() => controller.approve(approvalId, true), { code: "STALE_APPROVAL" });
	});

	it("bounds activity without losing report evidence or counting child usage as parent usage", async (t) => {
		const { controller, manager } = await setup(t);
		t.mock.method(manager, "run", async (_prompt: string, options?: SessionRunOptions) => {
			const emit = options?.onEvent;
			emit?.({ type: "model_request", iteration: 1 });
			emit?.({ type: "model_usage", iteration: 1, usage: { promptTokens: 42, completionTokens: 1, totalTokens: 43 } });
			for (let i = 0; i < 105; i++) {
				emit?.({ type: "tool_result", iteration: 1, callId: `read-${i}`, tool: `read-${i}`, ok: true });
			}
			emit?.({ type: "subagent_event", callId: "child", event: { type: "model_request", iteration: 2, purpose: "document" } });
			emit?.({ type: "subagent_event", callId: "child", event: {
				type: "model_usage", iteration: 2, usage: { promptTokens: 999, completionTokens: 1, totalTokens: 1000 },
			} });
			emit?.({ type: "completed", iterations: 1 });
			return "Done";
		});
		controller.submit("Many events");
		await finished(controller);
		const state = controller.snapshot();
		const turn = state.turns[0]!;
		assert.equal(turn.activity.length, 100);
		assert.equal(turn.activity[0], "read-6 · completed");
		assert.equal(turn.activity.at(-1), "Subagent · Document request 2");
		assert.equal(turn.report?.toolResults.ok, 105);
		assert.deepEqual(turn.report?.modelRequests, { parent: 1, children: 1 });
		// Injected display events cannot fabricate runtime observations.
        assert.equal(state.contextUsage?.lastReportedInput, null);
        assert.equal(turn.report?.tokenUsage.parent.totals?.promptTokens, 42);
		assert.equal(state.status, "Ready");
	});

	it("preserves display and committed metadata when management refresh fails without replaying the change", async (t) => {
		const { controller, manager } = await setup(t);
		controller.submit("Keep this display");
		await finished(controller);
		const before = controller.snapshot();
		const rename = t.mock.method(manager, "rename", manager.rename.bind(manager));
		const listProjects = manager.listProjects.bind(manager);
		const failure = new Error("Fixture project listing failed");
		let listings = 0;
		t.mock.method(manager, "listProjects", async () => {
			if (++listings === 1) throw failure;
			return listProjects();
		});
		await assert.rejects(controller.rename("Saved name"), (error) => error === failure);
		const after = controller.snapshot();
		assert.equal(rename.mock.callCount(), 1);
		assert.equal(after.sessions.find((session) => session.id === before.current.id)?.name, "Saved name");
		assert.deepEqual(after.turns, before.turns);
		assert.deepEqual(after.contextUsage?.lastReportedInput, before.contextUsage?.lastReportedInput);
        assert.deepEqual(after.contextUsage?.consumption, before.contextUsage?.consumption);
		assert.equal(after.busy, false);
		assert.equal(after.status, "Session change failed");
		assert.ok(after.revision > before.revision);
		await controller.newSession();
		assert.deepEqual(controller.snapshot().turns, []);
		assert.equal(controller.snapshot().contextUsage?.lastReportedInput ?? null, null);
	});

	it("restores only completed text turns with per-turn sources and fresh display telemetry", () => {
		const reference = `attachment:${randomUUID()}@${"a".repeat(64)}`;
		const call = { id: "reused-call", name: "read", arguments: "{}" };
		const history: Message[] = [
			{ role: "assistant", content: "Orphan answer" },
			{ role: "user", content: "Read source" },
			{ role: "assistant", content: "Reading", toolCalls: [call] },
			{ role: "tool", callId: call.id, content: JSON.stringify({ ok: true, result: {
				kind: "file", name: "source.txt", path: reference, startLine: 1, endLine: 1, totalLines: 1,
				citation: `${reference}#L1-L1`, coverage: { complete: true },
			} }) },
			{ role: "assistant", content: "Source answer" },
			{ role: "user", content: "Read again" },
			{ role: "assistant", content: null, toolCalls: [call] },
			{ role: "tool", callId: call.id, content: JSON.stringify({ ok: false, error: "Unavailable" }) },
			{ role: "assistant", content: "No source" },
			{ role: "user", content: "Unfinished" },
		];
		const original = structuredClone(history);
		const turns = restoredTurns(history, "session-fixture");
		assert.deepEqual(turns.map((turn) => [turn.id, turn.prompt, turn.answer]), [
			["session-fixture:0", "Read source", "Source answer"],
			["session-fixture:1", "Read again", "No source"],
		]);
		assert.equal(turns[0]?.sources?.reads[0]?.reference, reference);
		assert.deepEqual(turns[1]?.sources, { reads: [], omittedReads: 0 });
		for (const turn of turns) {
			assert.deepEqual(turn.activity, []);
			assert.equal(turn.report, undefined);
			assert.equal(turn.status, "answered");
		}
		assert.deepEqual(history, original);
	});
});
