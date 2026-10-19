import { HarnessError } from "./errors.js";
import { getProviderProfile, parseProvider, providerEndpoint } from "./providers.js";
import type { Provider, ProviderRegion } from "./providers.js";

export type ThinkingLevel = "off" | "on" | "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type ModelProtocolKind = "deepseek" | "kimi-toggle" | "kimi-code" | "kimi-k3" | "mimo"
	| "qwen-legacy" | "qwen-toggle" | "qwen-effort";

/** Public model identity; credentials and endpoint URLs never belong in session state. */
export interface ModelSelection {
	provider: Provider;
	region: ProviderRegion;
	workspaceId?: string;
	model: string;
	thinking: ThinkingLevel;
}

export interface ModelDescriptor {
	provider: Provider;
	model: string;
	label: string;
	known: boolean;
	contextWindowTokens: number | null;
	/** Separate provider input ceilings, before the configured output reservation. */
	inputLimitTokens: { off: number; thinking: number } | null;
	imageInput: boolean;
	thinkingOptions: readonly ThinkingLevel[];
	defaultThinking: ThinkingLevel;
	protocol: ModelProtocolKind;
	/** Accepted aliases, not additional native effort levels. */
	thinkingAliases?: Partial<Record<ThinkingLevel, ThinkingLevel>>;
	/** Known integration limitation, separate from provider account availability. */
	chatUnavailableReason?: string;
	retirementAt?: string;
}

type CatalogEntry = Omit<ModelDescriptor, "known" | "defaultThinking"> & { defaultThinking?: ThinkingLevel };
const toggle = ["off", "on"] as const;
const effort = ["off", "low", "medium", "high", "max", "ultra"] as const;
const visionOnly = "This vision model is available for document requests, not the tool-using agent.";

// Exact model IDs only. Sources and verification limits: docs/ARCHITECTURE/PROVIDERS.md.
const catalog: readonly CatalogEntry[] = [
	{ provider: "deepseek", model: "deepseek-flash", label: "DeepSeek V4.1 Flash", contextWindowTokens: 1_048_576,
		inputLimitTokens: null, imageInput: true, thinkingOptions: effort, protocol: "deepseek",
		thinkingAliases: { medium: "high", ultra: "max" } },
	{ provider: "deepseek", model: "deepseek-v4-pro", label: "DeepSeek V4 Pro", contextWindowTokens: 1_048_576,
		inputLimitTokens: null, imageInput: false, thinkingOptions: effort, protocol: "deepseek",
		thinkingAliases: { medium: "high", ultra: "max" } },
	{ provider: "kimi", model: "kimi-k3", label: "Kimi K3", contextWindowTokens: null,
		inputLimitTokens: null, imageInput: true, thinkingOptions: ["low", "high", "max"], defaultThinking: "max",
		protocol: "kimi-k3" },
	{ provider: "kimi", model: "kimi-k2.7-code", label: "Kimi K2.7 Code", contextWindowTokens: 262_144,
		inputLimitTokens: null, imageInput: true, thinkingOptions: ["on"], defaultThinking: "on",
		protocol: "kimi-code" },
	{ provider: "kimi", model: "kimi-k2.7-code-highspeed", label: "Kimi K2.7 Code Highspeed", contextWindowTokens: 262_144,
		inputLimitTokens: null, imageInput: true, thinkingOptions: ["on"], defaultThinking: "on",
		protocol: "kimi-code" },
	{ provider: "kimi", model: "kimi-k2.6", label: "Kimi K2.6", contextWindowTokens: 262_144,
		inputLimitTokens: null, imageInput: true, thinkingOptions: toggle, protocol: "kimi-toggle" },
	{ provider: "mimo", model: "mimo-v2.6-flash", label: "MiMo V2.6 Flash", contextWindowTokens: 1_048_576,
		inputLimitTokens: null, imageInput: true, thinkingOptions: toggle, protocol: "mimo" },
	{ provider: "mimo", model: "mimo-v2.6-pro", label: "MiMo V2.6 Pro", contextWindowTokens: 1_048_576,
		inputLimitTokens: null, imageInput: true, thinkingOptions: toggle, protocol: "mimo" },
	{ provider: "mimo", model: "mimo-v2.6-pro-ultraspeed", label: "MiMo V2.6 Pro Ultraspeed", contextWindowTokens: 1_048_576,
		inputLimitTokens: null, imageInput: true, thinkingOptions: toggle, protocol: "mimo" },
	{ provider: "mimo", model: "mimo-v2.5", label: "MiMo V2.5", contextWindowTokens: null,
		inputLimitTokens: null, imageInput: true, thinkingOptions: toggle, protocol: "mimo", retirementAt: "2026-10-21T10:00:00+08:00" },
	{ provider: "mimo", model: "mimo-v2.5-pro", label: "MiMo V2.5 Pro", contextWindowTokens: null,
		inputLimitTokens: null, imageInput: false, thinkingOptions: toggle, protocol: "mimo", retirementAt: "2026-10-21T10:00:00+08:00" },
	{ provider: "qwen", model: "qwen3.8-max", label: "Qwen3.8 Max", contextWindowTokens: 1_000_000,
		inputLimitTokens: { off: 991_808, thinking: 983_616 }, imageInput: true,
		thinkingOptions: ["off", "low", "medium", "high", "xhigh", "max"], protocol: "qwen-effort",
		thinkingAliases: { high: "xhigh", max: "xhigh" } },
	{ provider: "qwen", model: "qwen3.8-flash", label: "Qwen3.8 Flash", contextWindowTokens: 1_000_000,
		inputLimitTokens: { off: 991_808, thinking: 983_616 }, imageInput: true,
		thinkingOptions: ["off", "low", "medium", "high", "xhigh", "max"], protocol: "qwen-effort",
		thinkingAliases: { high: "xhigh", max: "xhigh" } },
	{ provider: "qwen", model: "qwen3.7-plus", label: "Qwen3.7 Plus", contextWindowTokens: 1_000_000,
		inputLimitTokens: { off: 991_808, thinking: 983_616 }, imageInput: true, thinkingOptions: toggle, protocol: "qwen-toggle" },
	{ provider: "qwen", model: "qwen-plus", label: "Qwen Plus", contextWindowTokens: 1_000_000,
		inputLimitTokens: { off: 997_952, thinking: 995_904 }, imageInput: false, thinkingOptions: toggle, protocol: "qwen-legacy" },
	{ provider: "qwen", model: "qwen3-vl-plus", label: "Qwen3 VL Plus", contextWindowTokens: 262_144,
		inputLimitTokens: { off: 260_096, thinking: 258_048 }, imageInput: true, thinkingOptions: ["off"],
		protocol: "qwen-legacy", chatUnavailableReason: visionOnly },
	{ provider: "qwen", model: "qwen3-vl-flash", label: "Qwen3 VL Flash", contextWindowTokens: 262_144,
		inputLimitTokens: { off: 260_096, thinking: 258_048 }, imageInput: true, thinkingOptions: ["off"],
		protocol: "qwen-legacy", chatUnavailableReason: visionOnly },
];

