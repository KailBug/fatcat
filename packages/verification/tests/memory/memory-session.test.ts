import type { ChatMessage } from "../support/chat-protocol.js";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createAgent } from "@fatcat/runtime/agent";
import { runInteractiveCommand } from "@fatcat/commands";
import { loadConfig } from "@fatcat/runtime/config";
import type { Message, Model } from "@fatcat/runtime/model-types";
import { SessionManager } from "@fatcat/runtime/session/manager";
import { SessionStore } from "@fatcat/runtime/session/store";
import { executionIdentity } from "@fatcat/runtime/internal/session/execution";
import type { SessionRecord } from "@fatcat/runtime/session/record";
import { createTools } from "@fatcat/runtime/tools";
import { WebUiController } from "@fatcat/webui/internal/controller";
import { temporaryWorkspace } from "../support/workspace.js";

const answer = { message: { role: "assistant" as const, content: "Done" } };
const agent = { model: async () => answer, maxIterations: 4 };

test("explicit Memory commands preserve provenance and revisions without model requests or history changes", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	let requests = 0;
	const manager = await SessionManager.open({ ...agent, model: async () => { requests++; return answer; } },
		{ workspace, store: new SessionStore({ root: join(base, "sessions") }), deferEmptySessions: true });
	await runInteractiveCommand(manager, "/memory");
	assert.equal(manager.current.revision, 0);
	const prompt = "/memory add session Oranges are sour";
	await runInteractiveCommand(manager, prompt);
	const original = (await manager.listMemories())[0]!;
	assert.deepEqual(original.source, { sessionId: manager.current.id, request: prompt, turn: 0 });
	assert.ok(manager.current.revision > 0);
	await runInteractiveCommand(manager, `/memory update ${original.id} 1 Oranges can be sweet`);
	await assert.rejects(runInteractiveCommand(manager, `/memory update ${original.id} 1 Stale content`), /revision|changed|conflict/i);
	await runInteractiveCommand(manager, `/memory delete ${original.id} 2`);
	const deleted = (await manager.listMemories())[0]!;
	assert.equal(deleted.status, "deleted");
	assert.equal(deleted.revision, 3);
	assert.equal(deleted.changes[0]!.content, "Oranges are sour");
	assert.match((await runInteractiveCommand(manager, `/memory show ${original.id}`))!.text, /Oranges can be sweet/);
	assert.equal(requests, 0);
	assert.deepEqual(manager.history, []);
});

test("private Memory migrates to project ownership and survives its source session", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const manager = await SessionManager.open(agent, { workspace, store });
	const source = manager.current.id;
	const memory = await manager.changeMemory({ action: "add", scope: "session", content: "Oranges are sour" }, "Remember oranges");
	const global = await manager.changeMemory({ action: "add", scope: "global", content: "Use short answers" }, "Global preference");
	const project = await manager.createProject("Citrus", workspace);
	const stale = await manager.previewProjectJoin(project.id);
	assert.equal(stale.memoryCount, 1);
	await manager.changeMemory({ action: "update", id: memory.id, revision: 1, content: "Oranges are very sour" }, "Revise oranges");
	await assert.rejects(manager.joinProject(stale), /fresh|changed|conflict/i);
	await manager.joinProject(await manager.previewProjectJoin(project.id));
	await manager.newSession("Project reader");
	const reader = manager.current.id;
	const moved = (await manager.listMemories()).find((item) => item.id === memory.id)!;
	assert.deepEqual(moved.scope, { kind: "project", id: project.id });
	assert.equal(moved.content, "Oranges are very sour");
	assert.equal(moved.source.sessionId, source);
	await manager.delete(source);
	assert.equal((await manager.listMemories()).find((item) => item.id === memory.id)!.content, moved.content);
	const restored = await SessionManager.open(agent, { workspace, store: new SessionStore({ root: store.root }), selection: { resume: reader } });
	assert.deepEqual(await restored.listMemories(), await manager.listMemories());
	await restored.newSession("Independent", null);
	assert.deepEqual((await restored.listMemories()).map((item) => item.id), [global.id]);
	await assert.rejects(restored.changeMemory({ action: "delete", id: memory.id, revision: 2 }, "Wrong scope"), /available|scope/i);
	const other = await restored.createProject("Other", workspace);
	await restored.newSession("Other reader", other.id);
	assert.deepEqual((await restored.listMemories()).map((item) => item.id), [global.id]);
});

