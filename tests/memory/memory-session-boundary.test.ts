import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { MemoryAccess } from "../../src/memory/tools.js";
import type { SessionAgentOptions } from "../../src/session/agent-session.js";
import { SessionManager } from "../../src/session/manager.js";
import type { MemoryChange } from "../../src/session/manager.js";
import { SessionStore } from "../../src/session/store.js";
import { temporaryWorkspace } from "../support/workspace.js";

const agent: SessionAgentOptions = { maxIterations: 1, model: async () => {
	throw new Error("Host Memory operations must not request a model response.");
} };

describe("Session Memory access boundaries", () => {
	for (const persistence of [true, false]) {
		it(`preserves draft save order on cancellation and invalid changes with persistence=${persistence}`, async (t) => {
			const { base, workspace } = await temporaryWorkspace(t);
			const store = new SessionStore({ root: join(base, "sessions") });
			const manager = await SessionManager.open(agent, { workspace, store, persistence, deferEmptySessions: true });
			const id = manager.current.id;
			assert.deepEqual(await manager.listMemories(), []);
			assert.equal(manager.current.revision, 0);
			assert.deepEqual(await manager.list(), []);
			const change: MemoryChange = { action: "add", scope: "session", content: "Use concise answers" };
			await assert.rejects(manager.changeMemory(change, "Remember my preference", AbortSignal.abort()), { code: "CANCELLED" });
			assert.equal(manager.current.revision, 0);
			await assert.rejects(manager.changeMemory({ ...change, scope: "project" }, "No project selected"), { code: "INVALID_ARGUMENTS" });
			assert.equal(manager.current.id, id);
			assert.ok(manager.current.revision > 0);
			assert.equal((await manager.list())[0]!.id, id);
			assert.deepEqual(await manager.listMemories(), []);
			const saved = await manager.changeMemory(change, "Remember my preference");
			assert.deepEqual(saved.source, { sessionId: id, request: "Remember my preference", turn: 0 });
			assert.deepEqual(manager.history, []);
			if (persistence) assert.equal((await store.loadAny(id)).id, id);
			else await assert.rejects(access(store.root), { code: "ENOENT" });
		});
	}

	it("revalidates captured draft access after saving, switching, migration and deletion", async (t) => {
		const { base, workspace } = await temporaryWorkspace(t);
		const bindings: MemoryAccess[] = [];
		const manager = await SessionManager.open({ ...agent, forSession: (_identity, current, _attachments, memory) => {
			assert.ok(memory);
			bindings.push(memory);
			return current;
		} }, { workspace, store: new SessionStore({ root: join(base, "sessions") }), deferEmptySessions: true });
		const originalId = manager.current.id;
		const draftAccess = bindings[0]!;
		assert.deepEqual(await draftAccess.list(), []);
		const saved = await manager.changeMemory({ action: "add", scope: "session", content: "Original preference" }, "Remember original");
		assert.equal((await draftAccess.list())[0]!.id, saved.id);
		await manager.changeMemory({ action: "update", id: saved.id, revision: 1, content: "Updated preference" }, "Correct preference");
		assert.equal((await draftAccess.list())[0]!.content, "Updated preference");
		await manager.newSession("Other");
		assert.deepEqual(await manager.listMemories(), []);
		// Persistent bindings follow their captured session, not the selected conversation.
		assert.equal((await draftAccess.list())[0]!.id, saved.id);
		await manager.resume(originalId);
		const project = await manager.createProject("Shared", workspace);
		await manager.joinProject(await manager.previewProjectJoin(project.id));
		await assert.rejects(draftAccess.list(), { code: "MEMORY_SCOPE_CHANGED" });
		const projectAccess = bindings.at(-1)!;
		assert.deepEqual((await projectAccess.list())[0]!.scope, { kind: "project", id: project.id });
		await manager.newSession("Project reader");
		await manager.delete(originalId);
		await assert.rejects(draftAccess.list(), { code: "SESSION_NOT_FOUND" });
		await assert.rejects(projectAccess.list(), { code: "SESSION_NOT_FOUND" });
		assert.equal((await manager.listMemories())[0]!.id, saved.id);
	});

	it("rejects an old temporary binding after selection changes while retaining manager-local global Memory", async (t) => {
		const { base, workspace } = await temporaryWorkspace(t);
		const bindings: MemoryAccess[] = [];
		const root = join(base, "unused-store");
		const manager = await SessionManager.open({ ...agent, forSession: (_identity, current, _attachments, memory) => {
			assert.ok(memory);
			bindings.push(memory);
			return current;
		} }, { workspace, store: new SessionStore({ root }), persistence: false });
		const originalAccess = bindings[0]!;
		const saved = await manager.changeMemory({ action: "add", scope: "global", content: "Temporary preference" }, "Remember temporarily");
		assert.equal((await originalAccess.list())[0]!.id, saved.id);
		await manager.newSession();
		await assert.rejects(async () => originalAccess.list(), { code: "MEMORY_SCOPE_CHANGED" });
		assert.equal((await bindings.at(-1)!.list())[0]!.id, saved.id);
		await assert.rejects(access(root), { code: "ENOENT" });
	});

	it("binds project migration to private tombstones even when the active count is unchanged", async (t) => {
		const { base, workspace } = await temporaryWorkspace(t);
		const manager = await SessionManager.open(agent, { workspace, store: new SessionStore({ root: join(base, "sessions") }) });
		const first = await manager.changeMemory({ action: "add", scope: "session", content: "First preference" }, "Remember first");
		await manager.changeMemory({ action: "delete", id: first.id, revision: 1 }, "Forget first");
		const project = await manager.createProject("Shared", workspace);
		const preview = await manager.previewProjectJoin(project.id);
		assert.equal(preview.memoryCount, 0);
		await manager.changeMemory({ action: "add", scope: "global", content: "Global preference" }, "Remember globally");
		assert.equal((await manager.previewProjectJoin(project.id)).memoryFingerprint, preview.memoryFingerprint);
		const second = await manager.changeMemory({ action: "add", scope: "session", content: "Second preference" }, "Remember second");
		await manager.changeMemory({ action: "delete", id: second.id, revision: 1 }, "Forget second");
		const updated = await manager.previewProjectJoin(project.id);
		assert.equal(updated.memoryCount, 0);
		assert.notEqual(updated.memoryFingerprint, preview.memoryFingerprint);
		await assert.rejects(manager.joinProject(preview), { code: "SESSION_CONFLICT" });
		await manager.joinProject(updated);
		const moved = (await manager.listMemories()).filter((record) => record.scope.kind === "project");
		assert.deepEqual(moved.map((record) => record.id).sort(), [first.id, second.id].sort());
		assert.ok(moved.every((record) => record.status === "deleted" && record.revision === 2));
	});
});