// Only explicitly documented snapshots inherit capabilities; never strip arbitrary date suffixes.
const snapshots: Readonly<Record<string, string>> = {
	"qwen3.8-max-0902": "qwen3.8-max",
	"qwen3.8-max-2026-09-02": "qwen3.8-max",
	"qwen3.7-plus-2026-05-26": "qwen3.7-plus",
};

export function getModelDescriptor(provider: Provider, model: string): ModelDescriptor {
	parseProvider(provider);
	const canonical = provider === "qwen" && Object.hasOwn(snapshots, model) ? snapshots[model] : model;
	const entry = catalog.find((item) => item.provider === provider && item.model === canonical);
	return entry ? { ...structuredClone(entry), model, label: model === canonical ? entry.label : `${entry.label} (${model})`,
		known: true, defaultThinking: entry.thinkingOptions.includes("medium") ? "medium"
			: entry.defaultThinking ?? (entry.thinkingOptions.includes("on") ? "on" : "off") }
		: { provider, model, label: model, known: false, contextWindowTokens: null, inputLimitTokens: null,
			imageInput: false, thinkingOptions: ["off"], defaultThinking: "off",
			protocol: provider === "qwen" ? "qwen-legacy" : provider === "kimi" ? "kimi-toggle" : provider };
}

export function listModelDescriptors(provider: Provider): ModelDescriptor[] {
	parseProvider(provider);
	return catalog.filter((item) => item.provider === provider).map((item) => getModelDescriptor(provider, item.model));
}

export function getModelInputCapabilities(provider: Provider, model: string): { image: boolean; nativeFile: false } {
	return { image: getModelDescriptor(provider, model).imageInput, nativeFile: false };
}

/** Shape validation is independent of current capabilities so saved identities remain readable. */
export function decodeModelSelection(value: unknown): ModelSelection {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return invalidSelection();
	const raw = value as Record<string, unknown>;
	if (Object.keys(raw).some((key) => !["provider", "region", "workspaceId", "model", "thinking"].includes(key))
		|| typeof raw.provider !== "string" || !["deepseek", "kimi", "mimo", "qwen"].includes(raw.provider)
		|| typeof raw.region !== "string" || !["cn", "global", "intl", "us", "eu", "jp", "hk"].includes(raw.region)
		|| (Object.hasOwn(raw, "workspaceId") && typeof raw.workspaceId !== "string")
		|| typeof raw.model !== "string" || !raw.model.trim() || raw.model !== raw.model.trim()
		|| raw.model.length > 200 || /[\x00-\x1f\x7f]/.test(raw.model)
		|| typeof raw.thinking !== "string" || !["off", "on", "low", "medium", "high", "xhigh", "max", "ultra"].includes(raw.thinking)) return invalidSelection();
	const selection = { provider: raw.provider as Provider, region: raw.region as ProviderRegion,
		model: raw.model, thinking: raw.thinking as ThinkingLevel,
		...(typeof raw.workspaceId === "string" ? { workspaceId: raw.workspaceId } : {}) };
	providerEndpoint(selection.provider, selection.region, selection.workspaceId);
	return selection;
}

function invalidSelection(): never {
	throw new HarnessError("MODEL_SELECTION", "Invalid model selection. Choose a provider, region, model and supported thinking option.");
}

export function validateModelSelection(value: unknown): ModelSelection {
	const selection = decodeModelSelection(value);
	if (!getModelDescriptor(selection.provider, selection.model).thinkingOptions.includes(selection.thinking)) {
		throw new HarnessError("MODEL_SELECTION", "That thinking option is not supported by this model's Fatcat protocol.");
	}
	return selection;
}

export function defaultModelSelection(provider: Provider, region = getProviderProfile(provider).defaultRegion,
	model = getProviderProfile(provider).defaultModel, workspaceId?: string): ModelSelection {
	return validateModelSelection({ provider, region, model, thinking: getModelDescriptor(provider, model).defaultThinking,
		...(workspaceId !== undefined ? { workspaceId } : {}) });
}
