import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "@fatcat/runtime/config";
import { defaultModelSelection, decodeModelSelection, getModelDescriptor, listModelDescriptors,
	validateModelSelection } from "@fatcat/runtime/model-catalog";
import { ModelConnections } from "@fatcat/runtime/model-connections";
import { resolveModelProtocol } from "@fatcat/runtime/model-protocol";
import { contextHeadroom } from "@fatcat/runtime/context/usage";
import type { ContextEstimate } from "@fatcat/runtime/context/usage";

describe("model capability and protocol contracts", () => {
	it("uses exact identities and does not infer capabilities for aliases or foreign providers", () => {
		assert.equal(getModelDescriptor("deepseek", "deepseek-flash").contextWindowTokens, 1_048_576);
		for (const [provider, model] of [["deepseek", "deepseek-flash-custom"], ["qwen", "deepseek-flash"]] as const) {
			const descriptor = getModelDescriptor(provider, model);
			assert.equal(descriptor.known, false);
			assert.equal(descriptor.contextWindowTokens, null);
			assert.equal(descriptor.imageInput, false);
			assert.deepEqual(descriptor.thinkingOptions, ["off"]);
		}
		const descriptor = getModelDescriptor("qwen", "qwen-plus");
		descriptor.inputLimitTokens!.off = 1;
		assert.equal(getModelDescriptor("qwen", "qwen-plus").inputLimitTokens!.off, 997_952);
		assert.equal(new Set(listModelDescriptors("mimo").map((item) => item.model)).size, 5);
	});

	it("validates untrusted selections and separates saved identity from current supported options", () => {
		const selection = defaultModelSelection("kimi");
		assert.deepEqual(validateModelSelection({ ...selection, thinking: "on" }), { ...selection, thinking: "on" });
		assert.throws(() => validateModelSelection({ ...selection, thinking: "high" }), { code: "MODEL_SELECTION" });
		assert.equal(decodeModelSelection({ ...selection, thinking: "high" }).thinking, "high");
		for (const patch of [{ model: "" }, { model: " x " }, { model: "x\n" }, { model: "x".repeat(201) },
			{ provider: "__proto__" }, { region: "https://untrusted.invalid" }, { thinking: "extreme" }, { apiKey: "private" }]) {
			assert.throws(() => decodeModelSelection({ ...selection, ...patch }));
		}
		assert.throws(() => decodeModelSelection({ ...selection, provider: "deepseek", region: "cn" }));
	});

	it("maps only real effort levels and accounts for inclusive and separate generation budgets", () => {
		for (const thinking of ["off", "low", "high", "max"] as const) {
			const protocol = resolveModelProtocol({ ...defaultModelSelection("deepseek"), thinking });
			assert.deepEqual(protocol.generation, { thinking: { type: thinking === "off" ? "disabled" : "enabled" },
				max_tokens: thinking === "off" ? 2048 : 16384, ...(thinking === "off" ? {} : { reasoning_effort: thinking }) });
			assert.equal(protocol.outputReservationTokens, thinking === "off" ? 2048 : 16384);
			assert.equal(protocol.reasoningHistory, thinking === "off" ? "none" : "with-tools");
		}
		for (const provider of ["kimi", "mimo"] as const) {
			const protocol = resolveModelProtocol({ ...defaultModelSelection(provider), thinking: "on" });
			assert.deepEqual(protocol.generation, { thinking: { type: "enabled", ...(provider === "kimi" ? { keep: "all" } : {}) },
				max_completion_tokens: 16384 });
			assert.equal(protocol.outputReservationTokens, 16384);
			assert.equal(protocol.reasoningHistory, "all");
		}
		const qwen = resolveModelProtocol({ ...defaultModelSelection("qwen"), thinking: "on" });
		assert.deepEqual(qwen.generation, { enable_thinking: true, max_tokens: 2048, thinking_budget: 8192 });
		assert.equal(qwen.outputReservationTokens, 10240);
		assert.equal(qwen.inputLimitTokens, 995904);
		assert.equal(qwen.reasoningHistory, "none");
		assert.equal(resolveModelProtocol(defaultModelSelection("qwen", "cn", "custom")).outputReservationTokens, null);
	});

	it("keeps auxiliary generation explicit without changing the parent selection", () => {
		for (const provider of ["deepseek", "kimi", "mimo", "qwen"] as const) {
			const selection = { ...defaultModelSelection(provider), thinking: provider === "deepseek" ? "max" as const : "on" as const };
			const before = structuredClone(selection);
			for (const purpose of ["compaction", "document"] as const) {
				const protocol = resolveModelProtocol(selection, purpose);
				assert.equal(protocol.outputReservationTokens, 2048);
				assert.equal(protocol.reasoningHistory, "none");
				assert.equal(protocol.generation.reasoning_effort, undefined);
				assert.equal(protocol.generation.thinking_budget, undefined);
			}
			assert.deepEqual(selection, before);
		}
	});
});

