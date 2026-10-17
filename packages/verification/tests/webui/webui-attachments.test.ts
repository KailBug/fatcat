import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { TestContext } from "node:test";
import { attachmentReference } from "@fatcat/runtime/attachments/record";
import type { AttachmentInfo } from "@fatcat/runtime/attachments/record";
import { SessionManager } from "@fatcat/runtime/session/manager";
import { SessionStore } from "@fatcat/runtime/session/store";
import { projectIdOf } from "@fatcat/runtime/session/record";
import { createTools } from "@fatcat/runtime/tools";
import { WebUiController } from "@fatcat/webui/internal/controller";
import { startWebUiServer } from "@fatcat/webui/internal/server";
import type { UploadTicket } from "@fatcat/webui/internal/attachments";
import { parseSourceReference } from "@fatcat/webui/internal/client/attachments";
import { temporaryWorkspace } from "../support/workspace.js";

async function setup(t: TestContext) {
	const fixture = await temporaryWorkspace(t);
	const { base, workspace } = fixture;
	const factory = async (root: string) => ({ tools: await createTools(root), maxIterations: 1,
		model: async () => ({ toolCalls: [], message: { role: "assistant" as const, content: "Offline answer" } }) });
	const store = new SessionStore({ root: join(base, "sessions") });
	const manager = await SessionManager.open(await factory(workspace), { workspace, store,
		deferEmptySessions: true, agentForWorkspace: factory });
	const controller = await WebUiController.create({ workspace, provider: "deepseek", model: "offline",
		permission: "read-only", shellPermission: "deny", webPermission: "deny", maxIterations: 1,
		maxRequestBytes: 262144, skills: 0, warnings: [] }, manager);
	const server = await startWebUiServer(controller, 0, async () => fixture.outside);
	t.after(() => server.close());
	const token = new URL(server.url).hash.slice("#token=".length);
	const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
	const post = (path: string, body: unknown, custom = headers) => fetch(`${server.origin}/api/${path}`, {
		method: "POST", headers: custom, body: JSON.stringify(body),
	});
	const begin = async (sessionId: string, name: string, size: number, uploadId = randomUUID()) => {
		const identity = sessionId === manager.current.id ? manager.current : await store.loadAny(sessionId);
		const projectId = "location" in identity ? projectIdOf(identity) : "projectId" in identity ? identity.projectId : undefined;
		const response = await post("attachments/begin", { sessionId, name, size, uploadId,
			locationRevision: identity.locationRevision ?? 0, projectId: projectId ?? null });
		assert.equal(response.status, 201, await response.clone().text());
		return await response.json() as UploadTicket;
	};
	const bytes = (ticket: UploadTicket, content: Uint8Array | string) => fetch(`${server.origin}/api/attachments/upload/${ticket.token}`, {
		method: "POST", headers: { Authorization: headers.Authorization, "Content-Type": "application/octet-stream" },
		body: typeof content === "string" ? content : new Uint8Array(content),
	});
	const upload = async (sessionId: string, name: string, content: string) => {
		const ticket = await begin(sessionId, name, Buffer.byteLength(content));
		const response = await bytes(ticket, content);
		assert.equal(response.status, 201, await response.clone().text());
		return await response.json() as AttachmentInfo;
	};
	const list = async (sessionId: string, includeRemoved = false) => {
		const response = await post("attachments/list", { sessionId, includeRemoved });
		assert.equal(response.status, 200, await response.clone().text());
		return await response.json() as AttachmentInfo[];
	};
	return { ...fixture, manager, controller, store, server, headers, post, begin, bytes, upload, list };
}

function streaming(origin: string, token: string, authorization: string) {
	let send!: ReturnType<typeof request>;
	const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
		send = request(`${origin}/api/attachments/upload/${token}`, { method: "POST", headers: {
			Authorization: authorization, "Content-Type": "application/octet-stream",
		} }, (incoming) => {
			let body = "";
			incoming.setEncoding("utf8");
			incoming.on("data", (chunk: string) => { body += chunk; });
			incoming.on("end", () => resolve({ status: incoming.statusCode!, body }));
			incoming.on("error", reject);
		});
		send.on("error", reject);
		send.flushHeaders();
	});
	return { send, response };
}

async function until(predicate: () => Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!await predicate()) {
		assert.ok(Date.now() < deadline, "The asynchronous attachment operation should finish within ten seconds.");
		await delay(10);
	}
}

