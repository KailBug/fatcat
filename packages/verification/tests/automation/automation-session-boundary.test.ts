import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";
import { checkCancellation } from "@fatcat/runtime/errors";
import type { Model, ModelTurn } from "@fatcat/runtime/model";
import { SessionManager } from "@fatcat/runtime/session/manager";
import { SessionStore } from "@fatcat/runtime/session/store";
import { temporaryWorkspace } from "../support/workspace.js";

const answer = (): ModelTurn => ({ message: { role: "assistant", content: "Ready" }, toolCalls: [] });
const task = { action: "create", prompt: "Review changes", trigger: { type: "interval", seconds: 60 }, maxRuns: 3 };

async function fixture(t: TestContext, background: boolean, model: Model = async () => answer()) {
	const { base, workspace, outside } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const agent = { model, maxIterations: 1 };
	const manager = await SessionManager.open(agent, { workspace, store });
	await manager.manageAutomation(task);
	const bound = (await manager.listAutomations())[0]!;
	if (background) await manager.newSession("Foreground");
	return { manager, store, agent, bound, workspace, outside };
}

describe("Session Automation boundaries", () => {
	it("discovers fresh workspace tasks without sharing mutable snapshots", async (t) => {
		const { manager, store, agent, bound, outside } = await fixture(t, true);
		const foreign = await SessionManager.open(agent, { workspace: outside, store });
		await foreign.manageAutomation(task);
		const tasks = await manager.listAutomations();
		assert.deepEqual(tasks.map((item) => item.sessionId), [bound.sessionId]);
		tasks[0]!.enabled = false;
		tasks[0]!.trigger = { type: "interval", seconds: 120 };
		assert.deepEqual((await manager.listAutomations())[0], bound);
		await manager.manageSessionAutomation(bound.sessionId, { action: "pause", id: bound.id });
		assert.equal((await manager.listAutomations())[0]!.enabled, false);
		assert.notEqual(manager.current.id, bound.sessionId);
		assert.deepEqual(manager.history, []);
	});

	for (const background of [false, true]) {
		it(`rejects stale, paused and cancelled activations without claiming a turn with background=${background}`, async (t) => {
			let requests = 0;
			const { manager, store, agent, bound, workspace } = await fixture(t, background, async () => {
				requests++;
				return answer();
			});
			const selected = manager.current.id;
			const due = Date.now();
			const other = await SessionManager.open(agent, { workspace, store, selection: { resume: bound.sessionId } });
			await other.manageAutomation({ action: "pause", id: bound.id });
			await assert.rejects(manager.runAutomation(bound.sessionId, bound.id, due, []), { code: "AUTOMATION_INACTIVE" });
			assert.equal(manager.isBusy, false);
			await other.manageAutomation({ action: "resume", id: bound.id });
			await assert.rejects(manager.runAutomation(bound.sessionId, bound.id, due, [], {
				locationRevision: (bound.locationRevision ?? 0) + 1,
			}), { code: "AUTOMATION_INACTIVE" });
			assert.equal(manager.isBusy, false);
			await assert.rejects(manager.runAutomation(bound.sessionId, "missing-task", due, []), { code: "AUTOMATION_INACTIVE" });
			await assert.rejects(manager.runAutomation(bound.sessionId, bound.id, due, [], { signal: AbortSignal.abort() }), { code: "CANCELLED" });
			assert.equal(manager.isBusy, false);
			assert.equal(requests, 0);
			const unclaimed = await store.loadAny(bound.sessionId);
			assert.equal(unclaimed.automations![0]!.runs, 0);
			assert.equal(unclaimed.attempt, null);
			await manager.runAutomation(bound.sessionId, bound.id, due, []);
			assert.equal(requests, 1);
			assert.equal(manager.current.id, selected);
			await assert.rejects(manager.runAutomation(bound.sessionId, bound.id, due, []), { code: "AUTOMATION_INACTIVE" });
			assert.equal(manager.isBusy, false);
			assert.equal((await store.loadAny(bound.sessionId)).automations![0]!.runs, 1);
		});

		for (const cancellation of ["external", "expiry"]) {
			it(`holds the host lock through ${cancellation} cancellation and settles the target with background=${background}`, { timeout: 10_000 }, async (t) => {
				const controller = new AbortController();
				const expiry = new AbortController();
				let enter!: () => void;
				const entered = new Promise<void>((resolve) => { enter = resolve; });
				let waiting = true;
				const { manager, store, bound } = await fixture(t, background, async (_messages, signal) => {
					if (waiting) {
						assert.ok(signal);
						await new Promise<void>((resolve) => {
							signal.addEventListener("abort", () => resolve(), { once: true });
							if (signal.aborted) resolve();
							enter();
						});
						checkCancellation(signal);
					}
					return answer();
				});
				const selected = manager.current.id;
				const history = manager.history;
				const deadlines: number[] = [];
				t.mock.method(AbortSignal, "timeout", (milliseconds: number) => {
					deadlines.push(milliseconds);
					return expiry.signal;
				});
				const due = Date.now();
				const running = manager.runAutomation(bound.sessionId, bound.id, due, [], { signal: controller.signal });
				const rejected = assert.rejects(running, { code: "CANCELLED" });
				try {
					await entered;
					assert.equal(manager.isBusy, true);
					assert.equal(manager.current.id, selected);
					await assert.rejects(manager.newSession(), { code: "SESSION_BUSY" });
					await assert.rejects(manager.manageSessionAutomation(bound.sessionId, { action: "pause", id: bound.id }), { code: "SESSION_BUSY" });
					const claimed = await store.loadAny(bound.sessionId);
					assert.equal(claimed.automations![0]!.runs, 1);
					assert.equal(claimed.automations![0]!.lastStatus, "running");
					assert.equal(claimed.attempt?.status, "running");
					assert.equal(deadlines.length, 1);
					assert.ok(deadlines[0]! > 0 && deadlines[0]! <= bound.expiresAt - due);
				} finally {
					(cancellation === "expiry" ? expiry : controller).abort();
					await rejected;
				}
				assert.equal(manager.isBusy, false);
				assert.equal(manager.current.id, selected);
				assert.deepEqual(manager.history, history);
				const stopped = await store.loadAny(bound.sessionId);
				assert.equal(stopped.automations![0]!.runs, 1);
				assert.equal(stopped.automations![0]!.lastStatus, "cancelled");
				assert.equal(stopped.attempt?.status, "cancelled");
				t.mock.restoreAll();
				waiting = false;
				await manager.runAutomation(bound.sessionId, bound.id, due + 1, []);
				const completed = await store.loadAny(bound.sessionId);
				assert.equal(completed.automations![0]!.runs, 2);
				assert.equal(completed.automations![0]!.lastStatus, "completed");
				assert.equal(completed.attempt, null);
				assert.equal(manager.current.id, selected);
				assert.equal(manager.isBusy, false);
			});
		}
	}
});
