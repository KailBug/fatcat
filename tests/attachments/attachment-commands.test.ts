import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { attachmentReference } from "../../src/attachments/record.js";
import { runInteractiveCommand } from "../../src/commands.js";
import { SessionManager } from "../../src/session/manager.js";
import { Session } from "../../src/session/session.js";
import { SessionStore } from "../../src/session/store.js";
import { createTools } from "../../src/tools.js";
import { temporaryWorkspace } from "../support/workspace.js";

async function fixture(t: TestContext) {
	const { base, workspace, outside } = await temporaryWorkspace(t);
	let requests = 0;
	const agent = { maxIterations: 1, tools: await createTools(workspace),
		model: async () => { requests++; return { message: { role: "assistant" as const, content: "Answer" }, toolCalls: [] }; } };
	const store = new SessionStore({ root: join(base, "sessions") });
	const session = await SessionManager.open(agent, { workspace, store });
	return { workspace, outside, session, store, agent, requests: () => requests };
}

test("attachment commands import quoted paths and persist originals without model or history changes", async (t) => {
	const { workspace, session, store, agent, requests } = await fixture(t);
	await writeFile(join(workspace, "project notes.md"), "# Original\nEvidence\n");
	const initialId = session.current.id;
	assert.match((await runInteractiveCommand(session, "/attachments"))!.text, /No attachments/);
	const imported = await runInteractiveCommand(session, '/attach "project notes.md"');
	assert.equal(imported!.switched, false);
	assert.match(imported!.text, /Attachment saved:/);
	assert.match(imported!.text, /Standalone session/);
	const records = await session.listAttachments();
	assert.equal(records.length, 1);
	const record = records[0]!;
	const reference = attachmentReference(record);
	assert.ok(imported!.text.includes(reference));
	assert.ok((await runInteractiveCommand(session, "/attachments"))!.text.includes(reference));
	assert.equal(session.current.id, initialId);
	assert.deepEqual(session.history, []);
	assert.equal(requests(), 0);
	await writeFile(join(workspace, "project notes.md"), "Changed local source");
	const restored = await SessionManager.open(agent, { workspace, store, selection: { resume: initialId } });
	const result = await restored.readAttachment(reference);
	assert.equal(result.kind, "file");
	if (result.kind === "file") assert.equal(result.content, "# Original\nEvidence\n");
	assert.equal(attachmentReference((await restored.listAttachments())[0]!), reference);
});

test("attachment commands share project originals while keeping same-directory standalone sessions private", async (t) => {
	const { workspace, session, requests } = await fixture(t);
	await writeFile(join(workspace, "shared.md"), "Project evidence");
	const project = await session.createProject("Research", workspace);
	await runInteractiveCommand(session, `/project use ${project.id}`);
	const uploader = session.current.id;
	await runInteractiveCommand(session, "/attach shared.md");
	const reference = attachmentReference((await session.listAttachments())[0]!);
	await runInteractiveCommand(session, "/new Reader");
	assert.ok((await runInteractiveCommand(session, "/attachments"))!.text.includes(reference));
	assert.match((await runInteractiveCommand(session, "/attachments"))!.text, /Research/);
	await session.delete(uploader);
	assert.equal((await session.readAttachment(reference)).kind, "file");
	await runInteractiveCommand(session, "/new --standalone Private");
	assert.match((await runInteractiveCommand(session, "/attachments"))!.text, /No attachments/);
	await assert.rejects(session.readAttachment(reference));
	await assert.rejects(runInteractiveCommand(session, `/attachment delete ${reference}`), { code: "ATTACHMENT_NOT_FOUND" });
	assert.equal(requests(), 0);
});

test("attachment commands distinguish removing an association from confirmed permanent deletion", async (t) => {
	const { workspace, session, requests } = await fixture(t);
	await writeFile(join(workspace, "unread.txt"), "Unreferenced text");
	await runInteractiveCommand(session, "/attach unread.txt");
	const reference = attachmentReference((await session.listAttachments())[0]!);
	const preview = (await runInteractiveCommand(session, `/attachment delete ${reference}`))!;
	assert.match(preview.text, /Permanently delete/);
	assert.match(preview.text, /Other active scope associations/);
	assert.match(preview.text, /every session in this scope loses access/);
	assert.equal((await session.listAttachments()).length, 1);
	const removed = await runInteractiveCommand(session, `/attachment remove ${reference}`);
	assert.match(removed!.text, /association removed/);
	assert.deepEqual(await session.listAttachments(), []);
	assert.equal((await session.listAttachments(undefined, true))[0]!.deleted, false);
	await runInteractiveCommand(session, `/attachment delete ${reference} --confirm`);
	assert.equal((await session.listAttachments(undefined, true))[0]!.deleted, true);
	await assert.rejects(session.readAttachment(reference));
	await runInteractiveCommand(session, "/attach unread.txt");
	const activeReference = attachmentReference((await session.listAttachments())[0]!);
	await runInteractiveCommand(session, `/attachment delete ${activeReference} --confirm`);
	assert.deepEqual(await session.listAttachments(), []);
	assert.equal(requests(), 0);
});

test("attachment commands preserve import permissions and forward cancellation before publication", async (t) => {
	const { workspace, outside, session, requests } = await fixture(t);
	await writeFile(join(workspace, "allowed.md"), "Allowed");
	await writeFile(join(outside, "private.md"), "Outside");
	await assert.rejects(runInteractiveCommand(session, `/attach "${join(outside, "private.md")}"`), { code: "PATH_NOT_ALLOWED" });
	await assert.rejects(runInteractiveCommand(session, "/attach ../outside/private.md"), { code: "PATH_NOT_ALLOWED" });
	await assert.rejects(runInteractiveCommand(session, "/attach allowed.md", [], { signal: AbortSignal.abort() }), { code: "CANCELLED" });
	assert.deepEqual(await session.listAttachments(), []);
	assert.equal(requests(), 0);
});

test("malformed attachment commands do not alter saved files or become model prompts", async (t) => {
	const { session, requests } = await fixture(t);
	for (const command of ["/attachments extra", "/attach", '/attach "unterminated', "/attach one.md two.md", "/attachment",
		"/attachment remove", "/attachment destroy value", "/attachment delete value --yes"]) {
		await assert.rejects(runInteractiveCommand(session, command), { code: "USAGE" });
	}
	await assert.rejects(runInteractiveCommand(session, "/attachment remove attachment:unversioned"), { code: "ATTACHMENT_REFERENCE" });
	assert.deepEqual(await session.listAttachments(), []);
	assert.deepEqual(session.history, []);
	assert.equal(requests(), 0);
	const plain = new Session({ maxIterations: 1, model: async () => ({ message: { role: "assistant", content: "unused" }, toolCalls: [] }) });
	await assert.rejects(runInteractiveCommand(plain, "/attachments"), { code: "USAGE" });
});
