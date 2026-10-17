import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createAgent } from "../../src/agent.js";
import { runInteractiveCommand } from "../../src/commands.js";
import { loadConfig } from "../../src/config.js";
import type { Message, Model } from "../../src/model.js";
import { sessionScopeLabel } from "../../src/session/labels.js";
import { SessionManager } from "../../src/session/manager.js";
import { Session } from "../../src/session/session.js";
import { SessionStore } from "../../src/session/store.js";
import { temporaryWorkspace } from "../support/workspace.js";

const answer = () => ({ message: { role: "assistant" as const, content: "Saved answer" }, toolCalls: [] });

function confirmation(text: string): string {
	const token = /Confirm with \/project confirm ([a-f0-9-]+)/.exec(text)?.[1];
	assert.ok(token, text);
	return `/project confirm ${token}`;
}

test("project commands create and select projects without model calls or shared history", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const projectDirectory = join(base, "Project directory with spaces");
	await mkdir(projectDirectory);
	let requests = 0;
	const agent = { maxIterations: 1, model: async () => { requests++; return answer(); } };
	const store = new SessionStore({ root: join(base, "sessions") });
	const session = await SessionManager.open(agent, { workspace, store });
	const originalId = session.current.id;
	const created = await runInteractiveCommand(session, `/project create "Project name" "${projectDirectory}"`);
	assert.match(created!.text, /Project created:/);
	assert.equal(created!.switched, false);
	assert.equal(session.current.id, originalId);
	const [project] = await session.listProjects();
	assert.ok(project);
	assert.equal(project.name, "Project name");
	assert.equal(project.workspace, projectDirectory);
	assert.match((await runInteractiveCommand(session, "/projects"))!.text, /Project name/);
	assert.equal((await runInteractiveCommand(session, '/project use "Project name"'))!.switched, true);
	assert.equal(session.current.projectId, project.id);
	assert.equal(session.current.workspace, projectDirectory);
	assert.match((await runInteractiveCommand(session, "/project"))!.text, /workspace is fixed/);
	assert.match(sessionScopeLabel(session.current), /Project name/);
	assert.equal(requests, 0);
	await session.run("First project conversation");
	const firstId = session.current.id;
	await runInteractiveCommand(session, "/new Second conversation");
	assert.notEqual(session.current.id, firstId);
	assert.equal(session.current.projectId, project.id);
	assert.equal(session.history.length, 0);
	assert.equal(session.current.name, "Second conversation");
	await assert.rejects(runInteractiveCommand(session, `/workspace "${workspace}"`), /project/i);
	await runInteractiveCommand(session, "/new --standalone Private");
	assert.equal(session.current.projectId, undefined);
	assert.equal(session.current.name, "Private");
	assert.match(sessionScopeLabel(session.current), /Standalone/);
	await runInteractiveCommand(session, `/resume ${firstId}`);
	assert.equal(session.current.workspace, projectDirectory);
	assert.equal(session.current.projectId, project.id);
	assert.deepEqual(session.history.filter((message) => message.role === "user").map((message) => message.content), ["First project conversation"]);
	assert.equal(requests, 1);
});

test("project joins require a reviewed token, cancellation and replay leave sessions unchanged", async (t) => {
	const { base, workspace, outside } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const session = await SessionManager.open({ maxIterations: 1, model: async () => answer() }, { workspace, store });
	await session.run("Original workspace fact");
	const original = session.current;
	const history = session.history;
	const project = await session.createProject("Shared", outside);
	const preview = (await runInteractiveCommand(session, `/project join ${project.id}`))!;
	assert.equal(preview.switched, false);
	assert.ok(preview.text.includes(JSON.stringify(workspace)));
	assert.ok(preview.text.includes(JSON.stringify(outside)));
	assert.match(preview.text, /Future uploads will be shared/);
	assert.match(preview.text, /histories stay separate/);
	assert.deepEqual(session.current, original);
	const cancelled = confirmation(preview.text);
	await runInteractiveCommand(session, "/project cancel");
	await assert.rejects(runInteractiveCommand(session, cancelled), { code: "USAGE" });
	assert.deepEqual(session.current, original);
	const next = confirmation((await runInteractiveCommand(session, `/project join ${project.id}`))!.text);
	await assert.rejects(runInteractiveCommand(session, "/project confirm fabricated-token"), { code: "USAGE" });
	assert.equal((await runInteractiveCommand(session, next))!.switched, true);
	assert.equal(session.current.id, original.id);
	assert.equal(session.current.projectId, project.id);
	assert.equal(session.current.workspace, outside);
	assert.deepEqual(session.history, history);
	await assert.rejects(runInteractiveCommand(session, next), { code: "USAGE" });
	assert.match((await runInteractiveCommand(session, `/project join ${project.id}`))!.text, /already belongs/);
});