test("a concurrent Memory edit after the join comparison cannot enter the confirmed transaction", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	let race: (() => Promise<void>) | undefined;
	const manager = await SessionManager.open(agent, { workspace, store, agentForWorkspace: async () => {
		const operation = race;
		race = undefined;
		await operation?.();
		return agent;
	} });
	const memory = await manager.changeMemory({ action: "add", scope: "session", content: "Reviewed definition" }, "Remember definition");
	const project = await manager.createProject("Destination", workspace);
	const preview = await manager.previewProjectJoin(project.id);
	const other = await SessionManager.open(agent, { workspace, store, selection: { resume: manager.current.id } });
	race = async () => { await other.changeMemory({ action: "update", id: memory.id, revision: 1, content: "Unreviewed change" }, "Change after preview"); };
	await assert.rejects(manager.joinProject(preview), /changed|preview|conflict/i);
	assert.equal((await store.loadAny(manager.current.id)).location?.kind, "standalone");
	assert.equal((await manager.listMemories())[0]!.content, "Unreviewed change");
});

test("a captured draft identity cannot read Memory after that session was saved and deleted", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const manager = await SessionManager.open(agent, { workspace, store, deferEmptySessions: true });
	const current = manager.current;
	const draft: SessionRecord = { version: 4, id: current.id, workspace: current.workspace,
		location: { kind: "standalone", workspace: current.workspace }, locationRevision: 0, revision: 0,
		name: null, title: "New session", createdAt: current.createdAt, updatedAt: current.updatedAt,
		forkedFrom: null, history: [], attempt: null };
	await manager.changeMemory({ action: "add", scope: "session", content: "Private definition" }, "Explicitly remember");
	await manager.newSession();
	await manager.delete(draft.id);
	let accessed = false;
	await assert.rejects(store.withMemorySession(executionIdentity(draft), async () => { accessed = true; }, draft), /session/i);
	assert.equal(accessed, false);
});

test("every request refreshes Memory after edits, deletes, restart and fork without injecting history snapshots", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const requests: Message[][] = [];
	const model: Model = async (messages) => { requests.push(structuredClone(messages)); return answer; };
	const manager = await SessionManager.open({ ...agent, model }, { workspace, store });
	const memory = await manager.changeMemory({ action: "add", scope: "session", content: "Old citrus fact" }, "Remember citrus");
	await manager.run("Use my preference");
	assert.match(JSON.stringify(requests.at(-1)), /Old citrus fact/);
	assert.doesNotMatch(JSON.stringify(manager.history), /Harness current memory notice|Old citrus fact/);
	await manager.fork("Private fork");
	assert.deepEqual(await manager.listMemories(), []);
	await manager.run("Continue inherited history");
	assert.doesNotMatch(String(requests.at(-1)![0]!.content), /Old citrus fact/);
	await manager.resume(memory.source.sessionId);
	await manager.changeMemory({ action: "update", id: memory.id, revision: 1, content: "Current citrus fact" }, "Correct citrus");
	await manager.run("Use the correction");
	assert.match(String(requests.at(-1)![0]!.content), /Current citrus fact/);
	assert.doesNotMatch(String(requests.at(-1)![0]!.content), /Old citrus fact/);
	await manager.changeMemory({ action: "delete", id: memory.id, revision: 2 }, "Forget citrus");
	const restored = await SessionManager.open({ ...agent, model }, { workspace, store, selection: { resume: memory.source.sessionId } });
	await restored.run("Check current state");
	assert.match(String(requests.at(-1)![0]!.content), /deleted/);
	assert.doesNotMatch(String(requests.at(-1)![0]!.content), /Current citrus fact/);
});

test("temporary Memory never writes disk and inferred model answers cannot publish records", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const root = join(base, "unused-store");
	const manager = await SessionManager.open(agent, { workspace, persistence: false, store: new SessionStore({ root }) });
	await manager.run("Perhaps remember this inference");
	assert.deepEqual(await manager.listMemories(), []);
	await manager.changeMemory({ action: "add", scope: "global", content: "Temporary preference" }, "Explicit temporary memory");
	await assert.rejects(access(root));
	await manager.newSession();
	assert.equal((await manager.listMemories())[0]!.content, "Temporary preference");
});

test("Memory uses the SDK request budget without changing tool permissions", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const config = loadConfig({ DEEPSEEK_API_KEY: "fake-key", HARNESS_MAX_ITERATIONS: "4" });
	const bodies: { messages: ChatMessage[]; tools: { function: { name: string } }[] }[] = [];
	const transport: typeof fetch = async (_input, init) => {
		const body = JSON.parse(String(init?.body)) as typeof bodies[number];
		bodies.push(body);
		return Response.json({ choices: [{ finish_reason: "stop", message: answer.message }],
			usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } });
	};
	const tools = await createTools(workspace);
	const manager = await SessionManager.open(createAgent(config, tools, transport), { workspace, store });
	await manager.changeMemory({ action: "add", scope: "session", content: "Keep the permission ceiling" }, "Remember permission ceiling");
	await manager.run("Read the remembered preference");
	assert.match(JSON.stringify(bodies[0]!.messages), /Keep the permission ceiling/);
	assert.ok(!bodies[0]!.tools.some((tool) => tool.function.name === "memory"));
	assert.equal(tools.getPermissionState!().permission, "read-only");
	const small = await SessionManager.open(createAgent({ ...config, maxRequestBytes: 1024, autoCompaction: false }, tools, transport),
		{ workspace, store, selection: { resume: manager.current.id } });
	await assert.rejects(small.run("Exceed the actual request byte limit"), /budget|bytes|limit/i);
	assert.equal(bodies.length, 1);
});

