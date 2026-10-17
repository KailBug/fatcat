import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, it } from "node:test";
import { createAgent, workspaceAgentFactory } from "@fatcat/runtime/agent";
import { loadConfig } from "@fatcat/runtime/config";
import type { Message, Model } from "@fatcat/runtime/model";
import type { SessionAgentOptions } from "@fatcat/runtime/session/agent-session";
import { createTools } from "@fatcat/runtime/tools";
import { temporaryWorkspace } from "../support/workspace.js";

const config = loadConfig({ DEEPSEEK_API_KEY: "offline-agent-assembly" });
const noTransport: typeof fetch = async () => { throw new Error("Assembly must not contact a model"); };

describe("workspaceAgentFactory", () => {
	it("workspace selection reuses raw tools and journals while refreshing skill metadata and agent models", async (t) => {
		const { workspace, outside } = await temporaryWorkspace(t);
		const directory = join(workspace, ".agents", "skills", "assembly-fixture");
		await mkdir(directory, { recursive: true });
		const skill = (description: string) => `---\nname: assembly-fixture\ndescription: ${description}\n---\nRead the fixture.\n`;
		await writeFile(join(directory, "SKILL.md"), skill("Original description"));
		const built: string[] = [];
		const factory = workspaceAgentFactory(config, async (root) => {
			built.push(root);
			return createTools(root, "workspace-write");
		}, noTransport);
		const first = await factory(workspace);
		assert.equal((await first.tools.execute("write", JSON.stringify({ path: "fixture.txt", content: "Preserved" }))).ok, true);
		await writeFile(join(directory, "SKILL.md"), skill("Updated description"));
		const next = await factory(relative(process.cwd(), workspace));
		assert.deepEqual(built, [await realpath(workspace)]);
		assert.notEqual(next.model, first.model);
		assert.equal(first.skills.skills.find((item) => item.name === "assembly-fixture")?.description, "Original description");
		assert.equal(next.skills.skills.find((item) => item.name === "assembly-fixture")?.description, "Updated description");
		assert.deepEqual(next.tools.getWrites!(), first.tools.getWrites!());
		assert.equal(next.tools.getWrites!().length, 1);
		assert.deepEqual((await factory(outside)).tools.getWrites!(), []);
		assert.equal(built.length, 2);
	});

	it("workspace tool construction failures remain retryable and do not populate the cache", async (t) => {
		const { workspace } = await temporaryWorkspace(t);
		const failure = new Error("Tool preparation failed");
		let attempts = 0;
		const factory = workspaceAgentFactory(config, async (root) => {
			if (++attempts === 1) throw failure;
			return createTools(root);
		}, noTransport);
		await assert.rejects(factory(workspace), (error) => error === failure);
		assert.equal((await factory(workspace)).tools.workspaceRoot, await realpath(workspace));
		await factory(workspace);
		assert.equal(attempts, 2);
	});
});

describe("createAgent session binding", () => {
	it("session binding preserves caller overrides and forwards model arguments without changing history", async (t) => {
		const { workspace } = await temporaryWorkspace(t);
		const agent = createAgent(config, undefined, noTransport);
		const customTools = await createTools(workspace);
		const requests: Parameters<Model>[] = [];
		const customModel: Model = async (...args) => {
			requests.push(args);
			return { message: { role: "assistant", content: "Custom answer" }, toolCalls: [] };
		};
		const current: SessionAgentOptions = { ...agent, tools: customTools, model: customModel,
			maxIterations: 7, maxRequestBytes: 12345, autoCompaction: false, compactionModel: customModel };
		const signal = new AbortController().signal;
		const observe = () => {};
		const options = { toolChoice: "none" as const };
		const history: Message[] = [{ role: "system", content: "Original instructions" }, { role: "user", content: "Hello" }];
		const before = structuredClone(history);
		for (const sessionId of ["first-session", "second-session"]) {
			const scope = { sessionId, locationRevision: 0, workspace };
			let memoryReads = 0;
			const bound = agent.forSession(scope, current, undefined, { list: async (received) => {
				assert.equal(received, signal);
				memoryReads++;
				return [];
			} });
			assert.equal(bound.tools, customTools);
			assert.equal(bound.maxIterations, 7);
			assert.equal(bound.maxRequestBytes, 12345);
			assert.equal(bound.autoCompaction, false);
			assert.equal(bound.compactionModel, customModel);
			await bound.model(history, signal, observe, options);
			assert.equal(memoryReads, 1);
			const request = requests.at(-1)!;
			const system = String(request[0][0]?.content);
			assert.equal(system.split("Actual executing session").length - 1, 1);
			assert.ok(system.includes(JSON.stringify(scope)));
			assert.equal(request[1], signal);
			assert.equal(request[2], observe);
			assert.equal(request[3], options);
			assert.deepEqual(history, before);
		}
		assert.equal(current.model, customModel);
	});
});
