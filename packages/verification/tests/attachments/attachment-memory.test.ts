import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promisify } from "node:util";
import test from "node:test";
import { MemoryAttachments } from "@fatcat/runtime/internal/attachments/memory";
import { attachmentReference, maxAttachmentBytes, parseAttachmentReference } from "@fatcat/runtime/attachments/record";
import type { AttachmentTarget, StagedAttachment } from "@fatcat/runtime/attachments/record";
import type { SessionRecord } from "@fatcat/runtime/session/record";

function fixture() {
	const session: SessionRecord = { version: 4, id: randomUUID(), workspace: process.cwd(),
		location: { kind: "standalone", workspace: process.cwd() }, locationRevision: 0,
		name: null, title: "Temporary attachments", createdAt: "2026-10-13T00:00:00.000Z",
		updatedAt: "2026-10-13T00:00:00.000Z", revision: 1, forkedFrom: null, history: [], attempt: null };
	const store = new MemoryAttachments({ getSession: async (id) => id === session.id ? structuredClone(session) : undefined,
		saveDraft: async () => { throw new Error("The fixture session already exists"); } });
	const target: AttachmentTarget = { sessionId: session.id, locationRevision: 0 };
	async function stage(bytes: Uint8Array, uploadId = randomUUID()): Promise<StagedAttachment> {
		return store.stageUpload(target, { uploadId, name: "evidence.txt" }, (async function* () { yield bytes; })());
	}
	async function save(bytes: Uint8Array) {
		const pending = await stage(bytes);
		try { return await store.completeUpload(pending.uploadId, undefined, pending.stageToken); }
		finally { await store.discardUpload(pending.uploadId, pending.stageToken); }
	}
	return { store, target, stage, save };
}

function pausedBody(first: Uint8Array) {
	let markReceived!: () => void;
	let release!: () => void;
	const received = new Promise<void>((resolve) => { markReceived = resolve; });
	const pending = new Promise<void>((resolve) => { release = resolve; });
	return { received, release, body: (async function* () { yield first; markReceived(); await pending; })() };
}

test("fragmented and empty chunks preserve bytes under a bounded real Node heap", async () => {
	const moduleUrl = import.meta.resolve("@fatcat/runtime/internal/attachments/memory");
	const script = `
		import { randomUUID } from "node:crypto";
		import { MemoryAttachments } from ${JSON.stringify(moduleUrl)};
		const id = randomUUID();
		const record = { version: 4, id, workspace: process.cwd(), location: { kind: "standalone", workspace: process.cwd() },
			locationRevision: 0, revision: 1, history: [], attempt: null };
		const store = new MemoryAttachments({ getSession: async () => record, saveDraft: async () => record });
		const target = { sessionId: id, locationRevision: 0 };
		const fragment = new Uint8Array(1);
		const empty = new Uint8Array(0);
		const staged = await store.stageUpload(target, { uploadId: randomUUID(), name: "fragments.txt" }, (async function* () {
			for (let index = 0; index < 1024 * 1024; index++) {
				yield empty;
				fragment[0] = index % 256;
				yield fragment;
			}
		})());
		const saved = await store.completeUpload(staged.uploadId, undefined, staged.stageToken);
		await store.discardUpload(staged.uploadId, staged.stageToken);
		process.stdout.write(JSON.stringify({ size: saved.attachment.size, sha256: saved.attachment.sha256 }));
	`;
	const result = await promisify(execFile)(process.execPath,
		["--max-old-space-size=48", "--max-semi-space-size=1", "--input-type=module", "--eval", script],
		{ timeout: 30_000, maxBuffer: 64 * 1024, windowsHide: true });
	const expected = Buffer.alloc(1024 * 1024);
	for (let index = 0; index < expected.length; index++) expected[index] = index % 256;
	assert.deepEqual(JSON.parse(result.stdout), { size: expected.length, sha256: createHash("sha256").update(expected).digest("hex") });
});

