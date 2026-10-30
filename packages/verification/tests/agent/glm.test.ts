import { fixtureTools } from "../support/tool-fixture.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAgent } from "@fatcat/runtime/agent";
import { loadConfig } from "@fatcat/runtime/config";
import { runAgent } from "@fatcat/runtime/loop";
import { defaultModelSelection } from "@fatcat/runtime/model-catalog";
import { ModelConnections } from "@fatcat/runtime/model-connections";
import { defaultTools } from "@fatcat/runtime/tools";
import type { ChatMessage, ChatRequest } from "../support/chat-protocol.js";

const config = loadConfig({ DEEPSEEK_API_KEY: "offline-startup", HARNESS_MAX_ITERATIONS: "3" });
const connections = new ModelConnections(config, { GLM_API_KEY: "offline-glm-agent" });

function answer(content: string) {
	return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] });
}

function call(name: string, args: unknown) {
	return Response.json({ choices: [{ finish_reason: "tool_calls", message: {
		role: "assistant", content: null, reasoning_content: "Original delegation reasoning\n\u4e2d\u6587",
		tool_calls: [{ id: "glm-tool", type: "function", function: { name, arguments: JSON.stringify(args) } }],
	} }] });
}

describe("GLM agent assembly and execution boundaries", () => {
	for (const model of ["glm-5.3", "glm-5.2", "glm-5.1", "glm-5", "glm-4.7"]) {
		it(`${model}: rebinds parent, child and compaction requests from the startup provider`, async () => {
			const selection = defaultModelSelection("glm", "cn", model);
			let requests = 0;
			const base = createAgent(config, fixtureTools, async (input, init) => {
				const request = new Request(input, init);
				assert.equal(request.url, "https://open.bigmodel.cn/api/paas/v4/chat/completions");
				assert.equal(request.headers.get("authorization"), "Bearer offline-glm-agent");
				const body = await request.json() as ChatRequest;
				const auxiliary = ++requests === 4;
				const enabled = !auxiliary || model === "glm-5.3";
				assert.equal(body.model, model);
				assert.deepEqual(body.thinking, enabled ? { type: "enabled", clear_thinking: false } : { type: "disabled" });
				assert.equal(body.reasoning_effort, enabled && (model === "glm-5.3" || model === "glm-5.2") ? "max" : undefined);
				assert.equal(body.max_tokens, enabled ? 16384 : 2048);
				if (auxiliary) {
					assert.equal(body.tools, undefined);
					assert.equal(body.tool_choice, undefined);
					return answer("Compact summary");
				}
				assert.equal(body.tool_choice, "auto");
				const names = body.tools!.map((tool) => tool.function.name);
				if (requests === 2) {
					assert.deepEqual(names, ["fixture_add"]);
					assert.ok(!JSON.stringify(body.messages).includes("Parent-only detail"));
					return answer("Child result");
				}
				assert.ok(names.includes("delegate_task"));
				if (requests === 1) return call("delegate_task", { task: "Reply with a child result" });
				assert.equal(requests, 3);
				const replay = body.messages.find((message) => message.role === "assistant") as ChatMessage & { reasoning_content?: string };
				assert.equal(replay.reasoning_content, "Original delegation reasoning\n\u4e2d\u6587");
				assert.equal(body.messages.at(-1)?.tool_call_id, "glm-tool");
				assert.match(String(body.messages.at(-1)?.content), /Child result/);
				return answer("Reviewed result");
			}, undefined, undefined, undefined, undefined, connections);
			const bound = base.forModel(selection, base);
			assert.deepEqual(bound.modelSelection, selection);
			assert.equal(await runAgent("Parent-only detail", bound), "Reviewed result");
			assert.equal(requests, 3);
			const summary = await bound.compactionModel!([{ role: "user", content: "Summarize the fixture" }],
				undefined, undefined, { purpose: "compaction", toolChoice: "none" });
			assert.equal(summary.message.content, "Compact summary");
			assert.equal(requests, 4);
		});

		it(`${model}: refuses an unexpected tool call on the final request`, async () => {
			let requests = 0;
			let executions = 0;
			const tools = { ...defaultTools, execute: async (...args: Parameters<typeof defaultTools.execute>) => {
				executions++;
				return defaultTools.execute(...args);
			} };
			const base = createAgent({ ...config, maxIterations: 1 }, tools, async (input, init) => {
				requests++;
				const body = await new Request(input, init).json() as ChatRequest;
				assert.equal(body.model, model);
				assert.equal(body.tools, undefined);
				assert.equal(body.tool_choice, undefined);
				return call("fixture_add", { numbers: [1, 2] });
			}, undefined, undefined, undefined, undefined, connections);
			const bound = base.forModel(defaultModelSelection("glm", "cn", model), base);
			await assert.rejects(runAgent("Compute a sum", bound), { code: "MAX_ITERATIONS" });
			assert.equal(requests, 1);
			assert.equal(executions, 0);
		});
	}
});
