import type { ChatMessage } from "../support/chat-protocol.js";
import assert from "node:assert/strict";
import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createAgent } from "@fatcat/runtime/agent";
import { loadConfig } from "@fatcat/runtime/config";
import { HarnessError } from "@fatcat/runtime/errors";
import type { Message, Model, ModelTurn } from "@fatcat/runtime/model-types";
import { SessionManager } from "@fatcat/runtime/session/manager";
import { SessionStore } from "@fatcat/runtime/session/store";
import { workspaceKey } from "@fatcat/runtime/session/record";
import { createTools } from "@fatcat/runtime/tools";
import { temporaryWorkspace } from "../support/workspace.js";

const answer = (content = "Done"): ModelTurn => ({ message: { role: "assistant", content } });
const agent = { model: async () => answer(), maxIterations: 4 };
const code = (expected: string) => (error: unknown) => error instanceof HarnessError && error.code === expected;

test("project sessions share one directory, retain independent histories, and fork within the project", async (t) => {
	const { base, workspace, outside } = await temporaryWorkspace(t);
	await writeFile(join(workspace, "marker.txt"), "Original workspace");
	await writeFile(join(outside, "marker.txt"), "Project workspace");
	const store = new SessionStore({ root: join(base, "sessions") });
	const factory = async (root: string) => {
		const tools = await createTools(root, "read-only", undefined, { permission: "deny" });
		return { ...agent, tools, model: async (messages: Message[]) => {
			assert.match(String(messages[0]?.content), /Actual executing session/);
			return answer(JSON.stringify(await tools.execute("read", '{"path":"marker.txt"}')));
		} };
	};
	const session = await SessionManager.open(await factory(workspace), { workspace, store, agentForWorkspace: factory });
	const standalone = session.current.id;
	const project = await session.createProject("Documents", outside);
	await session.newSession("First", project.id);
	const first = session.current.id;
	assert.match(await session.run("First history"), /Project workspace/);
	await session.newSession("Second");
	const second = session.current.id;
	await session.run("Second history");
	assert.equal(session.current.projectId, project.id);
	assert.ok(!JSON.stringify(session.history).includes("First history"));
	await assert.rejects(session.setWorkspace(workspace), code("PROJECT_WORKSPACE"));
	const resumed = await SessionManager.open(await factory(workspace), {
		workspace, store, agentForWorkspace: factory, selection: { resume: first },
	});
	assert.equal(resumed.current.workspace, outside);
	assert.match(JSON.stringify(resumed.history), /First history/);
	await resumed.fork("Branch");
	assert.equal(resumed.current.projectId, project.id);
	assert.equal(resumed.current.forkedFrom, first);
	assert.equal((await store.loadAny(standalone)).location?.kind, "standalone");
	assert.equal((await store.loadAny(second)).history[1]?.content, "Second history");
	await resumed.delete(resumed.current.id);
	assert.equal(resumed.current.projectId, project.id);
	assert.equal((await resumed.listProjects()).length, 1);
});

test("joining preserves history, paths and storage, and notifies only until a successful resumed turn", async (t) => {
	const { base, workspace, outside } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const requests: Message[][] = [];
	let fail = false;
	const model: Model = async (messages) => {
		requests.push(structuredClone(messages));
		if (fail) throw new HarnessError("MODEL_CONNECTION", "Injected outage");
		return answer();
	};
	const session = await SessionManager.open({ ...agent, model }, { workspace, store });
	await writeFile(join(workspace, "kept.txt"), "Original bytes");
	await session.run(`Keep this original path ${workspace}. ` + "old text ".repeat(800));
	await session.run("Recent history");
	const history = session.history;
	const id = session.current.id;
	const project = await session.createProject("Project", outside);
	const preview = await session.previewProjectJoin(project.id);
	assert.equal(session.current.projectId, undefined);
	await session.joinProject(preview);
	await session.joinProject(preview);
	assert.deepEqual(session.history, history);
	assert.equal(await readFile(join(workspace, "kept.txt"), "utf8"), "Original bytes");
	await assert.rejects(readFile(join(outside, "kept.txt")));
	const raw = JSON.parse(await readFile(join(store.root, workspaceKey(workspace), `${id}.json`), "utf8"));
	assert.equal(raw.workspace, undefined);
	assert.equal(raw.storageWorkspace, workspace);
	assert.deepEqual(raw.history, history);
	const resumed = await SessionManager.open({ ...agent, model }, { workspace, store, selection: { resume: id } });
	await resumed.compact();
	fail = true;
	await assert.rejects(resumed.run("Fail after moving"), code("MODEL_CONNECTION"));
	assert.match(String(requests.at(-1)?.[0]?.content), /Original directory files were not moved/);
	assert.equal((await store.loadAny(id)).locationChanges?.[0]?.acknowledged, false);
	fail = false;
	await resumed.run("Use the new directory");
	assert.equal((await store.loadAny(id)).locationChanges?.[0]?.acknowledged, true);
	await resumed.run("Continue again");
	assert.ok(!String(requests.at(-1)?.[0]?.content).includes("Harness workspace and project changes"));
});