test("attachment routes require capability, bounded metadata and server-owned one-use upload tickets", async (t) => {
	const { manager, controller, post, begin, bytes, headers } = await setup(t);
	const sessionId = manager.current.id;
	const metadata = { sessionId, name: "notes.md", size: 4, locationRevision: 0, projectId: null };
	assert.equal((await post("attachments/begin", metadata, { ...headers, Authorization: "Bearer wrong" })).status, 401);
	assert.equal((await post("attachments/begin", { ...metadata, workspace: "D:\\elsewhere" })).status, 400);
	assert.equal((await post("attachments/begin", { ...metadata, size: 16 * 1024 * 1024 + 1 })).status, 413);
	assert.equal((await post("attachments/begin", { ...metadata, name: "../notes.md" })).status, 400);
	assert.equal((await post("attachments/begin", { ...metadata, name: "page.html" })).status, 400);
	assert.equal((await post("attachments/begin", { ...metadata, name: "a".repeat(65537) })).status, 413);
	const ticket = await begin(sessionId, "notes.md", 4);
	assert.equal(manager.current.revision, 0);
	assert.equal((await bytes(ticket, "text")).status, 201);
	assert.ok(controller.snapshot().attachmentRevision > 0);
	assert.ok(manager.current.revision > 0);
	assert.equal((await bytes(ticket, "text")).status, 400);
});

test("project files are shared, private scopes are isolated, originals and text versions remain exact", async (t) => {
	const { manager, post, upload, list } = await setup(t);
	const project = await manager.createProject("Sources", manager.current.workspace);
	await manager.newSession("Uploader", project.id);
	const uploader = manager.current.id;
	const first = await upload(uploader, "notes.md", "# Original\nLine two\n");
	const original = attachmentReference(first);
	await manager.newSession(undefined, project.id);
	const reader = manager.current.id;
	assert.deepEqual((await list(reader)).map((file) => file.id), [first.id]);
	const reading = await post("attachments/read", { sessionId: reader, reference: original, offset: 1, limit: 1 });
	assert.equal(reading.status, 200);
	assert.deepEqual((await reading.json() as { content: string }).content, "Line two\n");
	assert.equal(manager.current.revision, 0, "Discovering and reading shared files must not persist an empty project chat.");
	await manager.rename("Reader");
	const second = await upload(uploader, "notes.md", "New version\n");
	assert.notEqual(second.id, first.id);
	assert.notEqual(second.contentVersion, first.contentVersion);
	const download = await post("attachments/download", { sessionId: reader, reference: original });
	assert.equal(download.status, 200);
	assert.equal(download.headers.get("Content-Type"), "application/octet-stream");
	assert.match(download.headers.get("Content-Disposition")!, /^attachment;/);
	assert.equal(download.headers.get("X-Content-Version"), first.contentVersion);
	assert.equal(await download.text(), "# Original\nLine two\n");
	await manager.newSession("Private", null);
	await manager.rename("Private");
	const privateId = manager.current.id;
	assert.deepEqual(await list(privateId), []);
	assert.equal((await post("attachments/read", { sessionId: privateId, reference: original })).status, 400);
	assert.equal((await post("attachments/download", { sessionId: privateId, reference: original })).status, 400);
	await manager.delete(uploader);
	assert.equal((await list(reader)).length, 2);
});

test("binary originals remain downloadable and corrupt documents or invalid text are never presented as empty", async (t) => {
	const { manager, upload, post } = await setup(t);
	const sessionId = manager.current.id;
	const binary = await upload(sessionId, "scan.pdf", "%PDF-1.7\nnot parsed");
	const reference = attachmentReference(binary);
	const parsed = await post("attachments/read", { sessionId, reference });
	assert.equal(parsed.status, 400);
	assert.match(await parsed.text(), /corrupt|invalid|failed|PDF/i);
	assert.equal(await (await post("attachments/download", { sessionId, reference })).text(), "%PDF-1.7\nnot parsed");
	const invalid = await upload(sessionId, "invalid.md", "\u0000binary");
	const result = await post("attachments/read", { sessionId, reference: attachmentReference(invalid) });
	assert.equal(result.status, 400);
	assert.match(await result.text(), /not valid UTF-8/);
	const empty = await upload(sessionId, "empty.md", "");
	const content = await (await post("attachments/read", { sessionId, reference: attachmentReference(empty) })).json() as { totalLines: number; content: string };
	assert.equal(content.totalLines, 0);
	assert.equal(content.content, "");
});

test("four streams can complete together and an identical retry preserves the original identity", async (t) => {
	const { manager, post, begin, bytes, list } = await setup(t);
	const sessionId = manager.current.id;
	const uploadId = randomUUID();
	const tickets = await Promise.all(Array.from({ length: 4 }, (_, index) => begin(sessionId, `${index}.txt`, 4,
		index === 0 ? uploadId : randomUUID())));
	const responses = await Promise.all(tickets.map((ticket) => bytes(ticket, "same")));
	for (const response of responses) assert.equal(response.status, 201, await response.clone().text());
	const original = await responses[0]!.json() as AttachmentInfo;
	assert.equal((await list(sessionId)).length, 4);
	const retry = await begin(sessionId, "0.txt", 4, uploadId);
	const retried = await bytes(retry, "same");
	assert.equal(retried.status, 201, await retried.clone().text());
	assert.equal((await retried.json() as AttachmentInfo).id, original.id);
	assert.equal((await list(sessionId)).length, 4);
	const conflict = await begin(sessionId, "0.txt", 4, uploadId);
	assert.equal((await bytes(conflict, "else")).status, 400);
	const read = await post("attachments/read", { sessionId, reference: attachmentReference(original) });
	assert.equal((await read.json() as { content: string }).content, "same");
});

