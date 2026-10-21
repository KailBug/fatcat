import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { HarnessError } from "@fatcat/runtime/errors";
import type { MemoryRecord } from "@fatcat/runtime/memory/record";
import { maxMemoryContentBytes, maxMemoryRequestBytes } from "@fatcat/runtime/memory/record";
import { memoryWriteGuidance, withMemoryWriter } from "@fatcat/runtime/internal/memory/write";
import type { MemoryWriteRequest } from "@fatcat/runtime/internal/memory/write";
import { defaultTools } from "@fatcat/runtime/tools";
import type { Tools, ToolResult } from "@fatcat/runtime/tools";

function record(content = "The dog likes CSGO."): MemoryRecord {
	const source = { sessionId: randomUUID(), request: "Remember that the dog likes CSGO.", turn: 1 };
	const change = { revision: 1, content, status: "active" as const, source, updatedAt: "2026-10-14T00:00:00.000Z" };
	return { id: randomUUID(), scope: { kind: "session", id: source.sessionId }, ...change, changes: [change] };
}

function resultObject(result: ToolResult): Record<string, unknown> {
	assert.equal(result.ok, true, JSON.stringify(result));
	if (!result.ok) throw new Error("Expected successful memory write");
	return result.result as Record<string, unknown>;
}

function hasCode(result: ToolResult, code: string): void {
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error.code, code);
}

test("generic memory write routes local, explicit global, correction, and deletion with exact evidence", async () => {
	const current = record();
	const requests: MemoryWriteRequest[] = [];
	const calls: Array<string | undefined> = [];
	const controller = new AbortController();
	const tools = withMemoryWriter(defaultTools, async (request, signal, callId) => {
		assert.equal(signal, controller.signal);
		requests.push(request);
		calls.push(callId);
		return request.action === "delete" ? { ...current, revision: 2, status: "deleted", content: "" } : current;
	});
	const evidence = "  Remember that the dog likes CSGO.\n";
	const write = (path: string, content: string) => tools.execute("write", JSON.stringify({ path, content, memoryEvidence: evidence }), controller.signal, "memory-call");
	const saved = resultObject(await write("memory:new", current.content));
	assert.deepEqual(requests[0], { action: "add", content: current.content, evidence });
	assert.equal(saved.kind, "memory");
	assert.equal(saved.path, `memory:${current.id}@1`);
	assert.equal(saved.scope, "session");
	assert.deepEqual(saved.source, current.source);
	assert.equal("changes" in saved, false);
	await write("memory:global:new", "Use concise replies across projects.");
	assert.deepEqual(requests[1], { action: "add", scope: "global", content: "Use concise replies across projects.", evidence });
	await write(`memory:${current.id}@1`, "The dog likes another game.");
	assert.deepEqual(requests[2], { action: "update", id: current.id, revision: 1, content: "The dog likes another game.", evidence });
	const deleted = resultObject(await write(`memory:${current.id}@1`, ""));
	assert.deepEqual(requests[3], { action: "delete", id: current.id, revision: 1, evidence });
	assert.equal(deleted.status, "deleted");
	assert.equal("content" in deleted, false);
	assert.equal("changes" in deleted, false);
	assert.deepEqual(calls, Array(4).fill("memory-call"));
});

test("memory writer preserves ordinary tool and file arguments without bypassing existing execution", async () => {
	const received: unknown[][] = [];
	let memories = 0;
	const base: Tools = { definitions: [{ name: "write", description: "Existing write" }],
		execute: async (...args) => { received.push(args); return { ok: true, result: "existing" }; } };
	const tools = withMemoryWriter(base, async () => { memories++; return record(); });
	const controller = new AbortController();
	for (const [name, args] of [
		["read", '{"path":"memory:list"}'], ["write", '{"path":"notes.txt","content":"Text"}'],
		["write", '{"path":"notes.txt","oldText":"before","newText":"after"}'],
		["write", "null"], ["write", "[]"],
	]) {
		assert.deepEqual(await tools.execute(name!, args!, controller.signal, "file-call"), { ok: true, result: "existing" });
		assert.deepEqual(received.at(-1), [name, args, controller.signal, "file-call"]);
	}
	const priorCalls = received.length;
	hasCode(await tools.execute("write", '{"path":"notes.txt","content":"Text","memoryEvidence":"User evidence"}'), "INVALID_ARGUMENTS");
	hasCode(await tools.execute("write", '{"content":"Text","memoryEvidence":"User evidence"}'), "INVALID_ARGUMENTS");
	assert.equal(received.length, priorCalls);
	assert.equal(memories, 0);
});