test("a stale preview cannot overwrite a concurrent turn or rename, including a second manager", async (t) => {
	const { base, workspace, outside } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const first = await SessionManager.open(agent, { workspace, store });
	const project = await first.createProject("Project", outside);
	const stale = await SessionManager.open(agent, { workspace, store, selection: { resume: first.current.id } });
	const preview = await stale.previewProjectJoin(project.id);
	await first.run("Concurrent history");
	await assert.rejects(stale.joinProject(preview), code("SESSION_CONFLICT"));
	assert.equal((await store.loadAny(first.current.id)).location?.kind, "standalone");
	const fresh = await stale.previewProjectJoin(project.id);
	await stale.joinProject(fresh);
	assert.match(JSON.stringify(stale.history), /Concurrent history/);
	await assert.rejects(first.run("Stale attempt"), code("SESSION_CONFLICT"));
});

test("running compaction rejects joins in another manager and cancelled compaction releases its claim", async (t) => {
	const { base, workspace, outside } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	let entered!: () => void;
	let release!: () => void;
	const started = new Promise<void>((resolve) => { entered = resolve; });
	const gate = new Promise<void>((resolve) => { release = resolve; });
	const session = await SessionManager.open({ ...agent, compactionModel: async () => {
		entered(); await gate; return answer("Short summary");
	} }, { workspace, store });
	await session.run("Long history ".repeat(700));
	await session.run("Keep recent");
	const project = await session.createProject("Project", outside);
	const second = await SessionManager.open(agent, { workspace, store, selection: { resume: session.current.id } });
	const abort = new AbortController();
	const pending = session.compact({ signal: abort.signal });
	await started;
	assert.equal((await store.loadAny(session.current.id)).activeOperation?.kind, "compact");
	await assert.rejects(second.previewProjectJoin(project.id), code("SESSION_BUSY"));
	abort.abort(); release();
	await assert.rejects(pending, code("CANCELLED"));
	assert.equal((await store.loadAny(session.current.id)).activeOperation, undefined);
	await second.joinProject(await second.previewProjectJoin(project.id));
	assert.equal(second.current.projectId, project.id);
});

test("failed compact release remains blocked until the owning runtime can settle it", async (t) => {
	const { base, workspace, outside } = await temporaryWorkspace(t);
	class FailingStore extends SessionStore {
		failRelease = false;
		override save(...args: Parameters<SessionStore["save"]>) {
			if (this.failRelease && args[3]?.operationId) throw new HarnessError("SESSION_STORAGE", "Injected release failure");
			return super.save(...args);
		}
	}
	const store = new FailingStore({ root: join(base, "sessions") });
	const session = await SessionManager.open({ ...agent, compactionModel: async () => {
		throw new HarnessError("MODEL_CONNECTION", "Injected outage");
	} }, { workspace, store });
	await session.run("Long history ".repeat(700));
	await session.run("Keep recent");
	const id = session.current.id;
	const project = await session.createProject("Project", outside);
	store.failRelease = true;
	await assert.rejects(session.compact(), code("SESSION_STORAGE"));
	await assert.rejects(session.newSession(), code("SESSION_STORAGE"));
	assert.equal(session.current.id, id);
	assert.ok((await store.loadAny(id)).activeOperation);
	store.failRelease = false;
	await session.joinProject(await session.previewProjectJoin(project.id));
	assert.equal((await store.loadAny(id)).activeOperation, undefined);
	assert.equal(session.current.projectId, project.id);
});

