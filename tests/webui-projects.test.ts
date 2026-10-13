import assert from "node:assert/strict";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { TestContext } from "node:test";
import { SessionManager } from "../src/session/manager.js";
import { SessionStore } from "../src/session/store.js";
import { createTools } from "../src/tools.js";
import { WebUiController } from "../webui/controller.js";
import type { WebUiState } from "../webui/controller.js";
import type { ProjectJoinConfirmation } from "../webui/projects.js";
import type { WorkspacePicker } from "../webui/folder-picker.js";
import { startWebUiServer } from "../webui/server.js";
import { temporaryWorkspace } from "./fixtures/workspace.js";

const info = { provider: "deepseek", model: "offline", permission: "read-only", shellPermission: "deny", webPermission: "deny",
	maxIterations: 1, maxRequestBytes: 262144, skills: 0, warnings: [] };

async function factory(workspace: string) {
	const tools = await createTools(workspace);
	return { tools, maxIterations: 1, model: async () => ({ toolCalls: [], message: { role: "assistant" as const,
		content: JSON.stringify(await tools.execute("read", '{"path":"marker.txt"}')) } }) };
}

async function setup(t: TestContext, picker?: WorkspacePicker) {
	const fixture = await temporaryWorkspace(t);
	const { base, workspace, outside } = fixture;
	await writeFile(join(workspace, "marker.txt"), "Original workspace");
	await writeFile(join(outside, "marker.txt"), "Project workspace");
	const store = new SessionStore({ root: join(base, "sessions") });
	const manager = await SessionManager.open(await factory(workspace), {
		workspace, store, deferEmptySessions: true, agentForWorkspace: factory,
	});
	const controller = await WebUiController.create({ ...info, workspace }, manager);
	const server = await startWebUiServer(controller, 0, picker ?? (async () => outside));
	t.after(() => server.close());
	const token = new URL(server.url).hash.slice("#token=".length);
	const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
	const post = (path: string, body: unknown, custom = headers) => fetch(`${server.origin}/api/${path}`, {
		method: "POST", headers: custom, body: JSON.stringify(body),
	});
	return { ...fixture, store, manager, controller, server, post, headers };
}

async function idle(controller: WebUiController): Promise<void> {
	await until(() => !controller.snapshot().busy);
}

async function until(predicate: () => boolean): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!predicate()) {
		assert.ok(Date.now() < deadline, "Expected state should be reached within 10 seconds.");
		await delay(10);
	}
}

test("project creation uses authenticated native selection and does not select a different session", async (t) => {
	let complete: ((path: string | null) => void) | undefined;
	const finish = (path: string | null) => { assert.ok(complete); complete(path); };
	const fixture = await setup(t, (_path, signal) => new Promise((resolve) => {
		complete = resolve;
		signal.addEventListener("abort", () => resolve(null), { once: true });
	}));
	const { manager, controller, post, headers, outside } = fixture;
	const original = manager.current;
	assert.equal((await post("project/create", { name: "Project" }, { ...headers, Authorization: "Bearer wrong" })).status, 401);
	assert.equal((await post("project/create", { name: "Project", path: outside })).status, 400);
	assert.equal((await post("project/create", { name: "bad\nname" })).status, 400);
	assert.equal(complete, undefined);
	const cancelled = post("project/create", { name: "Cancelled" });
	await until(() => complete !== undefined);
	assert.equal((await post("session/new", {})).status, 409);
	finish(null);
	assert.equal((await cancelled).status, 202);
	assert.deepEqual(controller.snapshot().projects, []);
	assert.deepEqual(manager.current, original);
	complete = undefined;
	const creating = post("project/create", { name: "Project" });
	await until(() => complete !== undefined);
	finish(outside);
	assert.equal((await creating).status, 202);
	assert.equal(controller.snapshot().projects[0]?.workspace, outside);
	assert.deepEqual(manager.current, original);
});