test("streaming to an original draft can finish after switching without changing the selected session", async (t) => {
	const { manager, store, post, begin, server, headers, list } = await setup(t);
	const original = manager.current.id;
	const ticket = await begin(original, "slow.txt", 11);
	const stream = streaming(server.origin, ticket.token, headers.Authorization);
	stream.send.write("first ");
	assert.equal((await post("session/new", { projectId: null })).status, 202);
	const selected = manager.current.id;
	stream.send.end("chunk");
	const result = await stream.response;
	assert.equal(result.status, 201, result.body);
	assert.equal(manager.current.id, selected);
	assert.equal(manager.current.revision, 0);
	assert.deepEqual(manager.history, []);
	assert.equal((await store.loadAny(original)).history.length, 0);
	assert.equal((await list(original)).length, 1);
	assert.deepEqual(await list(selected), []);
});

test("upload reservations bound concurrency and cancellation removes partial bytes without saving drafts", async (t) => {
	const { manager, store, begin, post, server, headers, list } = await setup(t);
	const sessionId = manager.current.id;
	const tickets = await Promise.all(Array.from({ length: 4 }, (_, index) => begin(sessionId, `${index}.txt`, 100)));
	assert.equal((await post("attachments/begin", { sessionId, name: "fifth.txt", size: 100, locationRevision: 0, projectId: null })).status, 409);
	const stream = streaming(server.origin, tickets[0]!.token, headers.Authorization);
	const disconnected = stream.response.catch(() => ({ status: 0, body: "cancelled" }));
	stream.send.write("partial");
	await delay(25);
	for (const ticket of tickets) assert.equal((await post("attachments/cancel", { token: ticket.token })).status, 202);
	await disconnected;
	assert.equal(manager.current.revision, 0);
	assert.deepEqual(await list(sessionId), []);
	assert.deepEqual(await store.listAll(), []);
	await until(async () => !(await readdir(store.root, { recursive: true })).some((path) => String(path).endsWith(".part")));
	const next = await begin(sessionId, "next.txt", 0);
	assert.equal((await post("attachments/cancel", { token: next.token })).status, 202);
});

test("stale removal cannot expand private consent to a project and permanent deletion is a separate confirmed operation", async (t) => {
	const { manager, upload, list, post, begin } = await setup(t);
	const sessionId = manager.current.id;
	const file = await upload(sessionId, "lifecycle.md", "Retained original");
	const reference = attachmentReference(file);
	const old = { sessionId, reference, confirmed: true, locationRevision: manager.current.locationRevision ?? 0, scopeRevision: file.scopeRevision };
	const uploadId = randomUUID();
	const cancelled = await begin(sessionId, "retry.md", 4, uploadId);
	assert.equal((await post("attachments/cancel", { token: cancelled.token })).status, 202);
	const project = await manager.createProject("Shared", manager.current.workspace);
	await manager.joinProject(await manager.previewProjectJoin(project.id));
	const retry = await post("attachments/begin", { sessionId, name: "retry.md", size: 4, uploadId,
		locationRevision: old.locationRevision, projectId: null });
	assert.equal(retry.status, 409);
	assert.match(await retry.text(), /destination changed/);
	assert.equal((await post("attachments/remove", old)).status, 409);
	assert.equal((await list(sessionId)).length, 1);
	const current = (await list(sessionId))[0]!;
	const body = { ...old, locationRevision: manager.current.locationRevision ?? 0, scopeRevision: current.scopeRevision };
	assert.equal((await post("attachments/remove", { sessionId, reference, confirmed: true })).status, 400);
	assert.equal((await post("attachments/remove", { ...body, confirmed: false })).status, 400);
	assert.equal((await post("attachments/remove", body)).status, 202);
	assert.deepEqual(await list(sessionId), []);
	const removed = (await list(sessionId, true))[0]!;
	assert.equal(removed.removed, true);
	assert.equal(removed.deleted, false);
	assert.equal((await post("attachments/read", { sessionId, reference })).status, 400);
	assert.equal((await post("attachments/delete", { ...body, scopeRevision: removed.scopeRevision })).status, 202);
	assert.equal((await list(sessionId, true))[0]!.deleted, true);
	assert.equal((await post("attachments/download", { sessionId, reference })).status, 400);
});

test("source reference parsing allows only immutable attachment IDs and bounded positive line ranges", () => {
	const reference = `attachment:${randomUUID()}@${"a".repeat(64)}`;
	assert.deepEqual(parseSourceReference(reference), { reference, offset: 0, limit: 100 });
	assert.deepEqual(parseSourceReference(`${reference}#L12-L500`), { reference, offset: 11, limit: 200 });
	for (const value of ["javascript:alert(1)", "file:///C:/private", `${reference}#L0-L1`, `${reference}#L8-L2`, `${reference}#L1-L9007199254740992`, `${reference}?path=../secret`]) {
		assert.equal(parseSourceReference(value), undefined);
	}
});
