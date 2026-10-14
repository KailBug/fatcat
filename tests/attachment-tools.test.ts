import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { setImmediate } from "node:timers";
import test from "node:test";
import { attachmentReference } from "../src/attachments/record.js";
import type { AttachmentInfo } from "../src/attachments/record.js";
import { readAttachmentContent } from "../src/attachments/read.js";
import { withAttachments } from "../src/attachments/tools.js";
import type { AttachmentAccess } from "../src/attachments/tools.js";
import { prepareRequestContext } from "../src/context/request.js";
import { HarnessError } from "../src/errors.js";
import type { Message } from "../src/model.js";
import { defaultTools } from "../src/tools.js";
import type { Tools, ToolResult } from "../src/tools.js";

function original(content: string | Uint8Array, name = "notes.md"): { record: AttachmentInfo; bytes: Uint8Array } {
	const bytes = typeof content === "string" ? Buffer.from(content) : content;
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	return { record: { id: randomUUID(), contentVersion: sha256, sha256, name, mediaType: "text/markdown", size: bytes.byteLength,
		createdAt: "2026-10-13T00:00:00.000Z", uploaderSessionId: randomUUID(), scopeRevision: 1, removed: false, deleted: false }, bytes };
}

function resultObject(result: ToolResult): Record<string, unknown> {
	assert.equal(result.ok, true, JSON.stringify(result));
	if (!result.ok) throw new Error("Expected successful tool result");
	assert.equal(typeof result.result, "object");
	return result.result as Record<string, unknown>;
}

function hasCode(result: ToolResult, code: string): void {
	assert.equal(result.ok, false);
	if (!result.ok) assert.equal(result.error.code, code);
}

test("attachment reading preserves immutable references, line endings, empty text and page coverage", async () => {
	const { record, bytes } = original("first\r\n\u7b2c\u4e8c\u884c\n\nlast");
	const first = await readAttachmentContent(record, bytes, { limit: 2 });
	assert.equal(first.kind, "file");
	if (first.kind !== "file") return;
	assert.equal(first.path, attachmentReference(record));
	assert.equal(first.citation, `${attachmentReference(record)}#L1-L2`);
	assert.equal(first.content, "first\r\n\u7b2c\u4e8c\u884c\n");
	assert.equal(first.totalLines, 4);
	assert.equal(first.startLine, 1);
	assert.equal(first.endLine, 2);
	assert.equal(first.nextOffset, 2);
	assert.deepEqual(first.coverage, { mode: "lines", complete: false });
	const last = await readAttachmentContent(record, bytes, { offset: first.nextOffset! });
	assert.equal(last.kind, "file");
	if (last.kind !== "file") return;
	assert.equal(last.content, "\nlast");
	assert.equal(last.nextOffset, null);
	assert.equal(last.coverage.complete, false);
	const whole = await readAttachmentContent(record, bytes);
	assert.equal(whole.coverage.complete, true);
	const empty = original("");
	const emptyRead = await readAttachmentContent(empty.record, empty.bytes);
	assert.equal(emptyRead.kind, "file");
	if (emptyRead.kind !== "file") return;
	assert.equal(emptyRead.totalLines, 0);
	assert.equal(emptyRead.startLine, null);
	assert.equal(emptyRead.content, "");
	assert.equal(emptyRead.coverage.complete, true);
});

test("attachment literal search returns real source lines and matching-line pagination", async () => {
	const { record, bytes } = original("dot .* \u4e2d\u6587\nno match\ndot .* \u4e2d\u6587\nDOT .* \u4e2d\u6587\n");
	const result = await readAttachmentContent(record, bytes, { query: "dot .* \u4e2d\u6587", offset: 1, limit: 1 });
	assert.equal(result.kind, "search");
	if (result.kind !== "search") return;
	assert.equal(result.totalMatches, 2);
	assert.equal(result.totalLines, 4);
	assert.equal(result.nextOffset, null);
	assert.equal(result.complete, true);
	assert.deepEqual(result.coverage, { mode: "literal-search", complete: true });
	assert.deepEqual(result.matches, [{ path: attachmentReference(record), line: 3, text: "dot .* \u4e2d\u6587",
		citation: `${attachmentReference(record)}#L3-L3` }]);
	const noMatch = await readAttachmentContent(record, bytes, { query: "missing" });
	assert.equal(noMatch.kind, "search");
	if (noMatch.kind === "search") assert.deepEqual(noMatch.matches, []);
});

