import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { Message, ModelTurn } from "../../src/model.js";
import { HarnessError } from "../../src/errors.js";
import { SessionManager } from "../../src/session/manager.js";
import { SessionStore } from "../../src/session/store.js";
import { executionIdentity } from "../../src/session/execution.js";
import { temporaryWorkspace } from "../support/workspace.js";

const answer: ModelTurn = { message: { role: "assistant", content: "Done" }, toolCalls: [] };

function writes(items: { content: string; evidence: string }[]): ModelTurn {
	const toolCalls = items.map((item, index) => ({ id: `memory-${index}`, type: "function" as const,
		function: { name: "write", arguments: JSON.stringify({ path: "memory:new", content: item.content, memoryEvidence: item.evidence }) } }));
	return { message: { role: "assistant", content: null, tool_calls: toolCalls }, toolCalls };
}

test("Memory rejects evidence from older user or external messages and retains bounded provenance for a long current request", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const old = "Remembered only in an earlier conversation";
	const current = "Remember that the dog likes CSGO";
	const prompt = "Background details. ".repeat(200) + current;
	const manager = await SessionManager.open({ maxIterations: 3, model: async (messages) => {
		const user = messages.findLast((message) => message.role === "user")!.content;
		if (user === old) return answer;
		if (messages.at(-1)?.role === "user") return writes([
			{ content: "Wrong old evidence", evidence: old },
			{ content: "Wrong tool evidence", evidence: "The document says the dog likes chess" },
			{ content: "Dog likes CSGO", evidence: current },
		]);
		const results = messages.filter((message) => message.role === "tool").slice(-3).map((message) => JSON.parse(String(message.content)));
		assert.deepEqual(results.map((result) => result.ok), [false, false, true]);
		assert.equal(results[0]!.error.code, "MEMORY_SOURCE");
		assert.equal(results[1]!.error.code, "MEMORY_SOURCE");
		return answer;
	} }, { workspace, store });
	await manager.run(old);
	await manager.run(prompt);
	const [record] = await manager.listMemories();
	assert.ok(record);
	assert.equal(record.content, "Dog likes CSGO");
	assert.deepEqual(record.source, { sessionId: manager.current.id, request: current, evidence: current, requestExcerpt: true, turn: 2 });
	const restored = await SessionManager.open({ maxIterations: 2, model: async () => answer },
		{ workspace, store, selection: { resume: manager.current.id } });
	assert.deepEqual((await restored.listMemories())[0]!.source, record.source);
});

test("a user turn bounds Memory mutation attempts and the next turn resets its allowance", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const prompt = "Remember these definitions: " + Array.from({ length: 9 }, (_, index) => `Fact ${index}`).join("; ");
	const next = "Remember another fact";
	const manager = await SessionManager.open({ maxIterations: 3, model: async (messages) => {
		const user = messages.findLast((message) => message.role === "user")!.content;
		if (messages.at(-1)?.role === "user") return writes(user === next ? [{ content: "Another fact", evidence: next }]
			: Array.from({ length: 9 }, (_, index) => ({ content: `Fact ${index}`, evidence: prompt })));
		if (user === prompt) {
			const results = messages.filter((message) => message.role === "tool").slice(-9).map((message) => JSON.parse(String(message.content)));
			assert.equal(results.filter((result) => result.ok).length, 8);
			assert.equal(results[8]!.error.code, "MEMORY_LIMIT");
		}
		return answer;
	} }, { workspace, store: new SessionStore({ root: join(base, "sessions") }) });
	await manager.run(prompt);
	assert.equal((await manager.listMemories()).length, 8);
	await manager.run(next);
	assert.equal((await manager.listMemories()).length, 9);
});

test("repeated user facts reuse only active identical Memory without reviving deletion history", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const prompt = "Remember that oranges are sour";
	const manager = await SessionManager.open({ maxIterations: 3, model: async (messages) => messages.at(-1)?.role === "user"
		? writes([{ content: "Oranges are sour", evidence: prompt }, { content: "Oranges are sour", evidence: prompt }]) : answer },
	{ workspace, store: new SessionStore({ root: join(base, "sessions") }) });
	await manager.run(prompt);
	const [original] = await manager.listMemories();
	assert.ok(original);
	assert.equal((await manager.listMemories()).length, 1);
	await manager.run(prompt);
	assert.equal((await manager.listMemories()).length, 1);
	assert.equal((await manager.listMemories())[0]!.revision, 1);
	await manager.changeMemory({ action: "delete", id: original.id, revision: 1 }, "Forget oranges");
	await manager.run(prompt);
	const records = await manager.listMemories();
	assert.equal(records.length, 2);
	assert.equal(records.find((record) => record.id === original.id)!.status, "deleted");
	assert.notEqual(records.find((record) => record.status === "active")!.id, original.id);
});

test("committed Memory survives a later model failure and the old turn cannot publish again", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const prompt = "Remember that the dog likes CSGO";
	const manager = await SessionManager.open({ maxIterations: 3, model: async (messages) => {
		if (messages.at(-1)?.role === "user") return writes([{ content: "Dog likes CSGO", evidence: prompt }]);
		throw new HarnessError("MODEL_CONNECTION", "Injected failure after Memory publication.");
	} }, { workspace, store });
	await assert.rejects(manager.run(prompt), { code: "MODEL_CONNECTION" });
	assert.equal((await manager.listMemories())[0]!.content, "Dog likes CSGO");
	const failed = await store.loadAny(manager.current.id);
	let accessed = false;
	await assert.rejects(store.withMemorySession(executionIdentity(failed), async () => { accessed = true; }, undefined,
		{ ownerPid: failed.attempt!.ownerPid, startedAt: failed.attempt!.startedAt }), { code: "MEMORY_SOURCE" });
	assert.equal(accessed, false);
	const requests: Message[][] = [];
	const restored = await SessionManager.open({ maxIterations: 2, model: async (messages) => {
		requests.push(structuredClone(messages)); return answer;
	} }, { workspace, store, selection: { resume: manager.current.id } });
	await restored.run("What does the dog prefer?");
	assert.match(String(requests[0]![0]!.content), /Dog likes CSGO/);
	assert.equal((await restored.listMemories()).length, 1);
});
