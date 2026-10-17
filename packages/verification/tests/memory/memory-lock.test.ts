import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";
import { MemoryStore } from "@fatcat/runtime/internal/memory/store";
import { temporaryWorkspace } from "../support/workspace.js";

const scope = { kind: "global" } as const;
const source = { sessionId: randomUUID(), request: "Remember this decision", turn: 1 };
const denied = () => Object.assign(new Error("Injected lock access failure"), { code: "EPERM" });

function interceptLockOpen(t: TestContext, path: string, beforeOpen: () => void): void {
	const original = fs.open;
	const mocked = t.mock.method(fs, "open", async (...args: Parameters<typeof fs.open>) => {
		if (args[0] === path && args[1] === "wx") beforeOpen();
		return original(...args);
	});
	syncBuiltinESMExports();
	t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
}

describe("Windows memory lock acquisition", { skip: process.platform !== "win32" }, () => {
	it("waits for transient access failures before publishing exactly one record", async (t) => {
		const { workspace } = await temporaryWorkspace(t);
		const store = new MemoryStore(workspace);
		let attempts = 0;
		interceptLockOpen(t, join(store.root!, "store.lock"), () => {
			if (++attempts <= 2) throw denied();
		});
		const record = await store.create(scope, "Decision", source);
		assert.equal(attempts, 3);
		assert.deepEqual(await store.list([scope]), [record]);
		assert.deepEqual(await fs.readdir(store.root!), ["global.json"]);
	});

	it("bounds persistent access failures without publishing or removing another owner's lock", async (t) => {
		const { workspace } = await temporaryWorkspace(t);
		const store = new MemoryStore(workspace);
		await store.create(scope, "Original", source);
		const before = await fs.readFile(join(store.root!, "global.json"));
		const path = join(store.root!, "store.lock");
		const owner = JSON.stringify({ pid: process.pid });
		await fs.writeFile(path, owner);
		let attempts = 0;
		interceptLockOpen(t, path, () => { attempts++; throw denied(); });
		await assert.rejects(store.create(scope, "Blocked", source), { code: "MEMORY_IO" });
		assert.equal(attempts, 40);
		assert.deepEqual(await fs.readFile(join(store.root!, "global.json")), before);
		assert.equal(await fs.readFile(path, "utf8"), owner);
		assert.deepEqual((await fs.readdir(store.root!)).sort(), ["global.json", "store.lock"]);
	});

	it("honors cancellation during access-failure backoff", async (t) => {
		const { workspace } = await temporaryWorkspace(t);
		const store = new MemoryStore(workspace);
		const controller = new AbortController();
		let attempts = 0;
		interceptLockOpen(t, join(store.root!, "store.lock"), () => {
			attempts++;
			controller.abort();
			throw denied();
		});
		await assert.rejects(store.create(scope, "Cancelled", source, controller.signal), { code: "CANCELLED" });
		assert.equal(attempts, 1);
		assert.deepEqual(await fs.readdir(store.root!), []);
	});

	it("does not retry unrelated open failures", async (t) => {
		const { workspace } = await temporaryWorkspace(t);
		const store = new MemoryStore(workspace);
		let attempts = 0;
		interceptLockOpen(t, join(store.root!, "store.lock"), () => {
			attempts++;
			throw Object.assign(new Error("Injected I/O failure"), { code: "EIO" });
		});
		await assert.rejects(store.create(scope, "Blocked", source), { code: "MEMORY_IO" });
		assert.equal(attempts, 1);
		assert.deepEqual(await fs.readdir(store.root!), []);
	});

	it("does not retry owner-record write failures and removes its unpublished lock", async (t) => {
		const { workspace } = await temporaryWorkspace(t);
		const store = new MemoryStore(workspace);
		const probe = await fs.open(join(workspace, "probe"), "w");
		const prototype = Object.getPrototypeOf(probe) as typeof probe;
		await probe.close();
		let attempts = 0;
		interceptLockOpen(t, join(store.root!, "store.lock"), () => { attempts++; });
		const mocked = t.mock.method(prototype, "writeFile", async () => { throw denied(); });
		try {
			await assert.rejects(store.create(scope, "Blocked", source), { code: "MEMORY_IO" });
			assert.equal(attempts, 1);
			assert.deepEqual(await fs.readdir(store.root!), []);
		} finally { mocked.mock.restore(); }
	});
});
