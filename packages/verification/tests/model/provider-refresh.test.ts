import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "@fatcat/runtime/config";
import { defaultModelSelection, decodeModelSelection, getModelDescriptor, validateModelSelection } from "@fatcat/runtime/model-catalog";
import { ModelConnections } from "@fatcat/runtime/model-connections";
import { createModel } from "@fatcat/runtime/model";
import { resolveModelProtocol } from "@fatcat/runtime/model-protocol";
import { providerEndpoint } from "@fatcat/runtime/providers";
import { contextHeadroom } from "@fatcat/runtime/context/usage";

const messages = [{ role: "user" as const, content: "Offline contract" }];
const response = () => Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Done" } }] });

describe("current provider protocol contracts", () => {
	it("retains local medium and ultra choices but sends canonical DeepSeek efforts", () => {
		for (const [thinking, wire] of [["medium", "high"], ["ultra", "max"]] as const) {
			const selection = { ...defaultModelSelection("deepseek"), thinking };
			assert.equal(decodeModelSelection(selection).thinking, thinking);
			assert.equal(getModelDescriptor("deepseek", selection.model).thinkingAliases?.[thinking], wire);
			assert.equal(resolveModelProtocol(selection).generation.reasoning_effort, wire);
			assert.equal(resolveModelProtocol(selection).outputReservationTokens, 16384);
		}
	});

	it("uses Qwen native efforts, explicit aliases and an inclusive generation budget", () => {
		const plus = defaultModelSelection("qwen", "cn", "qwen3.7-plus");
		assert.deepEqual(resolveModelProtocol({ ...plus, thinking: "on" }).generation,
			{ enable_thinking: true, preserve_thinking: true, max_completion_tokens: 16384 });
		for (const model of ["qwen3.8-max", "qwen3.8-flash"]) {
			const selection = defaultModelSelection("qwen", "cn", model);
			for (const thinking of ["low", "medium", "high", "xhigh", "max"] as const) {
				const protocol = resolveModelProtocol({ ...selection, thinking });
				assert.deepEqual(protocol.generation, { enable_thinking: true, preserve_thinking: true,
					max_completion_tokens: 16384, reasoning_effort: thinking === "high" || thinking === "max" ? "xhigh" : thinking });
				assert.equal(protocol.outputReservationTokens, 16384);
				assert.equal(protocol.reasoningHistory, "all");
				const headroom = contextHeadroom({ kind: "estimated", selection: { ...selection, thinking },
					contextRevision: 1, status: "ready", inputTokens: 1000, measuredAt: "2026-10-19T00:00:00Z",
					method: "fixture", approximate: false, limitations: [] });
				assert.equal(headroom.inputHeadroom.tokens, 982616);
			}
			assert.throws(() => validateModelSelection({ ...selection, thinking: "ultra" }), { code: "MODEL_SELECTION" });
		}
	});

	it("keeps mandatory Kimi reasoning in main and auxiliary requests", async () => {
		const config = loadConfig({ HARNESS_PROVIDER: "kimi", MOONSHOT_API_KEY: "offline-key" });
		const connections = new ModelConnections(config);
		for (const model of ["kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed"]) {
			const selection = defaultModelSelection("kimi", "cn", model);
			assert.throws(() => validateModelSelection({ ...selection, thinking: "off" }), { code: "MODEL_SELECTION" });
			assert.equal(connections.list().find((item) => item.selection.model === model)?.available, true);
			assert.deepEqual(connections.resolve(selection).selection, selection);
			let calls = 0;
			const client = createModel({ ...config, model }, async (input, init) => {
				calls++;
				const body = await new Request(input, init).json() as Record<string, unknown>;
				assert.equal(body.max_completion_tokens, 16384);
				assert.equal(body.tools === undefined, calls === 2);
				if (model === "kimi-k3") {
					assert.equal(body.reasoning_effort, "max");
					assert.equal(body.thinking, undefined);
				} else assert.deepEqual(body.thinking, { type: "enabled", keep: "all" });
				return response();
			});
			const turn = await client(messages);
			assert.deepEqual(turn.message.providerReplay?.selection, selection);
			assert.equal(calls, 1);
			await client(messages, undefined, undefined, { toolChoice: "none", purpose: "document" });
			assert.equal(calls, 2);
		}
	});

	it("keeps exact snapshot identities and retirement metadata without guessing aliases", () => {
		assert.equal(getModelDescriptor("qwen", "qwen3.7-plus-2026-05-26").protocol, "qwen-toggle");
		assert.equal(getModelDescriptor("qwen", "qwen3.8-max-0902").model, "qwen3.8-max-0902");
		assert.equal(getModelDescriptor("qwen", "qwen3.8-max-invented").known, false);
		assert.equal(getModelDescriptor("mimo", "mimo-v2.5-pro").retirementAt, "2026-10-21T10:00:00+08:00");
		assert.equal(getModelDescriptor("kimi", "kimi-k3").contextWindowTokens, null);
		assert.equal(getModelDescriptor("mimo", "mimo-v2.5-pro").imageInput, false);
	});
});