test("migration pauses tasks and invalidates queued activations even after explicitly resuming", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	let calls = 0;
	const session = await SessionManager.open({ ...agent, model: async () => { calls++; return answer(); } }, { workspace, store });
	await session.manageAutomation({ action: "create", prompt: "Scheduled work", trigger: { type: "interval", seconds: 60 }, maxRuns: 2 });
	const old = (await session.listAutomations())[0]!;
	const project = await session.createProject("Same directory", workspace);
	await session.joinProject(await session.previewProjectJoin(project.id));
	assert.equal((await store.loadAny(session.current.id)).automations?.[0]?.enabled, false);
	await session.manageAutomation({ action: "resume", id: old.id });
	await assert.rejects(session.runAutomation(old.sessionId, old.id, Date.now(), [], {
		locationRevision: old.locationRevision!,
	}), code("AUTOMATION_INACTIVE"));
	assert.equal(calls, 0);
	const current = (await session.listAutomations())[0]!;
	await session.runAutomation(current.sessionId, current.id, Date.now(), [], { locationRevision: current.locationRevision! });
	assert.equal(calls, 1);
	assert.equal((await store.loadAny(current.sessionId)).automations?.[0]?.runs, 1);
});

test("same-directory background delegation uses the target project and never the selected session", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	const seen: { messages: ChatMessage[]; child: boolean }[] = [];
	const config = loadConfig({ DEEPSEEK_API_KEY: "offline-project-fixture", HARNESS_MAX_ITERATIONS: "3" });
	const runtime = createAgent(config, undefined, async (input, init) => {
		const body = await new Request(input, init).json() as { messages: ChatMessage[]; tools: { function: { name: string } }[] };
		const child = !body.tools.some((tool) => tool.function.name === "delegate_task");
		seen.push({ messages: body.messages, child });
		const message = !child && body.messages.at(-1)?.role === "user"
			? { role: "assistant", content: null, tool_calls: [{ id: "child", type: "function", function: {
				name: "delegate_task", arguments: JSON.stringify({ task: "Inspect the bound project identity" }),
			} }] }
			: { role: "assistant", content: "Checked identity" };
		return Response.json({ choices: [{ finish_reason: "tool_calls" in message ? "tool_calls" : "stop", message }] });
	});
	const session = await SessionManager.open(runtime, { workspace, store });
	const p = await session.createProject("P", workspace);
	const q = await session.createProject("Q", workspace);
	await session.newSession("Target", p.id);
	await session.manageAutomation({ action: "create", prompt: "Review with independent child", trigger: { type: "interval", seconds: 60 }, maxRuns: 1 });
	const target = (await session.listAutomations())[0]!;
	await session.newSession("Selected", q.id);
	const selected = session.current.id;
	await session.runAutomation(target.sessionId, target.id, Date.now(), [], { locationRevision: target.locationRevision! });
	assert.equal(session.current.id, selected);
	assert.ok(seen.some((request) => request.child));
	for (const request of seen) {
		const system = String(request.messages[0]?.content);
		assert.ok(system.includes(target.sessionId));
		assert.ok(system.includes(p.id));
		assert.ok(!system.includes(q.id));
	}
	assert.equal(session.history.length, 0);
	assert.equal((await store.loadAny(target.sessionId)).history.filter((message) => message.role === "user").length, 1);
});

test("unavailable project keeps its transcript visible and prevents model requests", async (t) => {
	const { base, workspace, outside } = await temporaryWorkspace(t);
	const store = new SessionStore({ root: join(base, "sessions") });
	let calls = 0;
	const runtime = { ...agent, model: async () => { calls++; return answer(); } };
	const session = await SessionManager.open(runtime, { workspace, store });
	const project = await session.createProject("Missing directory", outside);
	await session.newSession(undefined, project.id);
	await session.run("Preserve this transcript");
	const id = session.current.id;
	await rename(outside, join(base, "moved"));
	const resumed = await SessionManager.open(runtime, { workspace, store, selection: { resume: id } });
	assert.ok(resumed.current.projectError);
	assert.equal(resumed.current.workspace, "");
	assert.match(JSON.stringify(resumed.history), /Preserve this transcript/);
	await assert.rejects(resumed.run("Do not fall back"), code("PROJECT_UNAVAILABLE"));
	assert.equal(calls, 1);
});