test("four receiving or pending uploads reserve slots before publication and reject a fifth", async () => {
	const { store, target, stage } = fixture();
	const pending = await stage(Buffer.from("Already staged"));
	const streams = Array.from({ length: 3 }, () => pausedBody(Buffer.from("Receiving")));
	const transfers = streams.map((stream) => store.stageUpload(target, { uploadId: randomUUID(), name: "stream.txt" }, stream.body));
	try {
		await Promise.all(streams.map((stream) => stream.received));
		assert.deepEqual(await store.list(target), []);
		await assert.rejects(stage(Buffer.from("Fifth")), { code: "ATTACHMENT_LIMIT" });
		await store.discardUpload(pending.uploadId, pending.stageToken);
		const replacement = await stage(Buffer.from("Reused available slot"));
		await store.discardUpload(replacement.uploadId, replacement.stageToken);
	} finally {
		streams.forEach((stream) => stream.release());
		for (const result of await Promise.allSettled(transfers)) {
			if (result.status === "fulfilled") await store.discardUpload(result.value.uploadId, result.value.stageToken);
			else throw result.reason;
		}
	}
	const final = await stage(Buffer.from("Slots released"));
	await store.completeUpload(final.uploadId, undefined, final.stageToken);
	assert.equal((await store.list(target)).length, 1);
});

test("the 64 MiB budget includes stored originals, receiving bytes and pending stages", async () => {
	const { store, target, stage, save } = fixture();
	const block = new Uint8Array(maxAttachmentBytes);
	for (let index = 0; index < 3; index++) await save(block);
	assert.equal((await store.list(target)).reduce((total, item) => total + item.size, 0), 48 * 1024 * 1024);
	const stream = pausedBody(block);
	const receiving = store.stageUpload(target, { uploadId: randomUUID(), name: "pending.txt" }, stream.body);
	let pending: StagedAttachment;
	try {
		await stream.received;
		await assert.rejects(stage(new Uint8Array([1])), { code: "ATTACHMENT_LIMIT" });
	} finally {
		stream.release();
		pending = await receiving;
	}
	await assert.rejects(stage(new Uint8Array([1])), { code: "ATTACHMENT_LIMIT" });
	assert.equal((await store.list(target)).length, 3, "Pending bytes are budgeted but not discoverable originals");
	await store.discardUpload(pending.uploadId, pending.stageToken);
	const next = await save(new Uint8Array([7]));
	assert.equal(next.attachment.size, 1);
	assert.equal((await store.list(target)).length, 4);
});

test("cancellation releases the receiving reservation and permits retrying the same upload ID", async () => {
	const { store, target, stage } = fixture();
	const uploadId = randomUUID();
	const controller = new AbortController();
	const stream = pausedBody(new Uint8Array(maxAttachmentBytes));
	const receiving = store.stageUpload(target, { uploadId, name: "cancelled.txt" }, stream.body, controller.signal);
	await stream.received;
	const cancelled = assert.rejects(receiving, { code: "CANCELLED" });
	controller.abort();
	stream.release();
	await cancelled;
	assert.deepEqual(await store.list(target), []);
	const retried = await stage(Buffer.from("Retry bytes"), uploadId);
	const saved = await store.completeUpload(uploadId, undefined, retried.stageToken);
	const read = await store.read(target, parseAttachmentReference(attachmentReference(saved.attachment)));
	assert.equal(Buffer.from(read.bytes).toString("utf8"), "Retry bytes");
	await store.discardUpload(uploadId, retried.stageToken);
	for (let index = 0; index < 4; index++) await stage(new Uint8Array(0));
	await assert.rejects(stage(new Uint8Array(0)), { code: "ATTACHMENT_LIMIT" });
});

test("late discard and completion from an old stage cannot remove or publish its replacement", async () => {
	const { store, target, stage } = fixture();
	const uploadId = randomUUID();
	const old = await stage(Buffer.from("Old transfer"), uploadId);
	await store.discardUpload(uploadId, old.stageToken);
	const replacement = await stage(Buffer.from("Replacement transfer"), uploadId);
	assert.notEqual(replacement.stageToken, old.stageToken);
	await store.discardUpload(uploadId, old.stageToken);
	await store.discardUpload(uploadId);
	await assert.rejects(store.completeUpload(uploadId, undefined, old.stageToken), { code: "ATTACHMENT_CONFLICT" });
	const saved = await store.completeUpload(uploadId, undefined, replacement.stageToken);
	const read = await store.read(target, parseAttachmentReference(attachmentReference(saved.attachment)));
	assert.equal(Buffer.from(read.bytes).toString("utf8"), "Replacement transfer");
	assert.equal(saved.attachment.contentVersion, replacement.contentVersion);
	assert.equal((await store.list(target)).length, 1);
});
