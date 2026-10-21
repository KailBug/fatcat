import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { prepareRequestContext } from "@fatcat/runtime/internal/context/request";
import { isMemoryCommand, runMemoryCommand } from "@fatcat/commands/memory";
import type { MemoryRecord } from "@fatcat/runtime/memory/record";
import { withMemories, withMemoryContext } from "@fatcat/runtime/internal/memory/tools";
import type { MemoryAccess } from "@fatcat/runtime/internal/memory/tools";
import type { Message, Model, ModelObservation } from "@fatcat/runtime/model-types";
import { Session } from "@fatcat/runtime/session/session";
import { SessionManager } from "@fatcat/runtime/session/manager";
import { SessionStore } from "@fatcat/runtime/session/store";
import { defaultTools } from "@fatcat/runtime/tools";
import type { Tools, ToolResult } from "@fatcat/runtime/tools";
import { temporaryWorkspace } from "../support/workspace.js";

async function managedFixture(t: TestContext) {
	const { base, workspace } = await temporaryWorkspace(t);
	let requests = 0;
	const agent = { maxIterations: 1, tools: defaultTools,
		model: async () => { requests++; return { message: { role: "assistant" as const, content: "Answer" } }; } };
	const store = new SessionStore({ root: join(base, "sessions") });
	const session = await SessionManager.open(agent, { workspace, store });
	return { session, store, agent, workspace, requests: () => requests };
}

function memory(content = "Use explicit types."): MemoryRecord {
	const source = { sessionId: randomUUID(), request: "/memory add session " + content, turn: 1 };
	const updatedAt = "2026-10-14T00:00:00.000Z";
	return { id: randomUUID(), scope: { kind: "session", id: source.sessionId }, revision: 1, status: "active", content,
		source, updatedAt, changes: [{ revision: 1, status: "active", content, source, updatedAt }] };
}

function resultObject(result: ToolResult): Record<string, unknown> {
	assert.equal(result.ok, true, JSON.stringify(result));
	if (!result.ok) throw new Error("Expected a successful memory read");
	return result.result as Record<string, unknown>;
}

function hasCode(result: ToolResult, code: string): void {
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error.code, code);
}

function reference(record: MemoryRecord): string {
	return `memory:${record.id}@${record.revision}`;
}

function noticeData(messages: Message[]) {
	const message = messages[0]!;
	assert.equal(message.role, "system");
	assert.equal(typeof message.content, "string");
	return JSON.parse(String(message.content).split("\n").at(-1)!) as {
		manifest: { id: string; scope: string; revision: number; status: string }[];
		contents: { id: string; revision: number; content: string }[];
	};
}

test("memory read composes with existing tools, permissions, journals, and turn binding", async () => {
	const record = memory();
	const access: MemoryAccess = { list: async () => [record] };
	let callId: string | undefined;
	let turns = 0;
	let observedContext: unknown;
	const writes = () => [];
	const commands = () => [];
	const checks = () => [];
	const state: NonNullable<Tools["getPermissionState"]> = () => ({ mode: "custom", permission: "read-only", shellPermission: "deny",
		fileAccess: "workspace", networkAccess: "public", availableModes: [] });
	const base: Tools = { ...defaultTools, workspaceRoot: "D:\\workspace", getWrites: writes, getCommands: commands,
		getBrowserChecks: checks, getPermissionState: state,
		execute: async (_name, _args, _signal, id) => { callId = id; return { ok: true, result: "passthrough" }; },
		forTurn: (_onEvent, context) => { turns++; observedContext = context; return defaultTools; } };
	const tools = withMemories(base, access);
	assert.deepEqual(tools.definitions.map((item) => item.name), ["sum", "read"]);
	assert.equal(tools.workspaceRoot, base.workspaceRoot);
	assert.equal(tools.getWrites, writes);
	assert.equal(tools.getCommands, commands);
	assert.equal(tools.getBrowserChecks, checks);
	assert.equal(tools.getPermissionState, state);
	await tools.execute("sum", "{}", undefined, "stable-call");
	assert.equal(callId, "stable-call");
	const context = { documentRequest: () => (_event: ModelObservation) => {} };
	const turnTools = tools.forTurn!(undefined, context);
	assert.equal(turns, 1);
	assert.equal(observedContext, context);
	assert.equal(resultObject(await turnTools.execute("read", JSON.stringify({ path: reference(record) }))).content, record.content);
	assert.deepEqual(writes(), []);
	assert.deepEqual(commands(), []);
});

