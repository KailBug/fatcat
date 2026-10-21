import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { TestContext } from "node:test";
import { SessionManager } from "@fatcat/runtime/session/manager";
import { SessionStore } from "@fatcat/runtime/session/store";
import { attachmentReference } from "@fatcat/runtime/attachments/record";
import { createTools } from "@fatcat/runtime/tools";
import { WebUiController } from "@fatcat/webui/internal/controller";
import { startWebUiServer } from "@fatcat/webui/internal/server";
import type { WorkspacePicker } from "@fatcat/webui/internal/folder-picker";
import type { ProjectManagementConfirmation } from "@fatcat/webui/internal/project-management";
import { temporaryWorkspace } from "../support/workspace.js";

async function setup(t: TestContext, picker?: WorkspacePicker) {
	const fixture = await temporaryWorkspace(t);
	const { workspace, outside, base } = fixture;
	await writeFile(join(workspace, "marker.txt"), "Original workspace files");
	await writeFile(join(outside, "marker.txt"), "Destination workspace files");
	const factory = async (path: string) => ({ tools: await createTools(path), maxIterations: 1,
		model: async () => ({ message: { role: "assistant" as const, content: "Offline answer" } }) });
	const store = new SessionStore({ root: join(base, "sessions") });
	const manager = await SessionManager.open(await factory(workspace), { workspace, store,
		deferEmptySessions: true, agentForWorkspace: factory });
	const project = await manager.createProject("Research", workspace);
	await manager.newSession("First", project.id);
	const first = manager.current.id;
	await manager.run("Original history");
	const history = manager.history;
	await manager.newSession("Second", project.id);
	const second = manager.current.id;
	await manager.resume(first);
	const controller = await WebUiController.create({ workspace, provider: "deepseek", model: "offline",
		permission: "read-only", shellPermission: "deny", webPermission: "deny", maxIterations: 1,
		maxRequestBytes: 262144, skills: 0, warnings: [] }, manager);
	const server = await startWebUiServer(controller, 0, picker ?? (async () => outside));
	t.after(() => server.close());
	const token = new URL(server.url).hash.slice("#token=".length);
	const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
	const post = (path: string, body: unknown, custom = headers) => fetch(`${server.origin}/api/project/${path}`, {
		method: "POST", headers: custom, body: JSON.stringify(body),
	});
	const preview = async (kind: "workspace" | "delete", revision = project.revision) => {
		const response = await post(`${kind}-preview`, { id: project.id, revision });
		assert.equal(response.status, 200, await response.clone().text());
		return await response.json() as ProjectManagementConfirmation;
	};
	const upload = async (sessionId: string, name: string) => {
		const target = await manager.beginAttachmentUpload(sessionId, name, 7);
		return manager.uploadAttachment(target, (async function* () { yield Buffer.from("fixture"); })());
	};
	return { ...fixture, store, manager, controller, project, first, second, history, server, post, preview, upload, headers };
}

test("project rename requires the selected revision and leaves identity, directory and history unchanged", async (t) => {
	const { project, manager, controller, post, headers, history, workspace, first } = await setup(t);
	const body = { id: project.id, revision: project.revision, name: "Renamed" };
	assert.equal((await post("rename", body, { ...headers, Authorization: "Bearer invalid" })).status, 401);
	assert.equal((await post("rename", { ...body, name: "Bad\nname" })).status, 400);
	assert.equal((await post("rename", { ...body, workspace })).status, 400);
	assert.equal((await post("rename", body)).status, 202);
	assert.equal(manager.current.id, first);
	assert.equal(manager.current.projectId, project.id);
	assert.equal(manager.current.projectName, "Renamed");
	assert.equal(manager.current.workspace, workspace);
	assert.deepEqual(manager.history, history);
	assert.equal(controller.snapshot().projects[0]!.name, "Renamed");
	assert.equal((await post("rename", { ...body, name: "Stale" })).status, 409);
	assert.equal(manager.current.projectName, "Renamed");
});