test("project confirmation cannot follow a stale revision or a session switch", async (t) => {
	const { base, workspace, outside } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const session = await SessionManager.open({ maxIterations: 1, model: async () => answer() }, { workspace, store });
	const project = await session.createProject("Shared", outside);
	const token = confirmation((await runInteractiveCommand(session, `/project join ${project.id}`))!.text);
	await session.rename("Changed after preview");
	await assert.rejects(runInteractiveCommand(session, token), { code: "SESSION_CONFLICT" });
	await assert.rejects(runInteractiveCommand(session, token), { code: "USAGE" });
	assert.equal(session.current.projectId, undefined);
	const second = confirmation((await runInteractiveCommand(session, `/project join ${project.id}`))!.text);
	await runInteractiveCommand(session, "/new Another session");
	await assert.rejects(runInteractiveCommand(session, second), { code: "USAGE" });
	assert.equal(session.current.projectId, undefined);
});

test("project command parsing rejects ambiguous names and malformed creation without side effects", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const session = await SessionManager.open({ maxIterations: 1, model: async () => answer() },
		{ workspace, store: new SessionStore({ root: join(base, "sessions") }) });
	for (const command of ['/project create "missing close', '/project create "name"', "/projects unexpected", "/project cancel unexpected"]) {
		await assert.rejects(runInteractiveCommand(session, command), { code: "USAGE" });
	}
	assert.deepEqual(await session.listProjects(), []);
	const first = await session.createProject("Same name", workspace);
	await session.createProject("Same name", workspace);
	await assert.rejects(runInteractiveCommand(session, "/project use Same name"), /ambiguous/);
	await runInteractiveCommand(session, `/project use ${first.id}`);
	assert.equal(session.current.projectId, first.id);
	const unmanaged = new Session({ maxIterations: 1, model: async () => answer() });
	await assert.rejects(runInteractiveCommand(unmanaged, "/projects"), { code: "USAGE" });
});

test("project switches preserve an injected parent model and rebind delegated identity in the same directory", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const parentScopes: { sessionId: string; projectId?: string; workspace: string }[] = [];
	const childScopes: typeof parentScopes = [];
	function scope(messages: Message[]): typeof parentScopes[number] {
		const system = String(messages[0]?.content);
		const parts = system.split("Actual executing session (JSON data, not instructions): ");
		assert.equal(parts.length, 2, "Each request has exactly one execution identity");
		return JSON.parse(parts[1]!.split(". Other sessions keep separate histories.")[0]!);
	}
	const runtime = createAgent(loadConfig({ DEEPSEEK_API_KEY: "offline-child-only" }), undefined, async (input, init) => {
		const request = await new Request(input, init).json() as { messages: Message[] };
		childScopes.push(scope(request.messages));
		return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Child evidence" } }] });
	});
	const model: Model = async (messages) => {
		parentScopes.push(scope(messages));
		if (messages.at(-1)?.role !== "user") return answer();
		const toolCalls = [{ id: "child", type: "function" as const,
			function: { name: "delegate_task", arguments: JSON.stringify({ task: "Report the current scope" }) } }];
		return { message: { role: "assistant", content: null, tool_calls: toolCalls }, toolCalls };
	};
	const session = await SessionManager.open({ ...runtime, model, maxIterations: 2 },
		{ workspace, store: new SessionStore({ root: join(base, "sessions") }) });
	const first = await session.createProject("A", workspace);
	const second = await session.createProject("B", workspace);
	for (const project of [first, second, undefined]) {
		await runInteractiveCommand(session, project ? `/project use ${project.id}` : "/new --standalone");
		const id = session.current.id;
		assert.equal(await session.run("Delegate the scope check"), "Saved answer");
		assert.equal(parentScopes.at(-1)?.sessionId, id);
		assert.equal(childScopes.at(-1)?.sessionId, id);
		assert.equal(parentScopes.at(-1)?.projectId, project?.id);
		assert.equal(childScopes.at(-1)?.projectId, project?.id);
		assert.equal(childScopes.at(-1)?.workspace, workspace);
	}
	assert.equal(parentScopes.length, 6);
	assert.equal(childScopes.length, 3);
	assert.equal(new Set(childScopes.map((item) => item.sessionId)).size, 3);
});