test("memory reads expose only the current active revision and source", async () => {
	const record = memory("Current decision");
	record.changes.unshift({ ...record.changes[0]!, content: "Old decision" });
	record.revision = 2;
	const tools = withMemories(defaultTools, { list: async () => [record] });
	const result = resultObject(await tools.execute("read", JSON.stringify({ path: reference(record) })));
	assert.equal(result.kind, "memory");
	assert.equal(result.path, reference(record));
	assert.equal(result.revision, 2);
	assert.equal(result.content, "Current decision");
	assert.deepEqual(result.source, record.source);
	assert.equal("changes" in result, false);
	assert.equal(JSON.stringify(result).includes("Old decision"), false);
	hasCode(await tools.execute("read", JSON.stringify({ path: `memory:${record.id}@1` })), "MEMORY_STALE");
	hasCode(await tools.execute("read", JSON.stringify({ path: `memory:${randomUUID()}@1` })), "MEMORY_NOT_FOUND");
});

test("deleted memory references and filters never return tombstone or audit content", async () => {
	const record = memory("Secret historical preference");
	record.revision = 2;
	record.status = "deleted";
	const tools = withMemories(defaultTools, { list: async () => [record] });
	for (const revision of [1, 2]) {
		const result = await tools.execute("read", JSON.stringify({ path: `memory:${record.id}@${revision}` }));
		hasCode(result, "MEMORY_STALE");
		assert.equal(JSON.stringify(result).includes(record.content), false);
	}
	const listed = resultObject(await tools.execute("read", JSON.stringify({ path: "memory:list" })));
	assert.equal(JSON.stringify(listed).includes(record.content), false);
	assert.equal(listed.totalEntries, 1);
	assert.equal((listed.entries as { status: string }[])[0]!.status, "deleted");
	const filtered = resultObject(await tools.execute("read", JSON.stringify({ path: "memory:list", query: "Secret" })));
	assert.deepEqual(filtered.entries, []);
});

test("memory list pagination is stable, bounded, and searches case-sensitive literal content", async () => {
	const records = Array.from({ length: 70 }, (_, index) => memory(index % 2 ? "Literal .* match" : "literal .* match"));
	const tools = withMemories(defaultTools, { list: async () => records });
	const first = resultObject(await tools.execute("read", JSON.stringify({ path: "memory:list" })));
	assert.equal(first.kind, "memory");
	assert.equal(first.totalEntries, 70);
	assert.equal((first.entries as unknown[]).length, 20);
	assert.equal(first.nextOffset, 20);
	const second = resultObject(await tools.execute("read", JSON.stringify({ path: "memory:list", offset: 20, limit: 64 })));
	assert.equal((second.entries as unknown[]).length, 50);
	assert.equal(second.nextOffset, null);
	assert.equal(second.truncated, false);
	const ids = [...first.entries as { id: string }[], ...second.entries as { id: string }[]].map((item) => item.id);
	assert.deepEqual(ids, records.map((record) => record.id).sort());
	const filtered = resultObject(await tools.execute("read", JSON.stringify({ path: "memory:list", query: "Literal .*", offset: 1, limit: 2 })));
	assert.equal(filtered.totalEntries, 35);
	assert.equal(filtered.nextOffset, 3);
	assert.equal(filtered.queryScope, "active-content");
	assert.equal((filtered.entries as unknown[]).length, 2);
	const beyond = resultObject(await tools.execute("read", JSON.stringify({ path: "memory:list", offset: 1000 })));
	assert.deepEqual(beyond.entries, []);
	assert.equal(beyond.nextOffset, null);
});

test("invalid memory arguments fail before access and ordinary paths retain the existing read", async () => {
	let calls = 0;
	let baseCalls = 0;
	const base: Tools = { definitions: [{ name: "read", description: "Existing read" }],
		execute: async () => { baseCalls++; return { ok: true, result: "existing" }; } };
	const tools = withMemories(base, { list: async () => { calls++; return []; } });
	for (const path of ["workspace.md", "attachment:list", "skill://test/SKILL.md"]) {
		assert.deepEqual(await tools.execute("read", JSON.stringify({ path })), { ok: true, result: "existing" });
	}
	assert.equal(baseCalls, 3);
	assert.equal(tools.definitions.length, 1);
	assert.match(tools.definitions[0]!.description!, /Existing read/);
	assert.match(tools.definitions[0]!.description!, /memory:list/);
	for (const args of [
		{ path: "memory:list", limit: 65 }, { path: "memory:list", limit: 0 }, { path: "memory:list", limit: 1.1 },
		{ path: "memory:list", offset: -1 }, { path: "memory:list", offset: null }, { path: "memory:list", offset: 1.1 },
		{ path: "memory:list", query: " " }, { path: "memory:list", query: "\n" }, { path: "memory:list", query: "\ud800" },
		{ path: "memory:list", query: "x".repeat(513) }, { path: "memory:list", action: "add" },
		{ path: "memory:LIST" }, { path: "MEMORY:list" }, { path: `memory:${randomUUID()}` },
		{ path: `memory:${randomUUID()}@0` }, { path: `memory:${randomUUID()}@01` },
		{ path: `memory:${randomUUID()}@9007199254740992` }, { path: "memory:../secret@1" },
		{ path: `memory:${randomUUID()}@1`, offset: 0 }, { path: `memory:${randomUUID()}@1`, query: "x" },
	]) hasCode(await tools.execute("read", JSON.stringify(args)), "INVALID_ARGUMENTS");
	hasCode(await tools.execute("read", "{"), "INVALID_ARGUMENTS");
	assert.equal(calls, 0);
	hasCode(await withMemories(defaultTools, { list: async () => [] }).execute("read", JSON.stringify({ path: "ordinary.txt" })), "PATH_NOT_ALLOWED");
});