test("project sessions restore separate histories and reject per-session directory changes", async (t) => {
	const { post, controller, manager, store, workspace, outside, server, headers } = await setup(t);
	assert.equal((await post("project/create", { name: "Evidence" })).status, 202);
	const project = controller.snapshot().projects[0]!;
	assert.equal((await post("session/new", { projectId: project.id })).status, 202);
	const first = manager.current.id;
	assert.equal(manager.current.projectId, project.id);
	assert.equal(manager.current.workspace, outside);
	assert.equal(manager.current.revision, 0);
	assert.equal((await post("message", { prompt: "First conversation" })).status, 202);
	await idle(controller);
	assert.match(controller.snapshot().turns[0]!.answer!, /Project workspace/);
	assert.equal((await post("session/new", { projectId: project.id })).status, 202);
	assert.notEqual(manager.current.id, first);
	assert.deepEqual(manager.history, []);
	assert.equal((await post("session/workspace", { path: workspace })).status, 400);
	assert.equal((await post("session/choose-workspace", { id: manager.current.id })).status, 400);
	assert.equal(manager.current.workspace, outside);
	assert.equal((await post("session/new", { projectId: null })).status, 202);
	assert.equal(manager.current.projectId, undefined);
	assert.equal((await post("session/resume", { id: first })).status, 202);
	assert.equal(controller.snapshot().turns[0]?.prompt, "First conversation");
	const state = await (await fetch(`${server.origin}/api/state`, { headers })).json() as WebUiState;
	assert.equal(state.current.projectId, project.id);
	assert.equal(state.projects[0]?.id, project.id);
	const restored = await SessionManager.open(await factory(workspace), { workspace, store,
		selection: { resume: first }, agentForWorkspace: factory });
	assert.equal(restored.current.projectId, project.id);
	assert.equal(restored.current.workspace, outside);
	assert.deepEqual(restored.history, manager.history);
});

test("join confirmation binds an inactive session and rejects stale or browser-altered previews", async (t) => {
	const { post, manager, controller, store, workspace, outside } = await setup(t);
	controller.submit("Keep original paths and history");
	await idle(controller);
	const source = manager.current.id;
	const history = manager.history;
	assert.equal((await post("project/create", { name: "Shared" })).status, 202);
	const project = controller.snapshot().projects[0]!;
	const preview = await (await post("project/join-preview", { projectId: project.id, sessionId: source })).json() as ProjectJoinConfirmation;
	assert.equal(preview.preview.fromWorkspace, workspace);
	assert.equal(preview.preview.toWorkspace, outside);
	assert.equal((await post("project/join", { token: preview.token, confirmed: false })).status, 400);
	assert.equal((await post("project/join", { token: preview.token, confirmed: true, toWorkspace: workspace })).status, 400);
	assert.equal((await post("session/rename", { id: source, name: "Changed after preview" })).status, 202);
	assert.equal((await post("project/join", { token: preview.token, confirmed: true })).status, 409);
	assert.equal((await store.loadAny(source)).location?.kind, "standalone");
	const fresh = await (await post("project/join-preview", { projectId: project.id, sessionId: source })).json() as ProjectJoinConfirmation;
	assert.equal((await post("session/new", { projectId: null })).status, 202);
	const selected = manager.current.id;
	assert.equal((await post("project/join", { token: fresh.token, confirmed: true })).status, 202);
	assert.equal(manager.current.id, selected);
	assert.deepEqual(controller.snapshot().turns, []);
	const moved = await store.loadAny(source);
	assert.deepEqual(moved.history, history);
	assert.equal(moved.storageWorkspace, workspace);
	assert.equal(await readFile(join(workspace, "marker.txt"), "utf8"), "Original workspace");
	assert.equal((await post("project/join", { token: fresh.token, confirmed: true })).status, 409);
	assert.equal((await post("session/resume", { id: source })).status, 202);
	assert.equal(manager.current.projectId, project.id);
	controller.submit("Read after the move");
	await idle(controller);
	assert.match(controller.snapshot().turns.at(-1)!.answer!, /Project workspace/);
});

