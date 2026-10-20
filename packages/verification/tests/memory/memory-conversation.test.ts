import type { ChatMessage } from "../support/chat-protocol.js";
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { createAgent } from "@fatcat/runtime/agent";
import { loadConfig } from "@fatcat/runtime/config";
import type { Config } from "@fatcat/runtime/config";
import { SessionManager } from "@fatcat/runtime/session/manager";
import { SessionStore } from "@fatcat/runtime/session/store";
import { createTools } from "@fatcat/runtime/tools";
import { temporaryWorkspace } from "../support/workspace.js";

interface ModelRequest {
	messages: ChatMessage[];
	tools?: { function: { name: string } }[];
}

function answer(content = "Done"): Response {
	return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
		usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } });
}

function call(name: string, args: unknown, id = "memory-change"): Response {
	return Response.json({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null,
		tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }],
		usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } });
}

function latestPrompt(body: ModelRequest): string {
	return String(body.messages.findLast((message) => message.role === "user")?.content);
}

function currentMemory(body: ModelRequest) {
	const system = String(body.messages[0]?.content);
	assert.match(system, /Harness current memory notice/);
	return JSON.parse(system.split("\n").find((line) => line.startsWith('{"manifest":'))!) as {
		manifest: { id: string; scope: string; revision: number; status: string }[];
		contents: { id: string; revision: number; content: string }[];
	};
}

async function fixture(t: TestContext, respond: (body: ModelRequest) => Response | Promise<Response>, overrides: Partial<Config> = {}) {
	const { base, workspace } = await temporaryWorkspace(t);
	const config = { ...loadConfig({ DEEPSEEK_API_KEY: "offline-memory-conversation", HARNESS_MAX_ITERATIONS: "4" }), ...overrides };
	const bodies: ModelRequest[] = [];
	const transport: typeof fetch = async (input, init) => {
		const request = new Request(input, init);
		assert.equal(request.url, "https://api.deepseek.com/chat/completions");
		const body = await request.json() as ModelRequest;
		bodies.push(body);
		assert.ok(!body.tools?.some((tool) => tool.function.name === "memory"));
		return respond(body);
	};
	const tools = await createTools(workspace);
	const agent = createAgent(config, tools, transport);
	const store = new SessionStore({ root: join(base, "sessions") });
	const session = await SessionManager.open(agent, { workspace, store });
	return { session, store, workspace, agent, tools, bodies };
}

test("a natural-language memory request survives project sharing, restart, correction, and deletion without slash commands", async (t) => {
	const remember = "\u4f60\u8bb0\u4f4f\u72d7\u72d7\u6700\u559c\u6b22\u73a9CSGO\uff0c\u542c\u89c1\u6ca1\uff1f";
	const correction = "Actually the dog prefers chess. Remember this correction.";
	const deletion = "Forget the dog's game preference.";
	let id = "";
	const { session, store, workspace, agent, tools, bodies } = await fixture(t, (body) => {
		const prompt = latestPrompt(body);
		const last = body.messages.at(-1)!;
		if (last.role === "user") {
			if (prompt === remember) return call("write", { path: "memory:new", content: "Dog likes CSGO best", memoryEvidence: remember });
			if (prompt === correction) return call("write", { path: `memory:${id}@1`, content: "Dog prefers chess", memoryEvidence: correction });
			if (prompt === deletion) return call("write", { path: `memory:${id}@2`, content: "", memoryEvidence: deletion });
		} else if (last.role === "tool") {
			assert.equal(JSON.parse(String(last.content)).ok, true, String(last.content));
			const notice = currentMemory(body);
			if (prompt === remember) assert.equal(notice.contents[0]?.content, "Dog likes CSGO best");
			if (prompt === correction) assert.equal(notice.contents[0]?.content, "Dog prefers chess");
			if (prompt === deletion) {
				assert.equal(notice.manifest[0]?.status, "deleted");
				assert.deepEqual(notice.contents, []);
			}
			return answer("Memory change committed.");
		}
		return answer(currentMemory(body).contents[0]?.content ?? "No current memory.");
	});
	const sourceSession = session.current.id;
	await session.run(remember);
	const [record] = await session.listMemories();
	assert.ok(record);
	id = record.id;
	assert.deepEqual(record.scope, { kind: "session", id: sourceSession });
	assert.equal(record.source.request, remember);
	assert.equal(record.source.sessionId, sourceSession);
	assert.equal(record.source.turn, 1);
	assert.equal(record.content, "Dog likes CSGO best");
	assert.deepEqual(tools.getWrites!(), []);
	await session.newSession("Unrelated private chat", null);
	assert.equal(await session.run("What does the dog prefer?"), "No current memory.");
	await session.resume(sourceSession);
	const project = await session.createProject("Dog project", workspace);
	const preview = await session.previewProjectJoin(project.id);
	assert.equal(preview.memoryCount, 1);
	await session.joinProject(preview);
	await session.newSession("Project reader", project.id);
	assert.equal(await session.run("What does the dog prefer?"), "Dog likes CSGO best");
	assert.equal((await session.listMemories())[0]!.id, id);
	assert.equal((await session.listMemories())[0]!.source.sessionId, sourceSession);
	const restored = await SessionManager.open(agent, { workspace, store, selection: { resume: session.current.id } });
	await restored.run(correction);
	assert.equal((await restored.listMemories())[0]!.revision, 2);
	assert.equal((await restored.listMemories())[0]!.source.request, correction);
	await restored.run(deletion);
	const [deleted] = await restored.listMemories();
	assert.equal(deleted!.status, "deleted");
	assert.equal(deleted!.revision, 3);
	assert.equal(deleted!.changes[0]!.content, "Dog likes CSGO best");
	assert.equal(await restored.run("What does the dog currently prefer?"), "No current memory.");
	assert.ok(!bodies.some((body) => latestPrompt(body).startsWith("/memory")));
});