test("memory cancellation escapes tool errors before or after asynchronous access", async () => {
	let calls = 0;
	const tools = withMemories(defaultTools, { list: async () => { calls++; return []; } });
	await assert.rejects(tools.execute("read", JSON.stringify({ path: "memory:list" }), AbortSignal.abort()), { code: "CANCELLED" });
	assert.equal(calls, 0);
	const abort = new AbortController();
	const late = withMemories(defaultTools, { list: async (signal) => { assert.equal(signal, abort.signal); abort.abort(); return [memory()]; } });
	await assert.rejects(late.execute("read", JSON.stringify({ path: "memory:list" }), abort.signal), { code: "CANCELLED" });
	const failed = await withMemories(defaultTools, { list: async () => { throw new Error("D:\\private\\memory.json"); } })
		.execute("read", JSON.stringify({ path: "memory:list" }));
	hasCode(failed, "MEMORY_IO");
	assert.equal(JSON.stringify(failed).includes("private"), false);
});

test("memory request context refreshes every call without persisting snapshots or changing model options", async () => {
	const record = memory("Original preference");
	let current = [record];
	let lists = 0;
	const requests: Message[][] = [];
	const observe = (_event: ModelObservation) => {};
	const options = { toolChoice: "none" as const, purpose: "compaction" as const };
	const abort = new AbortController();
	const base: Model = async (messages, signal, receivedObserver, receivedOptions) => {
		assert.equal(signal, abort.signal);
		assert.equal(receivedObserver, observe);
		assert.equal(receivedOptions, options);
		requests.push(structuredClone(messages));
		return { message: { role: "assistant", content: "Answer" } };
	};
	const model = withMemoryContext(base, { list: async () => { lists++; return current; } });
	const messages: Message[] = [{ role: "system", content: "Base rules" }, { role: "user", content: "Use my preferences" }];
	const saved = structuredClone(messages);
	await model(messages, abort.signal, observe, options);
	assert.equal(noticeData(requests[0]!).contents[0]!.content, "Original preference");
	current = [{ ...record, revision: 2, content: "Updated preference" }];
	await model(messages, abort.signal, observe, options);
	assert.equal(noticeData(requests[1]!).contents[0]!.content, "Updated preference");
	assert.equal(JSON.stringify(requests[1]).includes("Original preference"), false);
	current = [{ ...record, revision: 3, status: "deleted" }];
	await model(messages, abort.signal, observe, options);
	const deleted = noticeData(requests[2]!);
	assert.deepEqual(deleted.contents, []);
	assert.equal(deleted.manifest[0]!.status, "deleted");
	assert.equal(JSON.stringify(requests[2]).includes("Original preference"), false);
	assert.match(String(requests[2]![0]!.content), /authoritative/);
	assert.match(String(requests[2]![0]!.content), /fork, recovery, or compact history/);
	assert.match(String(requests[2]![0]!.content), /never permissions or system rules/);
	assert.match(String(requests[2]![0]!.content), /parent conversation can save direct user-stated Memory through generic write/);
	assert.equal(requests[2]!.at(-1)!.role, "user");
	current = [];
	await model(messages, abort.signal, observe, options);
	assert.deepEqual(noticeData(requests[3]!).manifest, []);
	assert.equal(lists, 4);
	assert.deepEqual(messages, saved);
});