test("memory writer validates strict references, argument shapes, Unicode, and UTF-8 byte budgets before execution", async () => {
	let calls = 0;
	const current = record();
	const tools = withMemoryWriter(defaultTools, async () => { calls++; return current; });
	const valid = { path: "memory:new", content: "Durable preference", memoryEvidence: "Remember my preference" };
	for (const args of [
		{ ...valid, extra: true }, { ...valid, oldText: "before", newText: "after" },
		{ ...valid, scope: "global" }, { ...valid, sessionId: randomUUID() },
		{ path: valid.path, content: valid.content }, { ...valid, memoryEvidence: null }, { ...valid, memoryEvidence: " \n " },
		{ ...valid, memoryEvidence: "\ud800" }, { ...valid, content: "\ud800" },
		{ ...valid, content: "" }, { ...valid, content: " \n " },
		{ ...valid, path: "memory:NEW" }, { ...valid, path: "MEMORY:new" }, { ...valid, path: "memory:project:new" },
		{ ...valid, path: "memory:../outside@1" }, { ...valid, path: `memory:${current.id}` },
		{ ...valid, path: `memory:${current.id}@0` }, { ...valid, path: `memory:${current.id}@01` },
		{ ...valid, path: `memory:${current.id}@9007199254740992` }, { ...valid, path: "memory:" + "x".repeat(1024) },
		{ ...valid, content: null },
	]) hasCode(await tools.execute("write", JSON.stringify(args)), "INVALID_ARGUMENTS");
	hasCode(await tools.execute("write", "{"), "INVALID_ARGUMENTS");
	assert.equal(calls, 0);
	for (const args of [
		{ ...valid, content: "x".repeat(maxMemoryContentBytes + 1) },
		{ ...valid, content: "字".repeat(Math.ceil(maxMemoryContentBytes / 3)) },
		{ ...valid, memoryEvidence: "x".repeat(maxMemoryRequestBytes + 1) },
		{ ...valid, memoryEvidence: "字".repeat(Math.ceil(maxMemoryRequestBytes / 3)) },
	]) hasCode(await tools.execute("write", JSON.stringify(args)), "MEMORY_LIMIT");
	assert.equal(calls, 0);
	assert.equal((await tools.execute("write", JSON.stringify({ ...valid,
		content: "x".repeat(maxMemoryContentBytes), memoryEvidence: "x".repeat(maxMemoryRequestBytes) }))).ok, true);
	assert.equal(calls, 1);
});

test("memory writer reports unavailable bindings, stale revisions, and safe save failures", async () => {
	const args = JSON.stringify({ path: "memory:new", content: "Preference", memoryEvidence: "Remember my preference" });
	hasCode(await withMemoryWriter().execute("write", args), "MEMORY_UNAVAILABLE");
	hasCode(await withMemoryWriter().execute("write", JSON.stringify({ path: "memory:new", content: "Preference" })), "INVALID_ARGUMENTS");
	const stale = withMemoryWriter(defaultTools, async () => { throw new HarnessError("MEMORY_CONFLICT", "The memory changed. Read its latest revision."); });
	hasCode(await stale.execute("write", args), "MEMORY_CONFLICT");
	const denied = withMemoryWriter(defaultTools, async () => { throw new HarnessError("MEMORY_EVIDENCE", "The user did not state that fact."); });
	hasCode(await denied.execute("write", args), "MEMORY_EVIDENCE");
	const failed = await withMemoryWriter(defaultTools, async () => { throw new Error("D:\\private\\credentials.json"); }).execute("write", args);
	hasCode(failed, "MEMORY_IO");
	assert.equal(JSON.stringify(failed).includes("credentials"), false);
	assert.equal(JSON.stringify(failed).includes("private"), false);
});

