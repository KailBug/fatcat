import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, stat, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import { publishProjectRecord } from "../../src/project/files.js";
import { ProjectStore } from "../../src/project/store.js";
import { temporaryWorkspace } from "../support/workspace.js";

describe("project file and coordination boundaries", () => {
	it("keeps listing policy separate from strict reads without rewriting damaged records", async (t) => {
		const { base, workspace } = await temporaryWorkspace(t);
		const root = join(base, "sessions");
		const store = new ProjectStore({ root });
		assert.deepEqual(await store.list(), []);
		await assert.rejects(store.load(randomUUID()), { code: "PROJECT_NOT_FOUND" });
		await assert.rejects(store.load("../outside"), { code: "PROJECT_NOT_FOUND" });
		await assert.rejects(stat(root), { code: "ENOENT" });
		const last = await store.create("Zulu", workspace);
		const first = await store.create("Alpha", workspace);
		const damaged: Array<{ id: string; bytes: Buffer }> = [
			{ id: randomUUID(), bytes: Buffer.from("{") },
			{ id: randomUUID(), bytes: Buffer.from(JSON.stringify(first)) },
			{ id: randomUUID(), bytes: Buffer.from([0x22, 0xff, 0x22]) },
			{ id: randomUUID(), bytes: Buffer.alloc(64 * 1024 + 1, 0x20) },
		];
		for (const { id, bytes } of damaged) {
			await writeFile(join(store.root, `${id}.json`), bytes);
			await assert.rejects(store.load(id), { code: "PROJECT_CORRUPT" });
		}
		await writeFile(join(store.root, "unrelated.json"), "Ignored entry");
		assert.deepEqual(await store.list(), [first, last]);
		for (const { id, bytes } of damaged) assert.deepEqual(await readFile(join(store.root, `${id}.json`)), bytes);
	});

	it("preserves old records and releases locks after failed publication", async (t) => {
		const { base, workspace } = await temporaryWorkspace(t);
		const root = join(base, "sessions");
		const store = new ProjectStore({ root });
		const record = await store.create("Original", workspace);
		const path = join(store.root, `${record.id}.json`);
		const before = await readFile(path);
		const probe = await open(path, "r");
		const prototype = Object.getPrototypeOf(probe) as FileHandle;
		await probe.close();
		const original = prototype.sync;
		let temporary: FileHandle | undefined;
		const mocked = t.mock.method(prototype, "sync", async function(this: FileHandle) {
			await original.call(this);
			temporary = this;
			throw new Error("Injected project sync failure");
		});
		try {
			await assert.rejects(publishProjectRecord(store.root, { ...record, name: "Unpublished" }), { code: "PROJECT_STORAGE" });
			await assert.rejects(store.create("Failed creation", workspace), { code: "PROJECT_STORAGE" });
			assert.ok(temporary);
			assert.equal(temporary.fd, -1);
		} finally { mocked.mock.restore(); }
		assert.deepEqual(await readFile(path), before);
		assert.deepEqual(await readdir(store.root), [`${record.id}.json`]);
		await assert.rejects(stat(join(root, "metadata.lock")), { code: "ENOENT" });
		const blocked = { ...record, id: randomUUID() };
		const blockedPath = join(store.root, `${blocked.id}.json`);
		await mkdir(blockedPath);
		await writeFile(join(blockedPath, "keep.txt"), "Keep this file");
		await assert.rejects(publishProjectRecord(store.root, blocked), { code: "PROJECT_STORAGE" });
		assert.equal(await readFile(join(blockedPath, "keep.txt"), "utf8"), "Keep this file");
		assert.ok((await readdir(store.root)).every((file) => file.endsWith(".json")));
		const retry = await store.create("Retry", workspace);
		assert.deepEqual(await store.load(retry.id), retry);
		assert.deepEqual(await store.load(record.id), record);
	});

	it("keeps owner recovery and revision validation under the metadata and project locks", async (t) => {
		const { base, workspace } = await temporaryWorkspace(t);
		const root = join(base, "sessions");
		const store = new ProjectStore({ root });
		const record = await store.create("Project", workspace);
		const lock = join(store.root, "store.lock");
		for (const contents of [JSON.stringify({ pid: process.pid }), "{incomplete"]) {
			await writeFile(lock, contents);
			await assert.rejects(store.withProject(record.id, record.revision, async () => assert.fail("Lock was bypassed")), { code: "PROJECT_BUSY" });
			assert.equal(await readFile(lock, "utf8"), contents);
		}
		const missingPid = 2147483647;
		assert.throws(() => process.kill(missingPid, 0), { code: "ESRCH" });
		await writeFile(lock, JSON.stringify({ pid: missingPid }));
		await assert.rejects(store.withProject(record.id, record.revision + 1, async () => assert.fail("Revision was bypassed")), { code: "PROJECT_CONFLICT" });
		await assert.rejects(stat(lock), { code: "ENOENT" });
		await assert.rejects(stat(`${lock}.recovery`), { code: "ENOENT" });
		await store.withProject(record.id, record.revision, async (current) => {
			assert.deepEqual(current, record);
			assert.equal(JSON.parse(await readFile(lock, "utf8")).pid, process.pid);
			assert.equal(JSON.parse(await readFile(join(root, "metadata.lock"), "utf8")).pid, process.pid);
		});
		await assert.rejects(stat(lock), { code: "ENOENT" });
		await assert.rejects(stat(join(root, "metadata.lock")), { code: "ENOENT" });
		assert.deepEqual(await store.load(record.id), record);
	});
});
