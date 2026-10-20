import type { ChatMessage } from "../support/chat-protocol.js";
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createAgent } from "@fatcat/runtime/agent";
import { attachmentReference } from "@fatcat/runtime/attachments/record";
import { loadConfig } from "@fatcat/runtime/config";
import { PermissionPolicy } from "@fatcat/runtime/permissions/policy";
import { SessionManager } from "@fatcat/runtime/session/manager";
import { SessionStore } from "@fatcat/runtime/session/store";
import { createTools } from "@fatcat/runtime/tools";
import { temporaryWorkspace } from "../support/workspace.js";

const agent = { model: async () => ({ message: { role: "assistant" as const, content: "Done" }, toolCalls: [] }), maxIterations: 4 };
async function upload(session: SessionManager, name: string, content: string) {
	const bytes = Buffer.from(content);
	const target = await session.beginAttachmentUpload(session.current.id, name, bytes.length);
	return session.uploadAttachment(target, (async function* () { yield bytes; })());
}

test("project originals survive their uploader while independent and other-project sessions cannot read them", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const session = await SessionManager.open(agent, { workspace, store });
	const standalone = session.current.id;
	const p = await session.createProject("P", workspace);
	const q = await session.createProject("Q", workspace);
	await session.newSession("Uploader", p.id);
	const uploader = session.current.id;
	const original = await upload(session, "decision.md", "# Decision\nShared evidence\n");
	const ref = attachmentReference(original);
	await session.newSession("Reader");
	const reader = session.current.id;
	assert.equal((await session.listAttachments())[0]?.id, original.id);
	assert.match(JSON.stringify(await session.readAttachment(ref)), /Shared evidence/);
	await session.delete(uploader);
	assert.equal((await session.downloadAttachment(reader, ref)).bytes.length, original.size);
	await session.resume(standalone);
	await assert.rejects(session.readAttachment(ref));
	assert.deepEqual(await session.listAttachments(), []);
	await session.newSession(undefined, q.id);
	await assert.rejects(session.downloadAttachment(session.current.id, ref));
	const restored = await SessionManager.open(agent, { workspace, store: new SessionStore({ root: store.root }), selection: { resume: reader } });
	assert.match(JSON.stringify(await restored.readAttachment(ref)), /Shared evidence/);
});

test("private files migrate with their session and a changed attachment set invalidates the old move preview", async (t) => {
	const { base, workspace, outside } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const session = await SessionManager.open(agent, { workspace, store });
	await session.run("Preserve this private history");
	const source = session.current.id;
	const history = session.history;
	const original = await upload(session, "private.md", "Private until confirmed\n");
	const ref = attachmentReference(original);
	const project = await session.createProject("Shared", outside);
	const oldPreview = await session.previewProjectJoin(project.id);
	assert.equal(oldPreview.attachmentCount, 1);
	await upload(session, "second.md", "A second original");
	await assert.rejects(session.joinProject(oldPreview), /changed|conflict|preview/i);
	const preview = await session.previewProjectJoin(project.id);
	assert.equal(preview.attachmentCount, 2);
	await session.joinProject(preview);
	await session.joinProject(preview);
	assert.deepEqual(session.history, history);
	await session.newSession("Member");
	assert.equal((await session.listAttachments()).length, 2);
	assert.match(JSON.stringify(await session.readAttachment(ref)), /Private until confirmed/);
	await session.delete(source);
	assert.equal((await session.listAttachments()).length, 2);
});

test("a fresh project draft can browse shared originals without saving an empty session", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const session = await SessionManager.open(agent, { workspace, store: new SessionStore({ root: join(base, "sessions") }), deferEmptySessions: true });
	const project = await session.createProject("Shared", workspace);
	await session.newSession("Uploader", project.id);
	const original = await upload(session, "shared.md", "Shared before the first prompt");
	const ref = attachmentReference(original);
	await session.newSession();
	const draftId = session.current.id;
	assert.equal(session.current.revision, 0);
	assert.equal((await session.listAttachments())[0]?.id, original.id);
	assert.match(JSON.stringify(await session.readAttachment(ref)), /Shared before the first prompt/);
	assert.equal((await session.downloadAttachment(draftId, ref)).bytes.length, original.size);
	assert.equal(session.current.revision, 0);
	assert.equal((await session.list()).some((item) => item.id === draftId), false);
});