test("attachment pages never skip long lines and originals larger than workspace text remain readable", async () => {
	const { record, bytes } = original("a".repeat(9000) + "\n" + "b".repeat(9000) + "\n");
	const first = await readAttachmentContent(record, bytes);
	assert.equal(first.nextOffset, 1);
	const second = await readAttachmentContent(record, bytes, { offset: first.nextOffset! });
	assert.equal(second.kind, "file");
	if (second.kind === "file") assert.equal(second.content, "b".repeat(9000) + "\n");
	const long = original("x".repeat(16385));
	await assert.rejects(readAttachmentContent(long.record, long.bytes), { code: "OUTPUT_LIMIT" });
	const large = original(("x".repeat(200) + "\n").repeat(6000));
	const page = await readAttachmentContent(large.record, large.bytes, { offset: 5999 });
	assert.equal(page.kind, "file");
	if (page.kind === "file") assert.equal(page.startLine, 6000);
	const oversized = original(new Uint8Array(16 * 1024 * 1024 + 1));
	await assert.rejects(readAttachmentContent(oversized.record, oversized.bytes), { code: "FILE_TOO_LARGE" });
});

test("unsupported formats, malformed text and cancellation never become successful empty documents", async () => {
	for (const item of [original("binary document", "report.pdf"), original("image", "scan.png"), original("PK", "report.docx"),
		original(new Uint8Array([0xc3, 0x28])), original("a\u0000b")]) {
		await assert.rejects(readAttachmentContent(item.record, item.bytes), { code: "ATTACHMENT_UNSUPPORTED" });
	}
	const item = original("line\n".repeat(20000));
	await assert.rejects(readAttachmentContent(item.record, item.bytes, {}, AbortSignal.abort()), { code: "CANCELLED" });
	const abort = new AbortController();
	const reading = readAttachmentContent(item.record, item.bytes, {}, abort.signal);
	setImmediate(() => abort.abort());
	await assert.rejects(reading, { code: "CANCELLED" });
});

test("attachment read wrapper filters names separately and preserves access binding across turn wrappers", async () => {
	const first = original("Private evidence", "alpha.md");
	const second = original("alpha in content", "beta.md");
	const items = [second, first];
	let reads = 0;
	const access: AttachmentAccess = { list: async () => items.map((item) => item.record), read: async (reference, options) => {
		reads++;
		const item = items.find((candidate) => attachmentReference(candidate.record) === reference);
		if (!item) throw new HarnessError("ATTACHMENT_NOT_FOUND", "That attachment is not available in this scope.");
		return readAttachmentContent(item.record, item.bytes, options, options.signal);
	} };
	let turns = 0;
	let callId: string | undefined;
	const writes = () => [];
	const commands = () => [];
	const base: Tools = { ...defaultTools, workspaceRoot: "D:\\workspace", getWrites: writes, getCommands: commands,
		execute: async (_name, _args, _signal, id) => { callId = id; return { ok: true, result: "passthrough" }; },
		forTurn: () => { turns++; return defaultTools; } };
	const tools = withAttachments(base, access);
	assert.equal(tools.workspaceRoot, base.workspaceRoot);
	assert.equal(tools.getWrites, writes);
	assert.equal(tools.getCommands, commands);
	assert.deepEqual(tools.definitions.map((item) => item.function.name), ["sum", "read"]);
	await tools.execute("sum", "{}", undefined, "known-call");
	assert.equal(callId, "known-call");
	const list = resultObject(await tools.execute("read", JSON.stringify({ path: "attachment:list", query: "alpha" })));
	assert.equal(list.queryScope, "name");
	assert.equal(list.totalEntries, 1);
	assert.equal(reads, 0);
	const turnTools = tools.forTurn!();
	assert.equal(turns, 1);
	const read = resultObject(await turnTools.execute("read", JSON.stringify({ path: attachmentReference(first.record) })));
	assert.equal(read.content, "Private evidence");
	const foreign = original("Foreign scope evidence");
	hasCode(await turnTools.execute("read", JSON.stringify({ path: attachmentReference(foreign.record) })), "ATTACHMENT_NOT_FOUND");
	assert.equal(reads, 2);
});

