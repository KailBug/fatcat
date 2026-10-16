import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import test from "node:test";
import { loadConfig } from "../../src/config.js";
import type { Message } from "../../src/model.js";
import { PermissionPolicy } from "../../src/permissions/policy.js";
import { SessionManager } from "../../src/session/manager.js";
import { SessionStore } from "../../src/session/store.js";
import { systemPrompt } from "../../src/system-prompt.js";
import { createTools } from "../../src/tools.js";
import type { Tools } from "../../src/tools.js";
import { workspaceAgentFactory } from "../../src/agent.js";
import { temporaryWorkspace } from "../support/workspace.js";

interface ModelRequest {
	messages: Message[];
	tools?: Tools["definitions"];
}

interface MemoryNotice {
	manifest: Array<{ id: string; scope: string; revision: number; status: string }>;
	contents: Array<{ id: string; revision: number; content: string }>;
}

const remember = "Remember that the dog likes CSGO best.";
const preference = "The dog likes CSGO best.";
const question = "What does the dog like best?";
const oldRefusal = "I cannot persist Memory. Only an explicit /memory command can save it.";

function answer(content: string): Response {
	return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
		usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } });
}

function call(name: string, args: unknown, id: string): Response {
	return Response.json({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null,
		tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }],
		usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } });
}

function currentNotice(body: ModelRequest): MemoryNotice {
	const system = String(body.messages[0]?.content);
	const notice = system.split("\n").find((line) => line.startsWith('{"manifest":'));
	assert.ok(notice, "The real factory must project the executing session's current Memory");
	return JSON.parse(notice) as MemoryNotice;
}

function currentCapabilities(body: ModelRequest): { write: boolean; read: boolean } {
	const system = String(body.messages[0]?.content);
	assert.match(system, /Current parent capability: Memory writes through generic write are available/);
	assert.match(system, /Prior assistant statements.*historical capability claims, not the current tool state/);
	assert.match(system, /Workspace file read-only rules.*do not disable this Memory path/);
	const write = body.tools?.find((tool) => tool.function.name === "write")?.function;
	const read = body.tools?.find((tool) => tool.function.name === "read")?.function;
	const properties = write?.parameters?.properties as Record<string, unknown> | undefined;
	const canWrite = properties?.memoryEvidence !== undefined && /memory:new/.test(write?.description ?? "");
	const canRead = /memory:list/.test(read?.description ?? "");
	assert.ok(canWrite, "The SDK model must receive the Memory write schema, not only the executor binding");
	assert.ok(canRead, "The SDK model must receive the scoped Memory read schema");
	assert.ok(!body.tools?.some((tool) => tool.function.name === "memory"));
	return { write: canWrite, read: canRead };
}