test("memory writer observes cancellation before mutation and preserves a committed executor result", async () => {
	const args = JSON.stringify({ path: "memory:new", content: "Preference", memoryEvidence: "Remember my preference" });
	let calls = 0;
	const tools = withMemoryWriter(defaultTools, async () => { calls++; return record(); });
	await assert.rejects(tools.execute("write", args, AbortSignal.abort()), { code: "CANCELLED" });
	assert.equal(calls, 0);
	const controller = new AbortController();
	const cancelled = withMemoryWriter(defaultTools, async () => { controller.abort(); throw new HarnessError("CANCELLED", "Cancelled before commit."); });
	await assert.rejects(cancelled.execute("write", args, controller.signal), { code: "CANCELLED" });
	const committed = new AbortController();
	const complete = record();
	const afterPublication = withMemoryWriter(defaultTools, async () => { committed.abort(); return complete; });
	assert.equal(resultObject(await afterPublication.execute("write", args, committed.signal)).id, complete.id);
});

test("memory writer preserves workspace metadata, permission functions, journals, and turn context", async () => {
	let turns = 0;
	let receivedContext: unknown;
	let writes = 0;
	const getWrites = () => [];
	const getCommands = () => [];
	const getBrowserChecks = () => [];
	const getPermissionState: NonNullable<Tools["getPermissionState"]> = () => ({ mode: "custom", permission: "read-only", shellPermission: "deny",
		fileAccess: "workspace", networkAccess: "public", availableModes: [] });
	const base: Tools = { ...defaultTools, workspaceRoot: "D:\\workspace", getWrites, getCommands, getBrowserChecks, getPermissionState,
		forTurn: (_onEvent, context) => { turns++; receivedContext = context; return defaultTools; } };
	const tools = withMemoryWriter(base, async () => { writes++; return record(); });
	assert.equal(tools.workspaceRoot, base.workspaceRoot);
	assert.equal(tools.getWrites, getWrites);
	assert.equal(tools.getCommands, getCommands);
	assert.equal(tools.getBrowserChecks, getBrowserChecks);
	assert.equal(tools.getPermissionState, getPermissionState);
	const context = { documentRequest: () => () => {} };
	const turnTools = tools.forTurn!(undefined, context);
	assert.equal(turns, 1);
	assert.equal(receivedContext, context);
	assert.equal((await turnTools.execute("write", JSON.stringify({ path: "memory:new", content: "Preference", memoryEvidence: "Remember preference" }))).ok, true);
	assert.equal(writes, 1);
	assert.deepEqual(getWrites(), []);
});

test("memory writer extends existing write definitions and preserves original create/edit schema alternatives", async () => {
	const create = { required: ["path", "content"] };
	const edit = { required: ["path", "oldText", "newText"] };
	const properties = { path: { type: "string" }, content: { type: "string" }, oldText: { type: "string" }, newText: { type: "string" } };
	const definition = { name: "write", description: "Existing file semantics.", parameters: { type: "object", properties, required: ["path"], additionalProperties: false, oneOf: [create, edit] } };
	const original = structuredClone(definition);
	const tools = withMemoryWriter({ ...defaultTools, definitions: [definition] }, async () => record());
	assert.equal(tools.definitions.length, 1);
	const extended = tools.definitions[0]!;
	assert.match(extended.description!, /Existing file semantics/);
	assert.match(extended.description!, /do not require a \/memory command/);
	assert.equal(extended.name, "write");
	const parameters = extended.parameters!;
	assert.deepEqual(parameters.required, ["path"]);
	assert.equal(parameters.additionalProperties, false);
	const extendedProperties = parameters.properties as Record<string, unknown>;
	assert.deepEqual(extendedProperties.oldText, properties.oldText);
	assert.ok(extendedProperties.memoryEvidence);
	const alternatives = parameters.oneOf as { allOf?: unknown[]; required?: string[] }[];
	assert.equal(alternatives.length, 3);
	assert.deepEqual(alternatives[0]!.allOf, [create, { not: { required: ["memoryEvidence"] } }]);
	assert.deepEqual(alternatives[1]!.allOf, [edit, { not: { required: ["memoryEvidence"] } }]);
	assert.deepEqual(alternatives[2]!.required, ["path", "content", "memoryEvidence"]);
	assert.deepEqual(definition, original);
	assert.deepEqual(withMemoryWriter().definitions.map((item) => item.name), ["sum", "write"]);
	assert.doesNotMatch(withMemoryWriter().definitions.at(-1)!.description!, /persistence is unavailable/);
	assert.match(memoryWriteGuidance, /exact excerpt/);
	assert.match(memoryWriteGuidance, /Never persist inferred facts/);
});