describe("Qwen PAYG workspace endpoints", () => {
	const regions = { cn: "cn-beijing", intl: "ap-southeast-1", us: "us-east-1", eu: "eu-central-1",
		jp: "ap-northeast-1", hk: "cn-hongkong" } as const;
	for (const [region, host] of Object.entries(regions)) {
		it(`sends current model settings and credentials only to the selected ${region} workspace`, async () => {
			const config = loadConfig({ HARNESS_PROVIDER: "qwen", DASHSCOPE_API_KEY: "offline-key",
				QWEN_MODEL: "qwen3.8-flash", QWEN_REGION: region, QWEN_WORKSPACE_ID: " offline-workspace " });
			const connections = new ModelConnections(config);
			const selection = defaultModelSelection(config.provider, config.region, config.model, config.workspaceId);
			assert.equal(connections.resolve(selection).apiKey, "offline-key");
			assert.throws(() => connections.resolve({ ...selection, workspaceId: "different-workspace" }), { code: "MODEL_UNAVAILABLE" });
			assert.ok(!JSON.stringify(connections.list()).includes("offline-key"));
			await createModel(config, async (input, init) => {
				const request = new Request(input, init);
				assert.equal(request.url, `https://offline-workspace.${host}.maas.aliyuncs.com/compatible-mode/v1/chat/completions`);
				assert.equal(request.headers.get("authorization"), "Bearer offline-key");
				const body = await request.json() as Record<string, unknown>;
				assert.equal(body.model, "qwen3.8-flash");
				assert.equal(body.enable_thinking, true);
				assert.equal(body.preserve_thinking, true);
				assert.equal(body.reasoning_effort, "medium");
				assert.equal(body.max_completion_tokens, 16384);
				assert.equal(body.max_tokens, undefined);
				assert.equal(body.workspaceId, undefined);
				return response();
			})(messages);
		});
	}
	it("rejects host injection and missing workspace IDs without credential or region fallback", () => {
		for (const workspaceId of ["", "a.b", "a/b", "a@b", "a?b", "a#b", "a\nb", "a".repeat(64), "-a", "a-"]) {
			assert.throws(() => providerEndpoint("qwen", "cn", workspaceId), { code: "CONFIG" });
		}
		assert.throws(() => providerEndpoint("deepseek", "global", "workspace"), { code: "CONFIG" });
		assert.throws(() => providerEndpoint("qwen", "__proto__", "workspace"), { code: "CONFIG" });
		for (const region of ["us", "eu", "jp", "hk"]) assert.throws(() => providerEndpoint("qwen", region), { code: "CONFIG" });
		assert.equal(providerEndpoint("qwen", "cn"), "https://dashscope.aliyuncs.com/compatible-mode/v1");
		assert.equal(providerEndpoint("qwen", "intl"), "https://dashscope-intl.aliyuncs.com/compatible-mode/v1");
		const config = loadConfig({ DEEPSEEK_API_KEY: "offline-key", QWEN_WORKSPACE_ID: "invalid.domain" });
		assert.equal(config.workspaceId, undefined);
		assert.equal(new ModelConnections(config, { QWEN_WORKSPACE_ID: "invalid.domain" }).list()
			.find((item) => item.selection.provider === "qwen")?.available, false);
	});
});
