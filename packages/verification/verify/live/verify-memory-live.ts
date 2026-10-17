import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { HarnessError, checkCancellation } from "@fatcat/runtime/errors";
import type { LoopEvent } from "@fatcat/runtime/loop";
import type { Message } from "@fatcat/runtime/model";
import { SessionManager } from "@fatcat/runtime/session/manager";
import { SessionStore } from "@fatcat/runtime/session/store";
import { systemPrompt } from "@fatcat/runtime/internal/system-prompt";
import { createTools } from "@fatcat/runtime/tools";
import type { Tools } from "@fatcat/runtime/tools";
import { workspaceAgentFactory } from "@fatcat/runtime/agent";
import { loadLiveConfig } from "../support/live-config.js";

// Real DeepSeek decisions over fixed synthetic data, including a saved obsolete refusal.
const maxRequests = 16;
const temporaryRoot = await realpath(tmpdir());
const networkFetch = globalThis.fetch;
const remember = "\u4f60\u8bb0\u4f4f\u72d7\u72d7\u6700\u559c\u6b22\u73a9CSGO\uff0c\u542c\u89c1\u6ca1\uff1f";
const question = "\u72d7\u72d7\u6700\u559c\u6b22\u73a9\u4ec0\u4e48\u6e38\u620f\uff1f";
const oldRefusal = "I cannot save long-term memory; use /memory.";
let base: string | undefined;
let stage = "configuration";
let requests = 0;
let usageResponses = 0;
let unknownUsageResponses = 0;
let promptTokens = 0;
let completionTokens = 0;
let successfulWrites = 0;
let captureAnswerMentionsHostCommand = false;
const observations: { stage: string; memoryNotice: boolean; memoryWriteSchema: boolean; factInCurrentContext: boolean; oldRefusalInHistory: boolean }[] = [];

function observe(event: LoopEvent): void {
	if (event.type === "subagent_event") { observe(event.event); return; }
	if (event.type === "tool_result" && event.tool === "write" && event.ok) successfulWrites++;
	if (event.type !== "model_usage") return;
	if (!event.usage) { unknownUsageResponses++; return; }
	usageResponses++;
	promptTokens += event.usage.promptTokens;
	completionTokens += event.usage.completionTokens;
}

function summary(passed: boolean) {
	return { scenario: "memory_live", stage, passed, requests, requestLimit: maxRequests, successfulWrites,
		captureAnswerMentionsHostCommand,
		usage: { responses: usageResponses, unknownResponses: unknownUsageResponses, promptTokens, completionTokens,
			totalTokens: promptTokens + completionTokens }, observations };
}

