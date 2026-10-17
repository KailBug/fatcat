import assert from "node:assert/strict";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { attachmentReference } from "@fatcat/runtime/attachments/record";
import type { Message, ModelTurn } from "@fatcat/runtime/model";
import { SessionManager } from "@fatcat/runtime/session/manager";
import { SessionStore } from "@fatcat/runtime/session/store";
import { createTools } from "@fatcat/runtime/tools";
import { temporaryWorkspace } from "../support/workspace.js";

const answer = (content = "Done"): ModelTurn => ({ message: { role: "assistant", content }, toolCalls: [] });
const agent = { model: async () => answer(), maxIterations: 4 };

async function upload(session: SessionManager, content: string) {
	const bytes = Buffer.from(content);
	const target = await session.beginAttachmentUpload(session.current.id, "evidence.md", bytes.length);
	return session.uploadAttachment(target, (async function* () { yield bytes; })());
}

test("project rename refreshes the selected draft and persists names without combining histories", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const session = await SessionManager.open(agent, { workspace, store, deferEmptySessions: true });
	const project = await session.createProject("Before", workspace);
	await session.newSession("Member", project.id);
	await session.run("Saved member history");
	const member = session.current.id;
	const history = session.history;
	await session.newSession();
	const draft = session.current.id;
	await session.renameProject(project.id, "After", project.revision);
	assert.equal(session.current.projectName, "After");
	assert.equal(session.current.id, draft);
	assert.equal(session.current.revision, 0);
	assert.deepEqual(session.history, []);
	await session.changeProjectWorkspace(await session.previewProjectWorkspace(project.id, workspace));
	assert.equal(session.current.locationRevision, 0);
	assert.equal((await session.list()).some((item) => item.id === draft), false);
	assert.deepEqual((await store.loadAny(member)).history, history);
	const restored = await SessionManager.open(agent, { workspace, store: new SessionStore({ root: store.root }), selection: { resume: member } });
	assert.equal(restored.current.projectName, "After");
	await restored.run("Continue with the renamed project");
	await assert.rejects(session.renameProject(project.id, "Stale", project.revision), /changed|conflict|refresh/i);
});

test("project directory changes update all members, tools and notices while keeping originals and histories", async (t) => {
	const { base, workspace, outside } = await temporaryWorkspace(t);
	await writeFile(join(workspace, "marker.txt"), "Old directory");
	await writeFile(join(outside, "marker.txt"), "New directory");
	const store = new SessionStore({ root: join(base, "sessions") });
	const requests: Message[][] = [];
	const factory = async (root: string) => {
		const tools = await createTools(root, "read-only", undefined, { permission: "deny" });
		return { ...agent, tools, model: async (messages: Message[]) => {
			requests.push(structuredClone(messages));
			return answer(JSON.stringify(await tools.execute("read", '{"path":"marker.txt"}')));
		} };
	};
	const session = await SessionManager.open(await factory(workspace), { workspace, store, agentForWorkspace: factory, deferEmptySessions: true });
	const project = await session.createProject("Documents", workspace);
	await session.newSession("First", project.id);
	await session.run("Preserve the first history");
	await session.manageAutomation({ action: "create", prompt: "Scheduled work", trigger: { type: "interval", seconds: 60 }, maxRuns: 2 });
	const first = await store.loadAny(session.current.id);
	const file = await upload(session, "Unchanged project evidence");
	await session.newSession("Second");
	await session.run("Preserve the second history");
	const second = await store.loadAny(session.current.id);
	await session.newSession();
	const draft = session.current.id;
	const oldUpload = await session.beginAttachmentUpload(draft, "late.md", 4);
	const preview = await session.previewProjectWorkspace(project.id, outside, project.revision);
	assert.equal(preview.sessionCount, 2);
	assert.equal(preview.automationCount, 1);
	assert.equal(session.current.workspace, workspace);
	await session.changeProjectWorkspace(preview);
	assert.equal(session.current.workspace, outside);
	assert.equal(session.current.id, draft);
	assert.equal(session.current.revision, 0);
	assert.equal(session.current.locationRevision, 1);
	assert.equal((await session.list()).some((item) => item.id === draft), false);
	for (const before of [first, second]) {
		const after = await store.loadAny(before.id);
		assert.equal(after.workspace, outside);
		assert.equal(after.storageWorkspace, workspace);
		assert.equal(after.locationRevision, (before.locationRevision ?? 0) + 1);
		assert.deepEqual(after.history, before.history);
		assert.equal(after.locationChanges?.at(-1)?.fromWorkspace, workspace);
		assert.equal(after.locationChanges?.at(-1)?.acknowledged, false);
		assert.ok(after.automations?.every((task) => !task.enabled));
	}
	await assert.rejects(session.uploadAttachment(oldUpload, (async function* () { yield Buffer.from("late"); })()), /changed|moved|draft/i);
	assert.equal((await session.listAttachments())[0]?.id, file.id);
	assert.match(JSON.stringify(await session.readAttachment(attachmentReference(file))), /Unchanged project evidence/);
	assert.equal(await readFile(join(workspace, "marker.txt"), "utf8"), "Old directory");
	assert.match(await session.run("Read the current marker"), /New directory/);
	assert.match(String(requests.at(-1)?.[0]?.content), /Original directory files were not moved/);
	await session.resume(first.id);
	assert.match(await session.run("Read from the resumed member"), /New directory/);
	assert.equal((await store.loadAny(first.id)).locationChanges?.at(-1)?.acknowledged, true);
});

