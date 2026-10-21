import type { ChatMessage } from "../support/chat-protocol.js";
import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createAgent } from "@fatcat/runtime/agent";
import { attachmentReference, parseAttachmentReference } from "@fatcat/runtime/attachments/record";
import { loadConfig } from "@fatcat/runtime/config";
import { documentParserVersion } from "@fatcat/runtime/documents/types";
import { SessionManager } from "@fatcat/runtime/session/manager";
import { SessionStore } from "@fatcat/runtime/session/store";
import { createTools } from "@fatcat/runtime/tools";
import { officeFixture, imageFixture } from "../fixtures/document-fixtures.js";
import { temporaryWorkspace } from "../support/workspace.js";

const agent = { model: async () => ({ message: { role: "assistant" as const, content: "Done" } }), maxIterations: 4 };

for (const cached of [false, true]) {
	test(`revoking an attachment during a ${cached ? "cached" : "new"} document read rejects subsequent cache access`, async (t) => {
		const { base, workspace } = await temporaryWorkspace(t);
		const store = new SessionStore({ root: join(base, "sessions") });
		const session = await SessionManager.open(agent, { workspace, store });
		const original = await upload(session, "revoked.docx", officeFixture("docx"));
		const reference = attachmentReference(original);
		if (cached) await session.readAttachment(reference);
		const accessCache = store.attachments.withDocumentCache.bind(store.attachments);
		let accesses = 0;
		t.mock.method(store.attachments, "withDocumentCache", async (...args: Parameters<typeof accessCache>) => {
			const result = await accessCache(...args);
			if (++accesses === 1) await session.removeAttachment(session.current.id, reference);
			return result;
		});
		await assert.rejects(session.readAttachment(reference), { code: "ATTACHMENT_ACCESS" });
		assert.equal(accesses, 1, "Only the first cache operation was authorized");
		assert.deepEqual(await session.listAttachments(), []);
		await assert.rejects(session.downloadAttachment(session.current.id, reference), { code: "ATTACHMENT_ACCESS" });
		if (!cached) {
			const directory = join(store.root, "attachments", "derived", original.id, original.contentVersion);
			await assert.rejects(access(directory), { code: "ENOENT" });
		}
	});
}

async function upload(session: SessionManager, name: string, bytes: Buffer) {
	const target = await session.beginAttachmentUpload(session.current.id, name, bytes.length);
	return session.uploadAttachment(target, (async function* () { yield bytes; })());
}

test("parsed originals retain project ownership, restart/fork access, independent isolation, and deletion boundaries", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const session = await SessionManager.open(agent, { workspace, store, deferEmptySessions: true });
	const project = await session.createProject("Documents", workspace);
	await session.newSession("Uploader", project.id);
	const uploader = session.current.id;
	const original = await upload(session, "agreement.docx", officeFixture("docx"));
	const reference = attachmentReference(original);
	const parsed = await session.readAttachment(reference);
	if (parsed.kind !== "document") throw new Error("Expected a document");
	const unit = parsed.units[1]!;
	await session.newSession();
	const reader = session.current.id;
	assert.equal(session.current.revision, 0);
	const source = await session.readAttachment(reference, { parserVersion: parsed.parserVersion, unit: unit.id });
	if (source.kind !== "document") throw new Error("Expected a document");
	assert.equal(source.units[0]!.text, unit.text);
	assert.equal(session.current.revision, 0, "Previewing cached project content does not save an empty draft");
	await session.run("Save this reader");
	await session.delete(uploader);
	const restored = await SessionManager.open(agent, { workspace, store: new SessionStore({ root: store.root }), selection: { resume: reader } });
	assert.deepEqual((await restored.readAttachment(reference)), parsed);
	await restored.fork("Another reader");
	assert.equal((await restored.readAttachment(reference)).kind, "document");
	await restored.newSession("Private", null);
	await assert.rejects(restored.readAttachment(reference, { parserVersion: parsed.parserVersion, unit: unit.id }));
	const otherProject = await restored.createProject("Other", workspace);
	await restored.newSession("Other project", otherProject.id);
	await assert.rejects(restored.readAttachment(reference));
	await restored.resume(reader);
	const directory = join(store.root, "attachments", "derived", original.id, original.contentVersion);
	assert.ok((await readdir(directory)).includes(`${documentParserVersion}.json`));
	const target = { sessionId: reader, projectId: project.id, locationRevision: restored.current.locationRevision ?? 0 };
	const parsedRef = parseAttachmentReference(reference);
	const snapshot = await store.attachments.withDocumentCache(target, parsedRef, (cache) => cache.load(documentParserVersion));
	assert.ok(snapshot);
	await restored.removeAttachment(reader, reference);
	await assert.rejects(restored.readAttachment(reference, { parserVersion: parsed.parserVersion }));
	await restored.deleteAttachment(reader, reference);
	await assert.rejects(access(directory));
	await assert.rejects(store.attachments.withDocumentCache(target, parsedRef, (cache) => cache.save(snapshot)));
	await assert.rejects(access(directory), "A stale completion must not recreate deleted derived files");
});