test("delegated requests use project Memory while a later independent session cannot read it", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	let reference = "";
	let requests = 0;
	const transport: typeof fetch = async (_input, init) => {
		const body = JSON.parse(String(init?.body)) as { messages: ChatMessage[]; tools: { function: { name: string } }[] };
		requests++;
		const parent = body.tools.some((tool) => tool.function.name === "delegate_task");
		const last = body.messages.at(-1)!;
		let message: unknown = answer.message;
		let finishReason = "stop";
		if (last.role === "user") {
			finishReason = "tool_calls";
			message = { role: "assistant", content: null, tool_calls: [{ id: parent ? "delegate" : "memory-read", type: "function",
				function: { name: parent ? "delegate_task" : "read", arguments: JSON.stringify(parent
					? { task: `Inspect ${reference} and report the remembered definition.` } : { path: reference }) } }] };
		} else if (!parent) {
			assert.match(String(last.content), /Oranges are sour/);
			assert.match(String(body.messages[0]!.content), /Oranges are sour/);
			message = { role: "assistant", content: "Oranges are sour" };
		}
		return Response.json({ choices: [{ finish_reason: finishReason, message }] });
	};
	const config = loadConfig({ DEEPSEEK_API_KEY: "fake-key", HARNESS_MAX_ITERATIONS: "4" });
	const manager = await SessionManager.open(createAgent(config, await createTools(workspace), transport), { workspace, store });
	const project = await manager.createProject("Delegation", workspace);
	await manager.newSession("Project source", project.id);
	const memory = await manager.changeMemory({ action: "add", scope: "project", content: "Oranges are sour" }, "Remember this project definition");
	reference = `memory:${memory.id}@1`;
	await manager.newSession("Project reader");
	await manager.run("Delegate the definition check");
	assert.equal(requests, 4);
	await manager.newSession("Private reader", null);
	await assert.rejects(manager.changeMemory({ action: "update", id: memory.id, revision: 1, content: "Wrong scope" }, "Not authorized"), /available/i);
	assert.deepEqual(await manager.listMemories(), []);
});

test("compacted historical memory remains historical after a current deletion", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const requests: Message[][] = [];
	const manager = await SessionManager.open({ ...agent, compactionModel: async () => ({ ...answer,
		message: { role: "assistant", content: "Historical memory excerpt: Oranges are sour" } }), model: async (messages) => {
		requests.push(structuredClone(messages)); return answer;
	} }, { workspace, store: new SessionStore({ root: join(base, "sessions") }) });
	const memory = await manager.changeMemory({ action: "add", scope: "session", content: "Oranges are sour" }, "Remember oranges");
	await manager.run("Historical discussion: Oranges are sour. " + "Historical details. ".repeat(200));
	await manager.run("A recent conversation");
	await manager.compact();
	await manager.changeMemory({ action: "delete", id: memory.id, revision: 1 }, "Forget oranges");
	await manager.run("Continue after deleting the remembered definition");
	const request = requests.at(-1)!;
	assert.match(String(request[0]!.content), /deleted/);
	assert.doesNotMatch(String(request[0]!.content), /Oranges are sour/);
	assert.match(JSON.stringify(request.slice(1)), /Historical memory excerpt: Oranges are sour/);
});

test("Web UI Memory commands use the shared host boundary with zero model calls", async (t) => {
	const { workspace } = await temporaryWorkspace(t);
	let requests = 0;
	const manager = await SessionManager.open({ ...agent, model: async () => { requests++; return answer; } }, { workspace, persistence: false });
	const controller = await WebUiController.create({ provider: "deepseek", model: "fixture", workspace, permission: "read-only",
		shellPermission: "deny", webPermission: "deny", maxIterations: 4, maxRequestBytes: 96_000, skills: 0, warnings: [] }, manager);
	t.after(() => controller.close());
	controller.submit("/memory add session Oranges are sour");
	const deadline = Date.now() + 5000;
	while (controller.snapshot().busy && Date.now() < deadline) await delay(5);
	assert.equal(controller.snapshot().busy, false);
	assert.equal(controller.snapshot().turns[0]!.status, "answered");
	assert.match(controller.snapshot().turns[0]!.answer!, /Memory saved/);
	assert.equal((await manager.listMemories())[0]!.content, "Oranges are sour");
	assert.deepEqual(manager.history, []);
	assert.equal(requests, 0);
});