test("deleting the active project discards its draft and saved members without deleting workspace files", async (t) => {
	const { base, workspace, outside } = await temporaryWorkspace(t);
	await writeFile(join(outside, "kept.txt"), "User-owned directory file");
	const store = new SessionStore({ root: join(base, "sessions") });
	const session = await SessionManager.open(agent, { workspace, store, deferEmptySessions: true });
	const project = await session.createProject("Delete", outside);
	await session.newSession("First", project.id);
	await upload(session, "Project-owned original");
	await session.newSession("Second");
	await session.run("A separate history");
	await session.newSession();
	const oldDraft = session.current.id;
	const oldUpload = await session.beginAttachmentUpload(oldDraft, "late.md", 4);
	const preview = await session.previewProjectDelete(project.id, project.revision);
	assert.equal(preview.sessionCount, 2);
	assert.equal(preview.attachmentCount, 1);
	assert.equal(preview.deleteAttachmentCount, 1);
	await session.deleteProject(preview);
	assert.deepEqual(await session.listProjects(), []);
	assert.deepEqual(await session.list(), []);
	assert.equal(session.current.projectId, undefined);
	assert.equal(session.current.workspace, workspace);
	assert.equal(session.current.revision, 0);
	assert.notEqual(session.current.id, oldDraft);
	assert.deepEqual(session.history, []);
	assert.equal(await readFile(join(outside, "kept.txt"), "utf8"), "User-owned directory file");
	await assert.rejects(session.uploadAttachment(oldUpload, (async function* () { yield Buffer.from("late"); })()));
});

test("managing an inactive project leaves the selected independent session and its private files unchanged", async (t) => {
	const { base, workspace, outside } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const session = await SessionManager.open(agent, { workspace, store });
	await session.run("Keep selected independent history");
	const file = await upload(session, "Private evidence");
	const selected = session.current;
	const history = session.history;
	const project = await session.createProject("Inactive", outside);
	await session.renameProject(project.id, "Renamed", project.revision);
	await session.changeProjectWorkspace(await session.previewProjectWorkspace(project.id, workspace));
	await session.deleteProject(await session.previewProjectDelete(project.id));
	assert.deepEqual(session.current, selected);
	assert.deepEqual(session.history, history);
	assert.match(JSON.stringify(await session.readAttachment(attachmentReference(file))), /Private evidence/);
});

test("a missing project directory can be repaired or its project deleted without losing the transcript first", async (t) => {
	const { base, workspace, outside } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const session = await SessionManager.open(agent, { workspace, store });
	const project = await session.createProject("Missing directory", outside);
	await session.newSession("Member", project.id);
	await session.run("Keep the transcript");
	const member = session.current.id;
	await rename(outside, join(base, "moved"));
	await session.resume(member);
	assert.ok(session.current.projectError);
	await session.changeProjectWorkspace(await session.previewProjectWorkspace(project.id, workspace));
	assert.equal(session.current.projectError, undefined);
	assert.equal(session.current.workspace, workspace);
	assert.match(JSON.stringify(session.history), /Keep the transcript/);
	assert.equal((await store.loadAny(member)).locationChanges?.at(-1)?.fromWorkspace, outside);
	await session.run("Continue after repairing the directory");
	const unavailable = await session.createProject("Delete missing", join(base, "moved"));
	await session.newSession("Missing member", unavailable.id);
	await rename(join(base, "moved"), outside);
	await session.resume(session.current.id);
	assert.ok(session.current.projectError);
	await session.deleteProject(await session.previewProjectDelete(unavailable.id));
	assert.equal(session.current.projectId, undefined);
	assert.equal(session.current.workspace, workspace);
});

for (const draft of [false, true]) {
	for (const action of ["rename", "workspace"] as const) {
		test(`project ${action} refreshes ${draft ? "draft" : "saved"} tools after another manager changes the directory`, async (t) => {
			const { base, workspace, outside } = await temporaryWorkspace(t);
			await writeFile(join(workspace, "marker.txt"), "Old directory");
			await writeFile(join(outside, "marker.txt"), "New directory");
			const store = new SessionStore({ root: join(base, "sessions") });
			const factory = async (root: string) => {
				const tools = await createTools(root, "read-only", undefined, { permission: "deny" });
				return { ...agent, tools, model: async () => answer(JSON.stringify(await tools.execute("read", '{"path":"marker.txt"}'))) };
			};
			const session = await SessionManager.open(await factory(workspace), {
				workspace, store, agentForWorkspace: factory, deferEmptySessions: true,
			});
			const project = await session.createProject("Concurrent", workspace);
			await session.newSession(draft ? undefined : "Member", project.id);
			const target = await session.beginAttachmentUpload(session.current.id, "old.md", 4);
			const external = await SessionManager.open(agent, { workspace, store, deferEmptySessions: true });
			await external.changeProjectWorkspace(await external.previewProjectWorkspace(project.id, outside));
			if (action === "rename") {
				const latest = (await session.listProjects())[0]!;
				await session.renameProject(project.id, "Renamed", latest.revision);
			} else {
				// The project already uses this directory, but the selected runtime is stale.
				await session.changeProjectWorkspace(await session.previewProjectWorkspace(project.id, outside));
			}
			assert.equal(session.current.workspace, outside);
			assert.equal(session.current.locationRevision, 1);
			if (draft) assert.equal(session.current.revision, 0);
			await assert.rejects(session.uploadAttachment(target, (async function* () { yield Buffer.from("late"); })()));
			assert.match(await session.run("Read the current directory"), /New directory/);
		});
	}
}