describe("host model connections", () => {
	const base = loadConfig({ DEEPSEEK_API_KEY: "offline-startup" });
	it("exposes availability without serializing credentials or accepting a region fallback", () => {
		const connections = new ModelConnections(base, { MOONSHOT_API_KEY: "offline-kimi", KIMI_REGION: "global",
			KIMI_MODEL: "custom-kimi", OPENAI_API_KEY: "offline-ambient" });
		const list = connections.list();
		assert.equal(list.find((item) => item.selection.model === "custom-kimi")?.available, true);
		assert.equal(list.find((item) => item.selection.provider === "qwen")?.available, false);
		assert.ok(!JSON.stringify({ connections, list }).includes("offline-"));
		const selected = { ...defaultModelSelection("kimi", "global"), thinking: "on" as const };
		assert.deepEqual(connections.resolve(selected), { selection: selected, apiKey: "offline-kimi" });
		assert.equal(base.apiKey, "offline-startup");
		assert.throws(() => connections.resolve(defaultModelSelection("kimi", "cn")), { code: "MODEL_UNAVAILABLE" });
		assert.throws(() => connections.resolve(defaultModelSelection("qwen")), { code: "MODEL_UNAVAILABLE" });
	});

	it("does not fail the selected provider because an unused provider has invalid settings", () => {
		const connections = new ModelConnections(base, { MOONSHOT_API_KEY: "offline-private", KIMI_REGION: "untrusted" });
		assert.equal(connections.resolve(defaultModelSelection("deepseek")).apiKey, "offline-startup");
		assert.equal(connections.list().find((item) => item.selection.provider === "kimi")?.available, false);
		assert.ok(!JSON.stringify(connections.list()).includes("untrusted"));
	});
});

describe("context metric contracts", () => {
	function estimate(provider: "deepseek" | "qwen", inputTokens: number): Extract<ContextEstimate, { status: "ready" }> {
		return { kind: "estimated", selection: defaultModelSelection(provider), contextRevision: 1,
			status: "ready", inputTokens, measuredAt: "2026-10-19T00:00:00.000Z", method: "fixture",
			approximate: false, limitations: [] };
	}
	it("separates window reference from input headroom and preserves overflow", () => {
		const current = estimate("deepseek", 1_048_000);
		const result = contextHeadroom(current);
		assert.deepEqual(result.windowRemaining, { tokens: 576, status: "reference" });
		assert.deepEqual(result.inputHeadroom, { tokens: -1472, status: "estimated" });
		current.selection.thinking = "max";
		assert.equal(contextHeadroom(current).inputHeadroom.tokens, 576 - 16384);
	});

	it("counts Qwen reasoning once and applies its independent input limit", () => {
		const current = estimate("qwen", 1000);
		assert.equal(contextHeadroom(current).inputHeadroom.tokens, 996952);
		current.selection.thinking = "on";
		assert.equal(contextHeadroom(current).inputHeadroom.tokens, 1_000_000 - 2048 - 8192 - 1000);
		assert.equal(contextHeadroom(current).windowRemaining.tokens, 999000);
	});

	it("does not convert missing or invalid counts and unknown models into zero", () => {
		const current = estimate("deepseek", 0);
		assert.equal(contextHeadroom(current).windowRemaining.tokens, 1_048_576);
		for (const inputTokens of [NaN, -1, Infinity, Number.MAX_SAFE_INTEGER + 1, 0.5]) {
			assert.equal(contextHeadroom({ ...current, inputTokens }).windowRemaining.tokens, null);
		}
		const unknown: ContextEstimate = { kind: "estimated", selection: current.selection, contextRevision: 2,
			status: "unknown", inputTokens: null, measuredAt: null, method: null, reason: "No matching tokenizer." };
		assert.equal(contextHeadroom(unknown).inputHeadroom.tokens, null);
		current.selection.model = "custom";
		assert.equal(contextHeadroom(current).windowCapacityTokens, null);
	});
});