test("project preview refuses active turns and stop invalidates existing approval responses", async (t) => {
	const { workspace, outside, base } = await temporaryWorkspace(t);
	let controller: WebUiController | undefined;
	const tools = await createTools(workspace, "ask", (request, signal) => controller!.requestApproval("write", request, signal));
	const call = { id: "project-write", type: "function" as const, function: { name: "write", arguments: '{"path":"pending.txt","content":"blocked"}' } };
	const manager = await SessionManager.open({ tools, maxIterations: 2,
		model: async () => ({ message: { role: "assistant", content: null, tool_calls: [call] }, toolCalls: [call] }) },
		{ workspace, store: new SessionStore({ root: join(base, "sessions") }) });
	const project = await manager.createProject("Shared", outside);
	controller = await WebUiController.create({ ...info, workspace }, manager);
	t.after(() => controller?.close());
	controller.submit("Request a write");
	await until(() => Boolean(controller!.snapshot().approval));
	const approval = controller.snapshot().approval!;
	await assert.rejects(controller.previewProjectJoin(project.id, manager.current.id), /Stop or finish/);
	controller.stop();
	await idle(controller);
	assert.throws(() => controller!.approve(approval.id, true), /approval/i);
	assert.equal(manager.current.projectId, undefined);
	await assert.rejects(readFile(join(workspace, "pending.txt")));
});

test("a confirmed draft move remains unsaved until an explicit persistent operation", async (t) => {
	const { controller, manager, store, post, workspace, outside } = await setup(t);
	const original = manager.current.id;
	assert.equal((await post("project/create", { name: "Draft target" })).status, 202);
	const project = controller.snapshot().projects[0]!;
	const confirmation = await (await post("project/join-preview", { projectId: project.id, sessionId: original })).json() as ProjectJoinConfirmation;
	assert.equal((await manager.list()).length, 0);
	assert.equal(manager.current.workspace, workspace);
	assert.equal((await post("project/join", { token: confirmation.token, confirmed: true })).status, 202);
	assert.equal(manager.current.id, original);
	assert.equal(manager.current.projectId, project.id);
	assert.equal(manager.current.workspace, outside);
	assert.equal(manager.current.revision, 0);
	assert.deepEqual(await manager.list(), []);
	assert.equal((await post("session/rename", { id: original, name: "Saved draft" })).status, 202);
	assert.equal((await store.loadAny(original)).location?.kind, "project");
	assert.equal(controller.snapshot().sessions[0]?.projectId, project.id);
});

test("an unavailable project keeps history visible while previews and evidence cannot fall back to cwd", async (t) => {
	const { controller, manager, store, post, workspace, outside, server, headers } = await setup(t);
	await writeFile(join(outside, "view.html"), "<h1>Project page</h1>");
	assert.equal((await post("project/create", { name: "Missing later" })).status, 202);
	const project = controller.snapshot().projects[0]!;
	assert.equal((await post("session/new", { projectId: project.id, name: "Retained history" })).status, 202);
	controller.submit("Saved before the project became unavailable");
	await idle(controller);
	const id = manager.current.id;
	const history = manager.history;
	const snapshot = await (await post("preview", { path: "view.html" })).json() as { url: string };
	await unlink(join(store.projects.root, `${project.id}.json`));
	assert.equal((await post("session/resume", { id })).status, 202);
	assert.ok(manager.current.projectError);
	assert.equal(controller.fileWorkspace, undefined);
	assert.equal((await post("preview", { path: "view.html" })).status, 400);
	assert.equal((await post("workspaces", { path: "." })).status, 400);
	assert.equal((await fetch(`${server.origin}${snapshot.url}`)).status, 404);
	assert.equal((await fetch(`${server.origin}/api/browser-evidence/${"a".repeat(32)}/report`, { headers })).status, 404);
	assert.deepEqual(manager.history, history);
	await server.close();
	const restored = await SessionManager.open(await factory(workspace), { workspace, store,
		selection: { resume: id }, agentForWorkspace: factory });
	const readOnly = await WebUiController.create({ ...info, workspace }, restored);
	const replacement = await startWebUiServer(readOnly, 0);
	t.after(() => replacement.close());
	assert.ok(readOnly.snapshot().current.projectError);
	assert.equal(readOnly.snapshot().turns[0]?.prompt, "Saved before the project became unavailable");
});
