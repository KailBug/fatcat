import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { open, readFile, readdir, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readMemoryLockOwner, readMemoryRecords } from "../../src/memory/files.js";
import { memoryScopeKey } from "../../src/memory/record.js";
import type { MemoryScope, MemorySource } from "../../src/memory/record.js";
import { MemoryStore } from "../../src/memory/store.js";
import { temporaryWorkspace } from "../support/workspace.js";

const source = (): MemorySource => ({ sessionId: randomUUID(), request: "Remember this decision", turn: 1 });

async function fileHandlePrototype(path: string): Promise<FileHandle> {
	const handle = await open(path, "r");
	try { return Object.getPrototypeOf(handle) as FileHandle; }
	finally { await handle.close(); }
}

describe("memory file and coordination boundaries", () => {
	it("closes cancelled reads without treating a scope or lock owner as absent", async (t) => {
		const { workspace } = await temporaryWorkspace(t);
		const path = join(workspace, "global.json");
		const bytes = JSON.stringify({ version: 1, scope: { kind: "global" }, records: [] });
		await writeFile(path, bytes);
		const ownerPath = join(workspace, "store.lock");
		const ownerBytes = JSON.stringify({ pid: process.pid });
		await writeFile(ownerPath, ownerBytes);
		const prototype = await fileHandlePrototype(path);
		for (const read of [
			(signal: AbortSignal) => readMemoryRecords(workspace, { kind: "global" }, signal),
			(signal: AbortSignal) => readMemoryLockOwner(ownerPath, signal),
		]) {
			const controller = new AbortController();
			let opened: FileHandle | undefined;
			const original = prototype.read;
			const mocked = t.mock.method(prototype, "read", async function(this: FileHandle, ...args: unknown[]) {
				const result = await Reflect.apply(original, this, args);
				opened = this;
				controller.abort();
				return result;
			});
			try {
				await assert.rejects(read(controller.signal), { code: "CANCELLED" });
				assert.ok(opened);
				assert.equal(opened.fd, -1);
			} finally { mocked.mock.restore(); }
		}
		assert.equal(await readFile(path, "utf8"), bytes);
		assert.equal(await readFile(ownerPath, "utf8"), ownerBytes);
		assert.deepEqual(await readMemoryRecords(workspace, { kind: "global" }), []);
		assert.equal(await readMemoryLockOwner(ownerPath), process.pid);
	});

	it("cancels after syncing a replacement without publishing it and releases the store lock", async (t) => {
		const { base } = await temporaryWorkspace(t);
		const store = new MemoryStore(join(base, "sessions"));
		const scope: MemoryScope = { kind: "global" };
		const record = await store.create(scope, "Original", source());
		const path = join(store.root!, "global.json");
		const before = await readFile(path);
		const prototype = await fileHandlePrototype(path);
		const original = prototype.sync;
		const controller = new AbortController();
		let temporary: FileHandle | undefined;
		const mocked = t.mock.method(prototype, "sync", async function(this: FileHandle) {
			await original.call(this);
			temporary = this;
			controller.abort();
		});
		try {
			await assert.rejects(store.update(scope, record.id, 1, "Cancelled", source(), controller.signal), { code: "CANCELLED" });
			assert.ok(temporary);
			assert.equal(temporary.fd, -1);
		} finally { mocked.mock.restore(); }
		assert.deepEqual(await readFile(path), before);
		assert.deepEqual(await readdir(store.root!), ["global.json"]);
		const updated = await store.update(scope, record.id, 1, "Retried", source());
		assert.equal(updated.revision, 2);
		assert.deepEqual(await store.list([scope]), [updated]);
	});

	it("replays a move after the project is published but clearing the private scope fails", async (t) => {
		const { base } = await temporaryWorkspace(t);
		const store = new MemoryStore(join(base, "sessions"));
		const session = { kind: "session", id: randomUUID() } as const;
		const project = { kind: "project", id: randomUUID() } as const;
		const record = await store.create(session, "Private decision", source());
		const privatePath = join(store.root!, `${memoryScopeKey(session)}.json`);
		const before = await readFile(privatePath);
		const prototype = await fileHandlePrototype(privatePath);
		const original = prototype.sync;
		let publications = 0;
		const mocked = t.mock.method(prototype, "sync", async function(this: FileHandle) {
			await original.call(this);
			if (++publications === 2) throw new Error("Injected private scope publication failure");
		});
		try { await assert.rejects(store.moveSessionToProject(session.id, project.id), { code: "MEMORY_IO" }); }
		finally { mocked.mock.restore(); }
		assert.equal(publications, 2);
		assert.deepEqual(await readFile(privatePath), before);
		const moved = { ...record, scope: project };
		assert.deepEqual(await store.list([project]), [moved]);
		assert.ok((await readdir(store.root!)).every((file) => file.endsWith(".json")));
		const reopened = new MemoryStore(join(base, "sessions"));
		await reopened.moveSessionToProject(session.id, project.id);
		assert.deepEqual(await reopened.list([session]), []);
		assert.deepEqual(await reopened.list([project]), [moved]);
	});
});