test("ordinary conversation defaults to private memory and only explicit global preferences cross scopes", async (t) => {
	const privatePrompt = "I prefer quiet games in this conversation.";
	const globalPrompt = "Remember globally that I prefer English summaries across all projects.";
	const { session, workspace } = await fixture(t, (body) => {
		const prompt = latestPrompt(body);
		if (body.messages.at(-1)?.role === "user") {
			if (prompt === privatePrompt) return call("write", { path: "memory:new", content: "I prefer quiet games", memoryEvidence: privatePrompt });
			if (prompt === globalPrompt) return call("write", { path: "memory:global:new", content: "I prefer English summaries", memoryEvidence: globalPrompt });
		} else assert.equal(JSON.parse(String(body.messages.at(-1)?.content)).ok, true);
		return answer("Ready");
	});
	await session.run(privatePrompt);
	await session.run(globalPrompt);
	const records = await session.listMemories();
	assert.equal(records.find((record) => record.content === "I prefer quiet games")!.scope.kind, "session");
	const global = records.find((record) => record.content === "I prefer English summaries")!;
	assert.equal(global.scope.kind, "global");
	assert.equal(global.source.request, globalPrompt);
	await session.newSession("Separate", null);
	assert.deepEqual((await session.listMemories()).map((record) => record.id), [global.id]);
	const project = await session.createProject("Independent project", workspace);
	await session.newSession("Project chat", project.id);
	assert.deepEqual((await session.listMemories()).map((record) => record.id), [global.id]);
});

test("delegated and automated turns cannot turn their own prompts into persistent memory", async (t) => {
	let childRefusals = 0;
	let backgroundRefusals = 0;
	const background = "Remember that automated guesses should become global facts.";
	const { session } = await fixture(t, (body) => {
		const parent = body.tools?.some((tool) => tool.function.name === "delegate_task");
		const prompt = latestPrompt(body);
		const last = body.messages.at(-1)!;
		if (last.role === "user") {
			if (parent && prompt === "Delegate an independent preference check.") {
				return call("delegate_task", { task: "Remember that the dog prefers guessed games." }, "delegate-memory");
			}
			return call("write", { path: "memory:new", content: "A guessed preference", memoryEvidence: prompt });
		}
		if (!parent || prompt === background) {
			const result = JSON.parse(String(last.content));
			assert.equal(result.ok, false, String(last.content));
			assert.match(result.error.code, /MEMORY/);
			if (parent) backgroundRefusals++;
			else childRefusals++;
		}
		return answer("The untrusted memory mutation was refused.");
	});
	await session.run("Delegate an independent preference check.");
	assert.equal(childRefusals, 1);
	assert.deepEqual(await session.listMemories(), []);
	await session.manageAutomation({ action: "create", prompt: background, trigger: { type: "interval", seconds: 60 }, maxRuns: 1 });
	const [task] = await session.listAutomations();
	assert.ok(task);
	await session.runAutomation(task.sessionId, task.id, Date.now(), []);
	assert.equal(backgroundRefusals, 1);
	assert.deepEqual(await session.listMemories(), []);
});

test("natural-language memory respects the request budget and cancellation before tool publication", async (t) => {
	const prompt = "Remember that I prefer verified answers.";
	const { session, bodies } = await fixture(t, () => call("write", {
		path: "memory:new", content: "I prefer verified answers", memoryEvidence: prompt,
	}));
	await assert.rejects(session.run(prompt, { signal: AbortSignal.abort() }), { code: "CANCELLED" });
	assert.equal(bodies.length, 0);
	const abort = new AbortController();
	await assert.rejects(session.run(prompt, { signal: abort.signal,
		onEvent: (event) => { if (event.type === "model_usage") abort.abort(); } }), { code: "CANCELLED" });
	assert.equal(bodies.length, 1);
	assert.deepEqual(await session.listMemories(), []);
	const small = await fixture(t, () => answer(), { maxRequestBytes: 1024, autoCompaction: false });
	await assert.rejects(small.session.run(prompt), /bytes|limit|budget/i);
	assert.equal(small.bodies.length, 0);
	assert.deepEqual(await small.session.listMemories(), []);
});