test("completed bytes wait for the active turn before publishing without replacing its history", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	let release!: () => void;
	let entered!: () => void;
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const started = new Promise<void>((resolve) => { entered = resolve; });
	const session = await SessionManager.open({ ...agent, model: async () => {
		entered();
		await gate;
		return { message: { role: "assistant" as const, content: "Preserved answer" }, toolCalls: [] };
	} }, { workspace, store: new SessionStore({ root: join(base, "sessions") }), deferEmptySessions: true });
	const target = await session.beginAttachmentUpload(session.current.id, "late.txt", 4);
	const turn = session.run("Preserve my turn");
	await started;
	let completed = false;
	const pending = session.uploadAttachment(target, (async function* () { yield Buffer.from("data"); })())
		.then((file) => { completed = true; return file; });
	try {
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(completed, false);
	} finally { release(); }
	assert.equal(await turn, "Preserved answer");
	const file = await pending;
	assert.match(JSON.stringify(session.history), /Preserved answer/);
	assert.match(JSON.stringify(await session.readAttachment(attachmentReference(file))), /data/);
});

test("an upload completes in its initiating draft after switching, while cancellation never saves a draft", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const session = await SessionManager.open(agent, { workspace, store, deferEmptySessions: true });
	const originalId = session.current.id;
	const target = await session.beginAttachmentUpload(originalId, "draft.txt", 4);
	let started!: () => void;
	let finish!: () => void;
	const entered = new Promise<void>((resolve) => { started = resolve; });
	const gate = new Promise<void>((resolve) => { finish = resolve; });
	const pending = session.uploadAttachment(target, (async function* () { started(); await gate; yield Buffer.from("data"); })());
	await entered;
	await session.newSession(undefined, null);
	const selected = session.current.id;
	finish();
	const file = await pending;
	assert.equal(session.current.id, selected);
	assert.equal((await session.list())[0]?.id, originalId);
	assert.equal((await session.listAttachments(originalId))[0]?.id, file.id);
	assert.deepEqual(await session.listAttachments(), []);
	const cancelled = await session.beginAttachmentUpload(selected, "cancel.txt", 1);
	const abort = new AbortController();
	abort.abort();
	await assert.rejects(session.uploadAttachment(cancelled, (async function* () { yield Buffer.from("x"); })(), abort.signal));
	assert.equal((await session.list()).length, 1);
});

test("an in-flight upload cannot follow migration or resurrect a deleted session", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const session = await SessionManager.open(agent, { workspace, store, deferEmptySessions: true });
	const target = await session.beginAttachmentUpload(session.current.id, "late.md", 1);
	await session.rename("Saved draft");
	await session.delete(session.current.id);
	await assert.rejects(session.uploadAttachment(target, (async function* () { yield Buffer.from("x"); })()));
	assert.equal((await session.list()).length, 0);
	await session.rename("Moving");
	const moving = await session.beginAttachmentUpload(session.current.id, "moving.md", 1);
	const project = await session.createProject("Project", workspace);
	await session.joinProject(await session.previewProjectJoin(project.id));
	await assert.rejects(session.uploadAttachment(moving, (async function* () { yield Buffer.from("x"); })()));
	assert.deepEqual(await session.listAttachments(), []);
});

test("fork associations and retained model reads prevent permanent deletion, while removal revokes access", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const tools = await createTools(workspace);
	let ref = "";
	const runtime = createAgent(loadConfig({ DEEPSEEK_API_KEY: "offline-attachments" }), tools, async (input, init) => {
		const body = await new Request(input, init).json() as { messages: ChatMessage[] };
		const message = body.messages.at(-1)?.role === "user"
			? { role: "assistant", content: null, tool_calls: [{ id: "read-original", type: "function", function: { name: "read", arguments: JSON.stringify({ path: ref }) } }] }
			: { role: "assistant", content: `Evidence [source](${ref}#L1-L1)` };
		return Response.json({ choices: [{ finish_reason: "tool_calls" in message ? "tool_calls" : "stop", message }] });
	});
	const session = await SessionManager.open(runtime, { workspace, store });
	ref = attachmentReference(await upload(session, "retained.txt", "Retained original"));
	await session.run("Read the original");
	const source = session.current.id;
	await session.fork("Fork");
	const fork = session.current.id;
	await session.delete(source);
	assert.match(JSON.stringify(await session.readAttachment(ref)), /Retained original/);
	await assert.rejects(session.deleteAttachment(fork, ref), /referenc|history/i);
	await session.removeAttachment(fork, ref);
	assert.deepEqual(await session.listAttachments(), []);
	await assert.rejects(session.readAttachment(ref));
	assert.equal((await session.listAttachments(undefined, true))[0]?.removed, true);
	await assert.rejects(session.deleteAttachment(fork, ref), /referenc|history/i);
});