test("attachment wrapping preserves existing read behavior and rejects malformed or unversioned references", async () => {
	let calls = 0;
	const base: Tools = { definitions: [{ type: "function", function: { name: "read", description: "Existing read" } }],
		execute: async () => { calls++; return { ok: true, result: "existing" }; } };
	const access: AttachmentAccess = { list: async () => [], read: async () => { throw new Error("Must not run"); } };
	const tools = withAttachments(base, access);
	for (const path of ["workspace.md", "skill://example/SKILL.md"]) {
		assert.deepEqual(await tools.execute("read", JSON.stringify({ path })), { ok: true, result: "existing" });
	}
	assert.equal(calls, 2);
	assert.equal(tools.definitions.length, 1);
	for (const args of [
		{ path: "attachment:list", limit: 201 }, { path: "attachment:list", offset: null },
		{ path: "attachment:list", limit: 0 }, { path: "attachment:list", query: "\n" },
		{ path: "attachment:list", unexpected: true }, { path: "attachment:list", offset: -1 },
		{ path: "attachment:list", query: "\ud800" }, { path: "attachment:list", limit: 1.5 },
	]) hasCode(await tools.execute("read", JSON.stringify(args)), "INVALID_ARGUMENTS");
	for (const path of [`attachment:${randomUUID()}`, "attachment:../secret@version", "attachment:LIST"]) {
		assert.equal((await tools.execute("read", JSON.stringify({ path }))).ok, false);
	}
	hasCode(await tools.execute("read", "{"), "INVALID_ARGUMENTS");
	assert.equal(calls, 2);
});

test("attachment tool cancellation escapes and unexpected I/O failures hide local storage details", async () => {
	const record = original("text").record;
	const access: AttachmentAccess = { list: async () => { throw new Error("D:\\private\\storage"); },
		read: async () => { throw new Error("D:\\private\\storage"); } };
	const tools = withAttachments(defaultTools, access);
	const failed = await tools.execute("read", JSON.stringify({ path: attachmentReference(record) }));
	hasCode(failed, "ATTACHMENT_IO");
	assert.equal(JSON.stringify(failed).includes("private"), false);
	await assert.rejects(tools.execute("read", JSON.stringify({ path: "attachment:list" }), AbortSignal.abort()), { code: "CANCELLED" });
	hasCode(await tools.execute("read", JSON.stringify({ path: "outside.md" })), "PATH_NOT_ALLOWED");
});

test("context omission preserves exact attachment versions and rereading still checks the current access boundary", async () => {
	const originalFile = original(("Evidence " + "x".repeat(500) + "\n").repeat(20));
	const replacement = original("Different evidence under the same name");
	const reference = attachmentReference(originalFile.record);
	let allowed = true;
	const access: AttachmentAccess = { list: async () => [replacement.record], read: async (requested, options) => {
		if (!allowed) throw new HarnessError("ATTACHMENT_SCOPE", "The attachment is not available in this scope.");
		assert.equal(requested, reference);
		return readAttachmentContent(originalFile.record, originalFile.bytes, options, options.signal);
	} };
	const tools = withAttachments(defaultTools, access);
	for (const query of [undefined, "Evidence"]) {
		const args = JSON.stringify({ path: reference, offset: 2, limit: 5, ...(query ? { query } : {}) });
		const read = await tools.execute("read", args);
		const messages: Message[] = [
			{ role: "user", content: "Read the original evidence" },
			{ role: "assistant", content: null, tool_calls: [{ id: "original", type: "function", function: { name: "read", arguments: args } }] },
			{ role: "tool", tool_call_id: "original", content: JSON.stringify(read) },
			{ role: "assistant", content: `[Original evidence](${reference}#L3-L7)` },
			{ role: "user", content: "A later task" },
			{ role: "assistant", content: "Later answer" },
			{ role: "user", content: "Recheck the original source" },
		];
		const saved = structuredClone(messages);
		const projected = prepareRequestContext({ messages }, 1);
		assert.equal(projected.omittedReadResults, 1);
		assert.deepEqual(messages, saved);
		const omitted = JSON.parse(String(projected.body.messages[2]!.content));
		assert.equal(omitted.result.kind, "context_omitted");
		assert.equal(omitted.result.path, reference);
		assert.equal(omitted.result.originalKind, query ? "search" : "file");
		const call = projected.body.messages[1];
		assert.ok(call?.role === "assistant" && call.tool_calls?.[0]?.type === "function");
		const restoredArgs = call.tool_calls[0].function.arguments;
		assert.equal(restoredArgs, args);
		assert.deepEqual(await tools.execute("read", restoredArgs), read);
		assert.ok(!JSON.stringify(read).includes("Different evidence"));
		allowed = false;
		hasCode(await tools.execute("read", restoredArgs), "ATTACHMENT_SCOPE");
		allowed = true;
	}
});