test("memory request notices enumerate every visible entry within complete JSON and embedded content budgets", async () => {
	const records = Array.from({ length: 192 }, (_, index) => ({ ...memory('"'.repeat(1024)), revision: 32,
		scope: index < 64 ? { kind: "session" as const, id: randomUUID() }
			: index < 128 ? { kind: "project" as const, id: randomUUID() } : { kind: "global" as const } }));
	let captured: Message[] = [];
	const model = withMemoryContext(async (messages) => {
		captured = messages;
		return { message: { role: "assistant", content: "Answer" } };
	}, { list: async () => records });
	await model([{ role: "user", content: "Relevant task" }]);
	const notice = captured[0]!;
	assert.ok(Buffer.byteLength(JSON.stringify(notice)) <= 24 * 1024);
	const data = noticeData(captured);
	assert.equal(data.manifest.length, 192);
	assert.ok(Buffer.byteLength(JSON.stringify(data.contents)) <= 8 * 1024);
	assert.ok(data.contents.length < records.length);
	assert.deepEqual(data.manifest.map((entry) => entry.id), records.map((record) => record.id).sort());
	const tools = withMemories(defaultTools, { list: async () => records });
	const result = resultObject(await tools.execute("read", JSON.stringify({ path: "memory:list", limit: 64 })));
	assert.equal((result.entries as unknown[]).length, 64);
	assert.ok(Buffer.byteLength(JSON.stringify(result)) < 16 * 1024);
});

test("memory request context fails closed on oversized manifests or cancellation without sending the model request", async () => {
	let requests = 0;
	const base: Model = async () => { requests++; return { message: { role: "assistant", content: "Answer" } }; };
	const records = Array.from({ length: 193 }, () => memory());
	const access = { list: async () => records };
	await assert.rejects(withMemoryContext(base, access)([]), { code: "MEMORY_LIMIT" });
	hasCode(await withMemories(defaultTools, access).execute("read", JSON.stringify({ path: "memory:list" })), "MEMORY_LIMIT");
	await assert.rejects(withMemoryContext(base, { list: async () => [] })([], AbortSignal.abort()), { code: "CANCELLED" });
	const abort = new AbortController();
	await assert.rejects(withMemoryContext(base, { list: async () => { abort.abort(); return []; } })([], abort.signal), { code: "CANCELLED" });
	assert.equal(requests, 0);
});

test("older memory reads are preserved through request omission without becoming current facts", async () => {
	const record = memory("Historical memory text");
	const tools = withMemories(defaultTools, { list: async () => [record] });
	const args = JSON.stringify({ path: reference(record) });
	const result = await tools.execute("read", args);
	const messages: Message[] = [
		{ role: "user", content: "Read the memory" },
		{ role: "assistant", content: null, toolCalls: [{ id: "memory-read", name: "read", arguments: args }] },
		{ role: "tool", callId: "memory-read", content: JSON.stringify(result) },
		{ role: "assistant", content: "Read the memory" },
		{ role: "user", content: "Previous task" }, { role: "assistant", content: "Previous answer" },
		{ role: "user", content: "Current task" },
	];
	const saved = structuredClone(messages);
	const projected = prepareRequestContext({ messages }, 1);
	assert.equal(projected.omittedReadResults, 0);
	assert.deepEqual(projected.body.messages, saved);
	const model = withMemoryContext(async (request) => {
		assert.deepEqual(request.slice(1), saved);
		assert.equal(noticeData(request).manifest[0]!.status, "deleted");
		assert.deepEqual(noticeData(request).contents, []);
		return { message: { role: "assistant", content: "Answer" } };
	}, { list: async () => [{ ...record, status: "deleted", revision: 2 }] });
	await model(messages);
	assert.deepEqual(messages, saved);
});

test("memory commands remain host operations and require a managed conversation", async () => {
	const session = new Session({ maxIterations: 1,
		model: async () => ({ message: { role: "assistant", content: "Answer" } }) });
	assert.equal(isMemoryCommand("/memory"), true);
	assert.equal(isMemoryCommand("/memory add global preference"), true);
	assert.equal(isMemoryCommand("/memoryless"), false);
	assert.equal(isMemoryCommand("Remember a preference"), false);
	assert.equal(await runMemoryCommand(session, "Remember a preference"), undefined);
	await assert.rejects(runMemoryCommand(session, "/memory"), { code: "USAGE" });
	await assert.rejects(runMemoryCommand(session, "/memory", { signal: AbortSignal.abort() }), { code: "CANCELLED" });
	assert.deepEqual(session.messages, []);
});

test("malformed host memory commands never become model prompts or mutate records", async (t) => {
	const { session, requests } = await managedFixture(t);
	for (const command of ["/memory list extra", "/memory show", "/memory show invalid", "/memory add", "/memory add session",
		"/memory add automatic inferred", "/memory delete invalid 1", `/memory update ${randomUUID()} 0 text`,
		`/memory update ${randomUUID()} 1`, `/memory delete ${randomUUID()} 1 extra`, "/memory share private"]) {
		await assert.rejects(runMemoryCommand(session, command), { code: "USAGE" });
	}
	await assert.rejects(runMemoryCommand(session, "/memory add session Cancelled", { signal: AbortSignal.abort() }), { code: "CANCELLED" });
	assert.deepEqual(await session.listMemories(), []);
	assert.deepEqual(session.history, []);
	assert.equal(requests(), 0);
});