test("explicit import honors live path policy and non-persistent attachments never create a store", async (t) => {
	const { base, workspace, outside } = await temporaryWorkspace(t);
	await writeFile(join(outside, "outside.txt"), "Outside original");
	await writeFile(join(workspace, "inside.txt"), "Inside original");
	const policy = new PermissionPolicy("plan");
	const tools = await createTools(workspace, "read-only", undefined, { permission: "deny" }, undefined, policy);
	const store = new SessionStore({ root: join(base, "must-not-exist") });
	const session = await SessionManager.open({ ...agent, tools }, { workspace, store, persistence: false });
	await assert.rejects(session.importAttachment(join(outside, "outside.txt")), /allowed|path/i);
	const original = await session.importAttachment("inside.txt");
	const ref = attachmentReference(original);
	await session.newSession();
	assert.deepEqual(await session.listAttachments(), []);
	await assert.rejects(session.readAttachment(ref));
	await assert.rejects(readdir(store.root), { code: "ENOENT" });
	policy.select("freeToGo");
	const imported = await session.importAttachment(join(outside, "outside.txt"));
	assert.match(JSON.stringify(await session.readAttachment(attachmentReference(imported))), /Outside original/);
	assert.equal(await readFile(join(outside, "outside.txt"), "utf8"), "Outside original");
});

test("background parent and child read their actual project originals while another project is selected", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	let ref = "";
	let foreignRef = "";
	let childRead = false;
	const tools = await createTools(workspace);
	const runtime = createAgent(loadConfig({ DEEPSEEK_API_KEY: "offline-attachment-delegation", HARNESS_MAX_ITERATIONS: "4" }), tools, async (input, init) => {
		const body = await new Request(input, init).json() as { messages: ChatMessage[]; tools: { function: { name: string } }[] };
		const child = !body.tools.some((tool) => tool.function.name === "delegate_task");
		let message: unknown;
		if (body.messages.at(-1)?.role === "user") {
			const calls = child ? [
				{ id: "own", type: "function", function: { name: "read", arguments: JSON.stringify({ path: ref }) } },
				{ id: "foreign", type: "function", function: { name: "read", arguments: JSON.stringify({ path: foreignRef }) } },
			] : [{ id: "delegate", type: "function", function: { name: "delegate_task", arguments: JSON.stringify({ task: "Read the project evidence" }) } }];
			message = { role: "assistant", content: null, tool_calls: calls };
		} else {
			if (child) {
				childRead = true;
				const results = body.messages.filter((item) => item.role === "tool");
				assert.match(String(results[0]?.content), /Project P evidence/);
				assert.equal(JSON.parse(String(results[1]?.content)).ok, false);
				assert.ok(!JSON.stringify(results).includes("Project Q private"));
			}
			message = { role: "assistant", content: "Used authorized evidence" };
		}
		return Response.json({ choices: [{ finish_reason: "tool_calls" in (message as object) ? "tool_calls" : "stop", message }] });
	});
	const session = await SessionManager.open(runtime, { workspace, store });
	const p = await session.createProject("P", workspace);
	const q = await session.createProject("Q", workspace);
	await session.newSession("Target", p.id);
	ref = attachmentReference(await upload(session, "evidence.md", "Project P evidence"));
	await session.manageAutomation({ action: "create", prompt: "Delegate the evidence review", trigger: { type: "interval", seconds: 60 }, maxRuns: 1 });
	const task = (await session.listAutomations())[0]!;
	await session.newSession("Selected", q.id);
	foreignRef = attachmentReference(await upload(session, "private.md", "Project Q private"));
	const selected = session.current.id;
	await session.runAutomation(task.sessionId, task.id, Date.now(), [], { locationRevision: task.locationRevision ?? 0 });
	assert.equal(session.current.id, selected);
	assert.equal(session.history.length, 0);
	assert.ok(childRead);
});