test("an executing agent analyzes authorized images with its current model and another session reuses the transcription", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const config = loadConfig({ HARNESS_PROVIDER: "kimi", MOONSHOT_API_KEY: "offline-document-session", HARNESS_MAX_ITERATIONS: "3" });
	let reference = "";
	let imageRequests = 0;
	let parentRequests = 0;
	const transport: typeof fetch = async (_input, init) => {
		const body = JSON.parse(String(init?.body)) as { messages: ChatMessage[]; tools?: unknown; tool_choice?: string };
		if (body.messages.some((message) => Array.isArray(message.content))) {
			imageRequests++;
			assert.equal(body.tools, undefined);
			assert.match(JSON.stringify(body), /data:image\/png;base64,/);
			return Response.json({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
				choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Project Atlas" } }] });
		}
		parentRequests++;
		if (parentRequests === 1) return Response.json({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null,
			tool_calls: [{ id: "transcribe-image", type: "function", function: { name: "read", arguments: JSON.stringify({ path: reference, mode: "transcribe" }) } }] } }] });
		assert.equal(body.tool_choice, "none");
		const tool = body.messages.find((message) => message.role === "tool");
		assert.ok(tool);
		const result = JSON.parse(String(tool.content));
		assert.equal(result.ok, true);
		assert.equal(result.result.units[0].provenance, "model-transcription");
		assert.equal(result.result.coverage.complete, false);
		return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: `[Recognized text](${result.result.units[0].citation})` } }] });
	};
	const bound = createAgent(config, await createTools(workspace), transport);
	const session = await SessionManager.open(bound, { workspace, store });
	const project = await session.createProject("Vision", workspace);
	await session.newSession("Transcriber", project.id);
	const original = await upload(session, "diagram.png", imageFixture());
	reference = attachmentReference(original);
	assert.match(await session.run("Transcribe this diagram for later readers"), /Recognized text/);
	assert.equal(imageRequests, 1);
	assert.equal(parentRequests, 2);
	assert.doesNotMatch(JSON.stringify(session.history), /base64|offline-document-session/);
	const source = await session.readAttachment(reference, { query: "Atlas" });
	if (source.kind !== "document") throw new Error("Expected a document");
	assert.equal(source.units[0]!.model, "kimi-k2.6");
	const originalVersion = source.parserVersion;
	await session.newSession("Consumer");
	const result = await session.readAttachment(reference);
	if (result.kind !== "document") throw new Error("Expected a document");
	assert.equal(result.units[0]!.text, "Project Atlas");
	assert.equal(result.parserVersion, originalVersion);
	assert.equal(imageRequests, 1, "Reusing transcription does not make an API call");
	const derived = join(store.root, "attachments", "derived", original.id, original.contentVersion);
	for (const file of await readdir(derived)) assert.doesNotMatch(await readFile(join(derived, file), "utf8"), /base64|offline-document-session/);
});

test("private in-memory parsing stays off disk and retains private fork isolation", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const root = join(base, "never-created");
	const session = await SessionManager.open(agent, { workspace, store: new SessionStore({ root }), persistence: false });
	const original = await upload(session, "notes.pptx", officeFixture("pptx"));
	const reference = attachmentReference(original);
	assert.equal((await session.readAttachment(reference)).kind, "document");
	await assert.rejects(access(root));
	await session.fork("Private fork");
	assert.equal((await session.readAttachment(reference)).kind, "document");
	await session.newSession("Isolated");
	await assert.rejects(session.readAttachment(reference));
});
