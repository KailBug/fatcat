import { fixtureTools } from "../support/tool-fixture.js";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "@fatcat/runtime/config";
import { defaultModelSelection, getModelDescriptor, listModelDescriptors, validateModelSelection } from "@fatcat/runtime/model-catalog";
import { ModelConnections } from "@fatcat/runtime/model-connections";
import { createModel } from "@fatcat/runtime/model";
import type { Message } from "@fatcat/runtime/model-types";
import { resolveModelProtocol } from "@fatcat/runtime/model-protocol";
import { providerEndpoint } from "@fatcat/runtime/providers";
import { contextHeadroom } from "@fatcat/runtime/context/usage";
import { estimateRequest } from "@fatcat/runtime/internal/context/estimate";

const config = loadConfig({ HARNESS_PROVIDER: "glm", GLM_API_KEY: "offline-glm" });
const messages: Message[] = [{ role: "user", content: "Add one and two" }];
const reply = { role: "assistant", content: "3", reasoning_content: "Original reasoning\n\u4e2d\u6587" };
const response = () => Response.json({ choices: [{ finish_reason: "stop", message: reply }] });

describe("GLM domestic standard API", () => {
	it("resolves only domestic credentials and exposes independent catalog choices without keys", () => {
		const base = loadConfig({ DEEPSEEK_API_KEY: "offline-startup" });
		const connections = new ModelConnections(base, { GLM_API_KEY: config.apiKey });
		const selection = defaultModelSelection("glm");
		assert.deepEqual(selection, { provider: "glm", region: "cn", model: "glm-5.3", thinking: "max" });
		assert.deepEqual(connections.resolve(selection), { selection, apiKey: config.apiKey });
		assert.ok(connections.list().filter((choice) => choice.selection.provider === "glm").every((choice) => choice.available));
		assert.ok(!JSON.stringify({ connections, choices: connections.list() }).includes("offline-"));
		assert.throws(() => new ModelConnections(base, { OPENAI_API_KEY: "ambient", ZAI_API_KEY: "foreign" }).resolve(selection),
			{ code: "MODEL_UNAVAILABLE" });
		for (const region of ["global", "intl", "__proto__", "https://untrusted.invalid"]) {
			assert.throws(() => providerEndpoint("glm", region), { code: "CONFIG" });
		}
		assert.throws(() => providerEndpoint("glm", "cn", "workspace"), { code: "CONFIG" });
	});

	it("validates exact model thinking options and source-backed context windows", () => {
		for (const [model, capacity] of [["glm-5.3", 1_048_576], ["glm-5.2", 1_048_576],
			["glm-5.1", 202_752], ["glm-5", 202_752], ["glm-4.7", 202_752]] as const) {
			assert.equal(getModelDescriptor("glm", model).known, true);
			assert.equal(getModelDescriptor("glm", model).contextWindowTokens, capacity);
			assert.equal(getModelDescriptor("glm", model).inputLimitTokens, null);
			assert.equal(getModelDescriptor("glm", model).imageInput, false);
		}
		assert.deepEqual(getModelDescriptor("glm", "glm-5.3").thinkingOptions, ["low", "high", "max"]);
		assert.deepEqual(getModelDescriptor("glm", "glm-5.2").thinkingOptions, ["off", "high", "max"]);
		assert.equal(defaultModelSelection("glm", "cn", "glm-5.1").thinking, "on");
		for (const thinking of ["off", "on", "medium", "xhigh", "ultra"]) {
			assert.throws(() => validateModelSelection({ ...defaultModelSelection("glm"), thinking }), { code: "MODEL_SELECTION" });
		}
		const unknown = defaultModelSelection("glm", "cn", "glm-5.3-custom");
		assert.equal(unknown.thinking, "off");
		assert.equal(getModelDescriptor("glm", unknown.model).known, false);
		assert.equal(getModelDescriptor("glm", unknown.model).contextWindowTokens, null);
		assert.equal(resolveModelProtocol(unknown).outputReservationTokens, null);
		assert.throws(() => validateModelSelection({ ...unknown, thinking: "max" }), { code: "MODEL_SELECTION" });
	});

	it("subtracts shared output once and preserves negative headroom at the context boundary", () => {
		for (const descriptor of listModelDescriptors("glm")) {
			const capacity = descriptor.contextWindowTokens!;
			for (const thinking of descriptor.thinkingOptions) {
				const reservation = thinking === "off" ? 2048 : 16384;
				for (const headroom of [1, 0, -1]) {
					const result = contextHeadroom({ kind: "estimated", status: "ready", contextRevision: 1,
						selection: { ...defaultModelSelection("glm", "cn", descriptor.model), thinking },
						inputTokens: capacity - reservation - headroom, measuredAt: "2026-10-26T00:00:00Z",
						method: "injected-exact-counter", approximate: false, limitations: [] });
					assert.equal(result.windowCapacityTokens, capacity);
					assert.deepEqual(result.windowRemaining, { tokens: reservation + headroom, status: "reference" });
					assert.deepEqual(result.inputHeadroom, { tokens: headroom, status: "estimated" });
				}
			}
		}
	});

	it("shows known capacity without inventing a GLM token count or borrowing a foreign tokenizer", async () => {
		const model = createModel(config, async () => { throw new Error("Preview must not send requests"); });
		const prepared = await model.prepare!(messages);
		let counts = 0;
		const estimate = await estimateRequest(prepared, 1, {
			supports: (selection) => selection.provider === "deepseek",
			count: async () => { counts++; throw new Error("A foreign counter must not run"); },
		});
		assert.equal(counts, 0);
		assert.equal(estimate.status, "unknown");
		const result = contextHeadroom(estimate);
		assert.equal(result.windowCapacityTokens, 1_048_576);
		assert.equal(result.windowRemaining.status, "unknown");
		assert.equal(result.inputHeadroom.status, "unknown");
	});

	for (const descriptor of listModelDescriptors("glm")) {
		it(`${descriptor.model}: sends supported thinking fields, exact preview bytes and bounded auxiliary requests`, async () => {
			for (const thinking of descriptor.thinkingOptions) {
				const selection = { ...defaultModelSelection("glm", "cn", descriptor.model), thinking };
				for (const purpose of [undefined, "compaction", "document"] as const) {
					const enabled = thinking !== "off" && (!purpose || !descriptor.thinkingOptions.includes("off"));
					const cap = enabled ? 16384 : 2048;
					const protocol = resolveModelProtocol(selection, purpose);
					assert.equal(protocol.outputReservationTokens, cap);
					assert.equal(protocol.reasoningHistory, enabled ? "all" : "none");
					let sent = "";
					const client = createModel({ ...config, ...selection }, async (input, init) => {
						const request = new Request(input, init);
						assert.equal(request.url, "https://open.bigmodel.cn/api/paas/v4/chat/completions");
						assert.equal(request.headers.get("authorization"), "Bearer offline-glm");
						sent = await request.text();
						const body = JSON.parse(sent);
						assert.equal(body.model, descriptor.model);
						assert.equal(body.stream, false);
						assert.deepEqual(body.thinking, enabled ? { type: "enabled", clear_thinking: false } : { type: "disabled" });
						assert.equal(body.max_tokens, cap);
						assert.equal(body.max_completion_tokens, undefined);
						assert.equal(body.reasoning_effort, enabled && descriptor.protocol === "glm-effort" ? thinking : undefined);
						assert.equal(body.tool_choice, purpose ? undefined : "auto");
						assert.equal(body.tools === undefined, !!purpose);
						return response();
					}, fixtureTools);
					const options = purpose ? { purpose, toolChoice: "none" as const } : undefined;
					const preview = await client.prepare!(messages, undefined, options);
					const turn = await client(messages, undefined, undefined, options);
					assert.equal(preview.json, sent);
					assert.equal(preview.bytes, Buffer.byteLength(sent));
					assert.equal(turn.message.providerReplay !== undefined, enabled && !purpose);
				}
			}
		});
	}

	it("retains original reasoning only for the same thinking model, including final text without tools", async () => {
		const first = await createModel({ ...config, model: "glm-5.1" }, async () => response())(messages);
		const history: Message[] = [...messages, first.message, { role: "user", content: "Continue" }];
		for (const [model, thinking, replay] of [["glm-5.1", "on", true], ["glm-5.1", "off", false],
			["glm-5.3", "max", false]] as const) {
			await createModel({ ...config, model, thinking }, async (input, init) => {
				const body = await new Request(input, init).json() as { messages: Record<string, unknown>[]; tools?: unknown; tool_choice?: unknown };
				assert.equal(body.tools, undefined);
				assert.equal(body.tool_choice, undefined);
				assert.deepEqual(body.messages[1], replay ? reply : { role: "assistant", content: "3" });
				return response();
			})(history, undefined, undefined, { toolChoice: "none" });
		}
	});
});