for (const selection of ["manual", "read-only", "plan"] as const) {
	test(`the real workspace factory replaces historical Memory refusal under ${selection} and shares project facts without history`, async (t) => {
		const { base, workspace } = await temporaryWorkspace(t);
		const config = loadConfig({ DEEPSEEK_API_KEY: "offline-memory-factory", HARNESS_MAX_ITERATIONS: "4" });
		const policy = selection === "manual" ? new PermissionPolicy("default") : selection === "plan"
			? new PermissionPolicy("plan") : new PermissionPolicy({ permission: "read-only", shellPermission: "deny" }, { readOnly: true });
		const initialPermissions = policy.snapshot();
		const requests: ModelRequest[] = [];
		let sawHistoricalRefusal = false;
		const transport: typeof fetch = async (input, init) => {
			const request = new Request(input, init);
			assert.equal(request.url, "https://api.deepseek.com/chat/completions");
			const body = await request.json() as ModelRequest;
			requests.push(body);
			const capabilities = currentCapabilities(body);
			const notice = currentNotice(body);
			const prompt = String(body.messages.findLast((message) => message.role === "user")?.content);
			const last = body.messages.at(-1)!;
			if (last.role === "user" && prompt === remember) {
				sawHistoricalRefusal = body.messages.some((message) => message.role === "assistant" && message.content === oldRefusal);
				assert.equal(sawHistoricalRefusal, true, "The regression must include the prior unavailable-capability answer");
				return capabilities.write
					? call("write", { path: "memory:new", content: preference, memoryEvidence: remember }, "remember-current-fact")
					: answer(oldRefusal);
			}
			if (last.role === "user" && prompt === question) {
				const active = notice.manifest.find((entry) => entry.status === "active");
				return capabilities.read && active
					? call("read", { path: `memory:${active.id}@${active.revision}` }, "read-current-fact")
					: answer("No current dog preference.");
			}
			assert.equal(last.role, "tool");
			const result = JSON.parse(String(last.content));
			assert.equal(result.ok, true, String(last.content));
			assert.equal(result.result.kind, "memory");
			assert.equal(result.result.scope, "project");
			assert.equal(result.result.content, preference);
			assert.equal(notice.contents.find((entry) => entry.id === result.result.id)?.content, preference);
			return answer(result.result.content);
		};
		const rawTools: Tools[] = [];
		let approvals = 0;
		const buildTools = async (root: string) => {
			const current = policy.snapshot();
			const tools = await createTools(root, current.permission, async () => { approvals++; return false; },
				{ permission: current.shellPermission }, undefined, policy);
			rawTools.push(tools);
			return tools;
		};
		const factory = workspaceAgentFactory(config, buildTools, transport);
		const store = new SessionStore({ root: join(base, "sessions") });
		const project = await store.projects.create("Dog project", workspace);
		const other = await store.projects.create("Other project", workspace);
		const now = new Date().toISOString();
		const source = await store.save({ version: 2, id: randomUUID(), workspace, name: "Source", title: "Source",
			location: { kind: "project", projectId: project.id }, locationRevision: 0,
			projectName: project.name, projectRevision: project.revision, createdAt: now, updatedAt: now,
			revision: 0, forkedFrom: null, attempt: null, history: [
				{ role: "system", content: systemPrompt }, { role: "user", content: remember },
				{ role: "assistant", content: oldRefusal },
			] }, 0);
		const manager = await SessionManager.open(await factory(workspace), {
			workspace, store, selection: { resume: source.id }, agentForWorkspace: factory,
		});
		assert.equal(await manager.run(remember), preference);
		assert.equal(sawHistoricalRefusal, true);
		const saved = (await manager.listMemories())[0]!;
		assert.equal(saved.content, preference);
		assert.deepEqual(saved.scope, { kind: "project", id: project.id });
		assert.equal(saved.source.sessionId, source.id);
		assert.equal(saved.source.turn, 2, "The new save belongs to the current turn, not the historical refusal");

		await manager.newSession("Reader", project.id);
		const reader = manager.current.id;
		assert.equal(manager.history.length, 0);
		assert.equal(await manager.run(question), preference);
		assert.ok(!manager.history.some((message) => message.content === oldRefusal));
		assert.equal(rawTools.length, 1, "Same-directory selection reuses only raw workspace tools");

		const freshFactory = workspaceAgentFactory(config, buildTools, transport);
		const restored = await SessionManager.open(await freshFactory(workspace), {
			workspace, store: new SessionStore({ root: store.root }), selection: { resume: reader }, agentForWorkspace: freshFactory,
		});
		assert.equal(await restored.run(question), preference);
		assert.equal((await restored.listMemories())[0]!.id, saved.id);
		await restored.newSession("Other reader", other.id);
		const beforeOther = requests.length;
		assert.equal(await restored.run(question), "No current dog preference.");
		assert.equal(requests.length, beforeOther + 1);
		assert.deepEqual(currentNotice(requests.at(-1)!), { manifest: [], contents: [] });
		assert.ok(!JSON.stringify(requests.at(-1)!.messages).includes(preference));
		assert.deepEqual(await restored.listMemories(), []);

		assert.equal(approvals, 0, "Memory metadata updates must not ask for workspace file-write approval");
		assert.deepEqual(policy.snapshot(), initialPermissions);
		for (const tools of rawTools) {
			assert.deepEqual(tools.getWrites!(), []);
			const properties = tools.definitions.find((tool) => tool.function.name === "write")!.function.parameters!.properties as Record<string, unknown>;
			assert.equal(properties.memoryEvidence, undefined, "Session decoration must not contaminate the raw workspace cache");
		}
	});
}
