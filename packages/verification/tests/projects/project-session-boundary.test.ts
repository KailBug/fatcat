import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";
import { attachmentReference } from "@fatcat/runtime/attachments/record";
import type { SessionAgentOptions } from "@fatcat/runtime/session/agent-session";
import { SessionManager } from "@fatcat/runtime/session/manager";
import { SessionStore } from "@fatcat/runtime/session/store";
import { temporaryWorkspace } from "../support/workspace.js";

const agent: SessionAgentOptions = { maxIterations: 1, model: async () => ({
	message: { role: "assistant", content: "Done" },
}) };

async function fixture(t: TestContext) {
	const { base, workspace, outside } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	let failPreparation = false;
	const manager = await SessionManager.open(agent, { workspace, store, deferEmptySessions: true,
		agentForWorkspace: async () => {
			if (failPreparation) throw new Error("Injected agent preparation failure");
			return agent;
		} });
	const project = await manager.createProject("Shared", outside);
	return { manager, store, project, workspace, outside,
		failPreparation: (value: boolean) => { failPreparation = value; } };
}

async function upload(manager: SessionManager, content: string) {
	const bytes = Buffer.from(content);
	const target = await manager.beginAttachmentUpload(manager.current.id, "evidence.md", bytes.length);
	return manager.uploadAttachment(target, (async function* () { yield bytes; })());
}

