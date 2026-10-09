import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { HarnessError } from "../src/errors.js";
import type { LoopEvent } from "../src/loop.js";
import type { Message, ModelTurn } from "../src/model.js";
import { SessionManager } from "../src/session/manager.js";
import type { SessionRecord } from "../src/session/record.js";
import { SessionStore } from "../src/session/store.js";
import { temporaryWorkspace } from "./fixtures/workspace.js";

function answer(): ModelTurn {
	return { message: { role: "assistant", content: "Ready" }, toolCalls: [] };
}

test("completion observers see an idle durable session and cannot undo its commit", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const manager = await SessionManager.open({ model: async () => answer(), maxIterations: 1 }, { workspace, store });
	const events: LoopEvent[] = [];
	const observerError = new Error("Injected observer failure.");
	const abort = new AbortController();
	await assert.rejects(manager.run("Keep the committed answer", {
		signal: abort.signal,
		onEvent: (event) => {
			events.push(event);
			if (event.type === "completed") {
				assert.equal(manager.isBusy, false);
				assert.equal(manager.current.turnCount, 1);
				assert.equal(manager.current.interrupted, false);
				abort.abort();
				throw observerError;
			}
		},
	}), (error) => error === observerError);
	assert.equal(events.filter((event) => event.type === "completed").length, 1);
	assert.equal(events.filter((event) => event.type === "stopped").length, 0);
	assert.deepEqual((await store.loadAny(manager.current.id)).history, manager.history);
	await manager.run("Continue after the observer failed");
	assert.equal(manager.current.turnCount, 2);
});

test("a schedule created by a failed turn survives checkpoints and recovery stays request-only", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const requests: Message[][] = [];
	const manager = await SessionManager.open({ maxIterations: 2, model: async (messages) => {
		requests.push(structuredClone(messages));
		if (messages.at(-1)?.content === "Schedule then fail") {
			const toolCalls = [{ id: "schedule", type: "function" as const, function: {
				name: "automation",
				arguments: JSON.stringify({ action: "create", prompt: "Review changes", trigger: { type: "interval", seconds: 60 } }),
			} }];
			return { message: { role: "assistant", content: null, tool_calls: toolCalls }, toolCalls };
		}
		if (messages.at(-1)?.role === "tool") {
			throw new HarnessError("MODEL_HTTP", "Injected failure after a saved schedule.");
		}
		return answer();
	} }, { workspace, store });
	await manager.run("Keep prior history");
	const history = manager.history;
	await assert.rejects(manager.run("Schedule then fail"), /Injected failure/);
	const failed = await store.loadAny(manager.current.id);
	assert.deepEqual(failed.history, history);
	assert.equal(failed.automations?.length, 1);
	assert.equal(failed.attempt?.messages.at(-1)?.role, "tool");
	await manager.run("Recover");
	assert.match(JSON.stringify(requests.at(-1)), /Harness session recovery notice/);
	assert.equal((await manager.listAutomations()).length, 1);
	assert.ok(!JSON.stringify(manager.history).includes("Harness session recovery notice"));
	await manager.run("Next turn");
	assert.ok(!JSON.stringify(requests.at(-1)).includes("Harness session recovery notice"));
});

test("failed failure-record persistence retains old history and releases the manager", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	class FailingStore extends SessionStore {
		override async save(record: SessionRecord, revision: number): Promise<SessionRecord> {
			if (record.attempt?.status === "failed") {
				throw new HarnessError("SESSION_STORAGE", "Injected failure-record write error.");
			}
			return super.save(record, revision);
		}
	}
	const store = new FailingStore({ root: join(base, "sessions") });
	const manager = await SessionManager.open({ maxIterations: 1, model: async (messages) => {
		if (messages.at(-1)?.content === "Fail") {
			throw new HarnessError("MODEL_HTTP", "Original model failure.");
		}
		return answer();
	} }, { workspace, store });
	await manager.run("Keep");
	const events: LoopEvent[] = [];
	await assert.rejects(manager.run("Fail", { onEvent: (event) => events.push(event) }), /Original model failure/);
	assert.equal(manager.isBusy, false);
	assert.equal(manager.current.turnCount, 1);
	assert.equal(manager.current.interrupted, true);
	assert.deepEqual(events.filter((event) => event.type === "stopped"), [{ type: "stopped", code: "MODEL_HTTP" }]);
	const saved = await store.loadAny(manager.current.id);
	assert.equal(saved.attempt?.status, "running");
	assert.deepEqual(saved.history, manager.history);
	await manager.run("Continue after storage recovers");
	assert.equal(manager.current.turnCount, 2);
	assert.equal((await store.loadAny(manager.current.id)).attempt, null);
});

test("failed schedule publication leaves active and saved tasks unchanged and listing performs no write", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	class FailingStore extends SessionStore {
		rejectWrites = false;
		override async save(record: SessionRecord, revision: number): Promise<SessionRecord> {
			if (this.rejectWrites) {
				throw new HarnessError("SESSION_STORAGE", "Injected schedule publication failure.");
			}
			return super.save(record, revision);
		}
	}
	const store = new FailingStore({ root: join(base, "sessions") });
	const manager = await SessionManager.open({ model: async () => answer(), maxIterations: 1 }, { workspace, store });
	await manager.manageAutomation({ action: "create", prompt: "Review", trigger: { type: "interval", seconds: 60 } });
	const before = await store.loadAny(manager.current.id);
	store.rejectWrites = true;
	await assert.rejects(manager.manageAutomation({ action: "pause", id: before.automations![0]!.id }), /publication failure/);
	const listed = await manager.manageAutomation({ action: "list" }) as { tasks: unknown[] };
	assert.deepEqual(listed.tasks, before.automations);
	assert.equal(manager.current.revision, before.revision);
	assert.equal(manager.isBusy, false);
	assert.deepEqual(await store.loadAny(manager.current.id), before);
});