test("native project workspace selection can be cancelled and browser-supplied paths are rejected", async (t) => {
	const { project, post, manager, history, workspace } = await setup(t, async () => null);
	assert.equal((await post("workspace-preview", { id: project.id, revision: project.revision, path: "D:\\other" })).status, 400);
	const cancelled = await post("workspace-preview", { id: project.id, revision: project.revision });
	assert.equal(cancelled.status, 200);
	assert.equal(await cancelled.json(), null);
	assert.equal(manager.current.workspace, workspace);
	assert.deepEqual(manager.history, history);
	assert.equal((await manager.listProjects())[0]!.revision, project.revision);
});

test("project directory confirmation applies to every member without moving files or rewriting history", async (t) => {
	const { manager, controller, preview, post, store, first, second, project, history, workspace, outside, upload } = await setup(t);
	const file = await upload(first, "evidence.md");
	const confirmation = await preview("workspace");
	assert.equal(confirmation.kind, "workspace");
	if (confirmation.kind !== "workspace") assert.fail("Expected a workspace impact preview.");
	assert.equal(confirmation.preview.fromWorkspace, workspace);
	assert.equal(confirmation.preview.toWorkspace, outside);
	assert.equal(confirmation.preview.sessionCount, 2);
	assert.equal(manager.current.workspace, workspace);
	assert.equal((await post("workspace", { token: confirmation.token, confirmed: false })).status, 400);
	assert.equal((await post("workspace", { token: confirmation.token, confirmed: true, toWorkspace: workspace })).status, 400);
	assert.equal((await post("workspace", { token: confirmation.token, confirmed: true })).status, 202);
	assert.equal(manager.current.workspace, outside);
	assert.equal(controller.snapshot().info.workspace, outside);
	assert.equal((await store.loadAny(second)).workspace, outside);
	assert.deepEqual(manager.history, history);
	assert.equal((await manager.listAttachments(first))[0]!.id, file.id);
	assert.equal(await readFile(join(workspace, "marker.txt"), "utf8"), "Original workspace files");
	assert.equal(await readFile(join(outside, "marker.txt"), "utf8"), "Destination workspace files");
	assert.equal((await post("workspace", { token: confirmation.token, confirmed: true })).status, 409);
	assert.equal((await manager.listProjects())[0]!.id, project.id);
});

test("project impact confirmations reject changed members, attachments and operation kinds", async (t) => {
	const { manager, project, first, preview, post, upload } = await setup(t);
	const moved = await preview("workspace");
	await manager.rename("Member renamed", first);
	assert.equal((await post("workspace", { token: moved.token, confirmed: true })).status, 409);
	const deletion = await preview("delete");
	await upload(first, "new.md");
	assert.equal((await post("delete", { token: deletion.token, confirmed: true })).status, 409);
	assert.equal((await manager.listProjects())[0]!.id, project.id);
	const wrongKind = await preview("workspace");
	assert.equal((await post("delete", { token: wrongKind.token, confirmed: true })).status, 409);
	assert.equal((await manager.listProjects())[0]!.id, project.id);
});

test("workspace previews count enabled automations while deletion previews include paused tasks", async (t) => {
	const { manager, first, second, store, preview, post } = await setup(t);
	const task = { action: "create", prompt: "Scheduled project check", trigger: { type: "interval", seconds: 60 }, maxRuns: 2 };
	await manager.manageSessionAutomation(first, task);
	await manager.manageSessionAutomation(second, task);
	const paused = (await store.loadAny(second)).automations![0]!;
	await manager.manageSessionAutomation(second, { action: "pause", id: paused.id });
	const workspace = await preview("workspace");
	const deletion = await preview("delete");
	assert.equal(workspace.preview.automationCount, 1);
	assert.equal(deletion.preview.automationCount, 2);
	assert.equal((await post("workspace", { token: workspace.token, confirmed: true })).status, 202);
	for (const id of [first, second]) assert.ok((await store.loadAny(id)).automations?.every((task) => !task.enabled));
});