describe("Session Project boundaries", () => {
	it("previews and joins an empty draft without reading persisted attachments or saving it", async (t) => {
		const { manager, store, project } = await fixture(t);
		t.mock.method(store.attachments, "sharingState", async () => {
			assert.fail("Unsaved drafts have no persisted attachment scope to inspect.");
		});
		const id = manager.current.id;
		const preview = await manager.previewProjectJoin(project.id);
		assert.equal(preview.attachmentCount, 0);
		assert.equal(preview.attachmentRevision, 0);
		assert.equal(preview.attachmentFingerprint, "");
		assert.equal(preview.memoryCount, 0);
		await manager.joinProject(preview);
		assert.equal(manager.current.id, id);
		assert.equal(manager.current.projectId, project.id);
		assert.equal(manager.current.revision, 0);
		assert.equal(manager.current.locationRevision, 1);
		assert.deepEqual(await store.listAll(), []);
		assert.deepEqual(manager.history, []);
	});

	it("revalidates same-count Memory and attachment changes for an inactive source without switching the foreground", async (t) => {
		const { manager, store, project, workspace } = await fixture(t);
		await manager.run("Keep the source history");
		const memory = await manager.changeMemory({ action: "add", scope: "session", content: "Original preference" }, "Remember");
		const original = await upload(manager, "Original evidence");
		await manager.manageAutomation({ action: "create", prompt: "Review later", trigger: { type: "interval", seconds: 60 } });
		const source = await store.loadAny(manager.current.id);
		const other = await SessionManager.open(agent, { workspace, store, selection: { resume: source.id } });
		await manager.newSession("Foreground", null);
		const foreground = manager.current;
		const beforeMemory = await manager.previewProjectJoin(project.id, source.id);
		await other.changeMemory({ action: "update", id: memory.id, revision: 1, content: "Updated preference" }, "Correct");
		await assert.rejects(manager.joinProject(beforeMemory), { code: "SESSION_CONFLICT" });
		const beforeAttachment = await manager.previewProjectJoin(project.id, source.id);
		assert.equal(beforeAttachment.memoryCount, beforeMemory.memoryCount);
		assert.notEqual(beforeAttachment.memoryFingerprint, beforeMemory.memoryFingerprint);
		await other.removeAttachment(source.id, attachmentReference(original));
		const replacement = await upload(other, "Replacement evidence");
		await assert.rejects(manager.joinProject(beforeAttachment), { code: "SESSION_CONFLICT" });
		const fresh = await manager.previewProjectJoin(project.id, source.id);
		assert.equal(fresh.attachmentCount, beforeAttachment.attachmentCount);
		assert.notEqual(fresh.attachmentFingerprint, beforeAttachment.attachmentFingerprint);
		await manager.joinProject(fresh);
		await manager.joinProject(fresh);
		assert.deepEqual(manager.current, foreground);
		assert.deepEqual(manager.history, []);
		assert.equal(manager.isBusy, false);
		const saved = await store.loadAny(source.id);
		assert.deepEqual(saved.history, source.history);
		assert.equal(saved.storageWorkspace, workspace);
		assert.equal(saved.locationRevision, 1);
		assert.ok(saved.automations!.every((task) => !task.enabled));
		assert.ok((await manager.listAttachments(source.id)).some((item) => item.id === replacement.id));
		await other.resume(source.id);
		assert.equal((await other.listMemories())[0]!.content, "Updated preference");
	});

	it("keeps a saved source unchanged when preview or join cannot prepare its target agent", async (t) => {
		const { manager, store, project, failPreparation } = await fixture(t);
		await manager.run("Retain this history");
		const current = manager.current;
		const record = await store.loadAny(current.id);
		failPreparation(true);
		await assert.rejects(manager.previewProjectJoin(project.id), /Injected agent preparation failure/);
		assert.equal(manager.isBusy, false);
		failPreparation(false);
		const preview = await manager.previewProjectJoin(project.id);
		failPreparation(true);
		await assert.rejects(manager.joinProject(preview), /Injected agent preparation failure/);
		assert.deepEqual(manager.current, current);
		assert.deepEqual(await store.loadAny(current.id), record);
		assert.equal(manager.isBusy, false);
		failPreparation(false);
		await manager.joinProject(preview);
		assert.equal(manager.current.projectId, project.id);
	});

	for (const draft of [false, true]) {
		it(`does not publish or activate a project directory change after preparation or commit failure with draft=${draft}`, async (t) => {
			const { manager, store, project, workspace, failPreparation } = await fixture(t);
			await manager.newSession(draft ? undefined : "Saved member", project.id);
			const current = manager.current;
			const members = await store.listAll();
			const preview = await manager.previewProjectWorkspace(project.id, workspace);
			failPreparation(true);
			await assert.rejects(manager.changeProjectWorkspace(preview), /Injected agent preparation failure/);
			assert.equal(manager.isBusy, false);
			assert.deepEqual(manager.current, current);
			assert.deepEqual(await store.projects.load(project.id), project);
			failPreparation(false);
			const publication = t.mock.method(store, "changeProjectWorkspace", async () => {
				throw new Error("Injected failure before project commit");
			});
			await assert.rejects(manager.changeProjectWorkspace(preview), /Injected failure before project commit/);
			assert.deepEqual(manager.current, current);
			assert.deepEqual(await store.listAll(), members);
			assert.deepEqual(await store.projects.load(project.id), project);
			assert.equal(manager.isBusy, false);
			publication.mock.restore();
			await manager.changeProjectWorkspace(preview);
			assert.equal(manager.current.workspace, workspace);
			assert.equal(manager.current.locationRevision, 1);
			assert.equal(manager.current.id, current.id);
			if (draft) {
				assert.equal(manager.current.revision, 0);
				assert.deepEqual(await store.listAll(), []);
			}
		});
	}

	it("prepares a replacement before deleting the active project", async (t) => {
		const { manager, store, project, workspace, failPreparation } = await fixture(t);
		await manager.newSession("Saved member", project.id);
		const members = await store.listAll();
		await manager.newSession();
		const current = manager.current;
		const preview = await manager.previewProjectDelete(project.id);
		failPreparation(true);
		await assert.rejects(manager.deleteProject(preview), /Injected agent preparation failure/);
		assert.deepEqual(await store.projects.load(project.id), project);
		assert.deepEqual(await store.listAll(), members);
		assert.deepEqual(manager.current, current);
		assert.equal(manager.isBusy, false);
		failPreparation(false);
		await manager.deleteProject(preview);
		assert.equal(manager.current.workspace, workspace);
		assert.equal(manager.current.projectId, undefined);
		assert.equal(manager.current.revision, 0);
		assert.deepEqual(await store.listAll(), []);
	});

	it("retains a committed rename if refreshing the draft agent fails, then refreshes on retry", async (t) => {
		const { manager, store, project, failPreparation } = await fixture(t);
		await manager.newSession(undefined, project.id);
		const current = manager.current;
		failPreparation(true);
		await assert.rejects(manager.renameProject(project.id, "Renamed", project.revision), /Injected agent preparation failure/);
		const renamed = await store.projects.load(project.id);
		assert.equal(renamed.name, "Renamed");
		assert.equal(renamed.revision, project.revision + 1);
		assert.deepEqual(manager.current, current);
		assert.equal(manager.isBusy, false);
		failPreparation(false);
		await manager.renameProject(project.id, renamed.name, renamed.revision);
		assert.equal(manager.current.projectName, renamed.name);
		assert.equal(manager.current.revision, 0);
		assert.equal(manager.current.locationRevision, current.locationRevision);
		assert.deepEqual(await store.listAll(), []);
	});
});
