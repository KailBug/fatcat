import { HarnessError } from "./errors.js";

export type Provider = "deepseek" | "kimi" | "mimo" | "qwen";
export type ProviderRegion = "cn" | "global" | "intl";

type ProviderProfile = {
  label: string;
  apiKeyEnv: string;
  modelEnv: string;
  defaultModel: string;
  defaultRegion: ProviderRegion;
  regionEnv?: string;
  endpoints: Partial<Record<ProviderRegion, string>>;
  generation: { thinking: { type: "disabled" }; max_completion_tokens: number }
    | { enable_thinking: false; max_tokens: number };
};

// Protocol sources and scope are recorded in docs/ARCHITECTURE/PROVIDERS.md.
// These are API platforms, not subscription/coding-plan endpoints.
const profiles: Record<Provider, ProviderProfile> = {
  deepseek: {
    label: "DeepSeek", apiKeyEnv: "DEEPSEEK_API_KEY", modelEnv: "DEEPSEEK_MODEL",
    defaultModel: "deepseek-flash", defaultRegion: "global",
    endpoints: { global: "https://api.deepseek.com" },
    generation: { thinking: { type: "disabled" }, max_completion_tokens: 2048 },
  },
  kimi: {
    label: "Kimi", apiKeyEnv: "MOONSHOT_API_KEY", modelEnv: "KIMI_MODEL",
    defaultModel: "kimi-k2.6", defaultRegion: "cn", regionEnv: "KIMI_REGION",
    endpoints: { cn: "https://api.moonshot.cn/v1", global: "https://api.moonshot.ai/v1" },
    generation: { thinking: { type: "disabled" }, max_completion_tokens: 2048 },
  },
  mimo: {
    label: "MiMo", apiKeyEnv: "MIMO_API_KEY", modelEnv: "MIMO_MODEL",
    defaultModel: "mimo-v2.6-flash", defaultRegion: "global",
    endpoints: { global: "https://api.xiaomimimo.com/v1" },
    generation: { thinking: { type: "disabled" }, max_completion_tokens: 2048 },
  },
  qwen: {
    label: "Qwen", apiKeyEnv: "DASHSCOPE_API_KEY", modelEnv: "QWEN_MODEL",
    defaultModel: "qwen-plus", defaultRegion: "cn", regionEnv: "QWEN_REGION",
    endpoints: { cn: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      intl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1" },
    // max_completion_tokens is only supported by newer Qwen families, not qwen-plus.
    generation: { enable_thinking: false, max_tokens: 2048 },
  },
};

export function parseProvider(value: string): Provider {
  if (value === "deepseek" || value === "kimi" || value === "mimo" || value === "qwen") return value;
  throw new HarnessError("CONFIG", "HARNESS_PROVIDER must be deepseek, kimi, mimo, or qwen.");
}

export function getProviderProfile(provider: Provider) {
  return profiles[parseProvider(provider)];
}

export function providerEndpoint(provider: Provider, region: string): string {
  const profile = getProviderProfile(provider);
  // Avoid prototype properties and never accept arbitrary hosts for provider credentials.
  if ((region === "cn" || region === "global" || region === "intl") && profile.endpoints[region]) {
    return profile.endpoints[region];
  }
  throw new HarnessError("CONFIG", `${profile.regionEnv ?? "Provider region"} must be ${Object.keys(profile.endpoints).join(" or ")}.`);
}