test("deleting a project removes its sessions and owned originals, retains external references and never deletes workspace files", async (t) => {
	const { manager, controller, project, store, first, second, post, preview, upload, workspace } = await setup(t);
	await upload(first, "project-only.md");
	await manager.newSession("To share", null);
	const source = manager.current.id;
	const retained = await upload(source, "shared-with-fork.md");
	await manager.fork("Outside fork");
	const external = manager.current.id;
	await manager.joinProject(await manager.previewProjectJoin(project.id, source));
	const confirmation = await preview("delete");
	assert.equal(confirmation.kind, "delete");
	if (confirmation.kind !== "delete") assert.fail("Expected a deletion impact preview.");
	assert.equal(confirmation.preview.sessionCount, 3);
	assert.equal(confirmation.preview.attachmentCount, 2);
	assert.equal(confirmation.preview.retainedAttachmentCount, 1);
	assert.equal(confirmation.preview.deleteAttachmentCount, 1);
	assert.equal((await post("delete", { token: confirmation.token, confirmed: false })).status, 400);
	assert.equal((await post("delete", { token: confirmation.token, confirmed: true })).status, 202);
	assert.equal(manager.current.id, external);
	assert.deepEqual(controller.snapshot().projects, []);
	for (const id of [first, second, source]) await assert.rejects(store.loadAny(id));
	assert.equal((await manager.listAttachments(external))[0]!.id, retained.id);
	assert.equal((await manager.readAttachment(attachmentReference(retained), { sessionId: external })).kind, "file");
	assert.equal(await readFile(join(workspace, "marker.txt"), "utf8"), "Original workspace files");
	assert.equal((await post("delete", { token: confirmation.token, confirmed: true })).status, 409);
});

test("deleting the selected project restores an independent unsaved welcome screen", async (t) => {
	const { manager, controller, preview, post, store, first, second, workspace } = await setup(t);
	const confirmation = await preview("delete");
	assert.equal((await post("delete", { token: confirmation.token, confirmed: true })).status, 202);
	assert.equal(manager.current.projectId, undefined);
	assert.equal(manager.current.revision, 0);
	assert.equal(manager.current.workspace, workspace);
	assert.notEqual(manager.current.id, first);
	assert.notEqual(manager.current.id, second);
	assert.deepEqual(controller.snapshot().turns, []);
	assert.deepEqual(await store.listAll(), []);
});

test("project management refuses pending approvals and old confirmations after the turn is cancelled", async (t) => {
	const { base, workspace, outside } = await temporaryWorkspace(t);
	let controller!: WebUiController;
	const tools = await createTools(workspace, "ask", (request, signal) => controller.requestApproval("write", request, signal));
	const call = { id: "pending-project-write", name: "write", arguments: '{"path":"pending.txt","content":"approval required"}' };
	const manager = await SessionManager.open({ tools, maxIterations: 2,
		model: async () => ({ message: { role: "assistant", content: null, toolCalls: [call] } }) },
	{ workspace, store: new SessionStore({ root: join(base, "sessions") }) });
	const project = await manager.createProject("Guarded", workspace);
	await manager.newSession("Guarded session", project.id);
	controller = await WebUiController.create({ workspace, provider: "deepseek", model: "offline", permission: "ask",
		shellPermission: "deny", webPermission: "deny", maxIterations: 2, maxRequestBytes: 262144, skills: 0, warnings: [] }, manager);
	let selections = 0;
	const server = await startWebUiServer(controller, 0, async () => { selections++; return outside; });
	t.after(() => server.close());
	const token = new URL(server.url).hash.slice("#token=".length);
	const post = (path: string, body: unknown) => fetch(`${server.origin}/api/project/${path}`, { method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
	const before = await (await post("delete-preview", { id: project.id, revision: project.revision })).json() as ProjectManagementConfirmation;
	controller.submit("Wait for file approval");
	const deadline = Date.now() + 10_000;
	while (!controller.snapshot().approval) { assert.ok(Date.now() < deadline); await delay(10); }
	const approvalId = controller.snapshot().approval!.id;
	for (const path of ["workspace-preview", "delete-preview", "rename"]) {
		assert.equal((await post(path, { id: project.id, revision: project.revision, ...(path === "rename" ? { name: "Blocked" } : {}) })).status, 409);
	}
	assert.equal((await post("delete", { token: before.token, confirmed: true })).status, 409);
	assert.equal(selections, 0);
	controller.stop();
	while (controller.snapshot().busy) { assert.ok(Date.now() < deadline); await delay(10); }
	assert.throws(() => controller.approve(approvalId, true));
	assert.equal((await post("delete", { token: before.token, confirmed: true })).status, 409);
	assert.equal(manager.current.projectId, project.id);
	await assert.rejects(readFile(join(workspace, "pending.txt")));
});