try {
	const selected = loadLiveConfig();
	const config = { ...selected, maxIterations: 4, requestTimeoutMs: 20_000, autoCompaction: false };
	const overall = AbortSignal.timeout(120_000);
	const transport: typeof fetch = async (input, init) => {
		checkCancellation(overall);
		if (requests >= maxRequests) throw new HarnessError("LIVE_REQUEST_LIMIT", "The fixed live Memory request allowance is exhausted.");
		const request = new Request(input, init);
		const body = await request.clone().json() as { messages: Message[]; tools?: { function: { name: string; parameters?: { properties?: Record<string, unknown> } } }[] };
		const system = String(body.messages[0]?.content);
		const noticeLine = system.split("\n").find((line) => line.startsWith('{"manifest":'));
		const notice = noticeLine ? JSON.parse(noticeLine) as { contents: { content: string }[] } : undefined;
		observations.push({ stage, memoryNotice: Boolean(notice),
			memoryWriteSchema: Boolean(body.tools?.find((tool) => tool.function.name === "write")?.function.parameters?.properties?.memoryEvidence),
			factInCurrentContext: Boolean(notice?.contents.some((entry) => /CSGO/i.test(entry.content))),
			oldRefusalInHistory: body.messages.some((message) => message.role === "assistant" && message.content === oldRefusal) });
		requests++;
		return networkFetch(request, { signal: AbortSignal.any([request.signal, overall]) });
	};

	base = await mkdtemp(join(temporaryRoot, "fatcat-memory-live-"));
	const workspace = join(base, "project-p");
	const otherWorkspace = join(base, "project-q");
	await mkdir(workspace);
	await mkdir(otherWorkspace);
	const workspaceTools: Tools[] = [];
	const buildTools = async (root: string) => {
		const tools = await createTools(root, "read-only", undefined, { permission: "deny" }, { permission: "deny" });
		workspaceTools.push(tools);
		return tools;
	};
	const productionFactory = workspaceAgentFactory(config, buildTools, transport);
	const factory = async (root: string) => {
		const agent = await productionFactory(root);
		if (agent.skills.skills.some((skill) => skill.scope === "user")) {
			throw new HarnessError("LIVE_SKILL_SCOPE", "Synthetic live Memory verification excludes user-scoped Skills.");
		}
		return agent;
	};
	const store = new SessionStore({ root: join(base, "sessions") });
	const manager = await SessionManager.open(await factory(workspace), { workspace, store, agentForWorkspace: factory });
	const project = await manager.createProject("Synthetic Memory P", workspace);
	await manager.newSession("Synthetic source A", project.id);
	const sourceId = manager.current.id;
	const source = await store.loadAny(sourceId);
	await store.save({ ...source, history: [
		{ role: "system", content: systemPrompt },
		{ role: "user", content: remember },
		{ role: "assistant", content: oldRefusal },
	] }, source.revision);
	await manager.resume(sourceId);
	assert.deepEqual(await manager.listMemories(), []);

	stage = "capture_after_old_refusal";
	captureAnswerMentionsHostCommand = (await manager.run(remember, { signal: overall, onEvent: observe })).includes("/memory");
	const records = await manager.listMemories(overall);
	const memory = records.find((record) => record.status === "active" && /CSGO/i.test(record.content));
	assert.ok(memory, "The real model must persist the directly requested preference despite the historical refusal.");
	assert.deepEqual(memory.scope, { kind: "project", id: project.id });
	assert.equal(memory.source.sessionId, sourceId);
	assert.equal(memory.source.request, remember);
	assert.equal(memory.source.turn, 2);
	assert.ok(memory.source.evidence && remember.includes(memory.source.evidence));
	assert.ok(successfulWrites > 0);
	assert.ok(observations.some((observation) => observation.oldRefusalInHistory && observation.memoryWriteSchema));

	stage = "independent_project_reader";
	await manager.newSession("Synthetic reader B", project.id);
	const readerId = manager.current.id;
	assert.deepEqual(manager.history, []);
	assert.equal((await manager.listMemories()).find((record) => record.id === memory.id)!.revision, memory.revision);
	assert.match(await manager.run(question, { signal: overall, onEvent: observe }), /CSGO/i);
	assert.ok(observations.some((observation) => observation.stage === stage && observation.factInCurrentContext));
	const current = (await manager.listMemories()).find((record) => record.id === memory.id)!;
	assert.deepEqual(current, memory);

	stage = "restarted_project_reader";
	const restartedProductionFactory = workspaceAgentFactory(config, buildTools, transport);
	const restartedFactory = async (root: string) => {
		const agent = await restartedProductionFactory(root);
		if (agent.skills.skills.some((skill) => skill.scope === "user")) {
			throw new HarnessError("LIVE_SKILL_SCOPE", "Synthetic live Memory verification excludes user-scoped Skills.");
		}
		return agent;
	};
	const restored = await SessionManager.open(await restartedFactory(workspace), { workspace, store: new SessionStore({ root: store.root }),
		selection: { resume: readerId }, agentForWorkspace: restartedFactory });
	assert.deepEqual((await restored.listMemories()).find((record) => record.id === memory.id), memory);
	assert.match(await restored.run(question, { signal: overall, onEvent: observe }), /CSGO/i);

	stage = "other_project_isolation";
	const other = await restored.createProject("Synthetic Memory Q", otherWorkspace);
	await restored.newSession("Synthetic isolated reader", other.id);
	assert.deepEqual(restored.history, []);
	assert.deepEqual(await restored.listMemories(), []);
	assert.doesNotMatch(await restored.run(question, { signal: overall, onEvent: observe }), /CSGO/i);
	assert.ok(observations.filter((observation) => observation.stage === stage).every((observation) => !observation.factInCurrentContext));
	for (const tools of workspaceTools) {
		assert.deepEqual(tools.getWrites!(), []);
		assert.deepEqual(tools.getCommands!(), []);
	}
	assert.ok(requests <= maxRequests);
	stage = "complete";
	console.log(JSON.stringify(summary(true)));
} catch (error) {
	console.error(JSON.stringify({ ...summary(false), code: error instanceof HarnessError ? error.code : "ASSERTION" }));
	process.exitCode = 1;
} finally {
	if (base) {
		const target = resolve(base);
		if (dirname(target) !== temporaryRoot || !basename(target).startsWith("fatcat-memory-live-")) throw new Error("Refusing to remove an unexpected live Memory fixture directory.");
		await rm(target, { recursive: true, force: true });
	}
}
