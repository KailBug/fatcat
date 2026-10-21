import {HarnessError} from "./errors.js";

export type Provider = "deepseek" | "kimi" | "mimo" | "qwen";
export type ProviderRegion = "cn" | "global" | "intl" | "us" | "eu" | "jp" | "hk";

type ProviderProfile = {
    label: string;
    apiKeyEnv: string;
    modelEnv: string;
    defaultModel: string;
    defaultRegion: ProviderRegion;
    regionEnv?: string;
    endpoints: Partial<Record<ProviderRegion, string>>;
};

// Protocol sources and scope are recorded in docs/en/ARCHITECTURE/PROVIDERS.md.
// These are API platforms, not subscription/coding-plan endpoints.
const profiles: Record<Provider, ProviderProfile> = {
    deepseek: {
        label: "DeepSeek", apiKeyEnv: "DEEPSEEK_API_KEY", modelEnv: "DEEPSEEK_MODEL",
        defaultModel: "deepseek-flash", defaultRegion: "global",
        endpoints: {global: "https://api.deepseek.com"},
    },
    kimi: {
        label: "Kimi", apiKeyEnv: "MOONSHOT_API_KEY", modelEnv: "KIMI_MODEL",
        defaultModel: "kimi-k2.6", defaultRegion: "cn", regionEnv: "KIMI_REGION",
        endpoints: {cn: "https://api.moonshot.cn/v1", global: "https://api.moonshot.ai/v1"},
    },
    mimo: {
        label: "MiMo", apiKeyEnv: "MIMO_API_KEY", modelEnv: "MIMO_MODEL",
        defaultModel: "mimo-v2.6-flash", defaultRegion: "global",
        endpoints: {global: "https://api.xiaomimimo.com/v1"},
    },
    qwen: {
        label: "Qwen", apiKeyEnv: "DASHSCOPE_API_KEY", modelEnv: "QWEN_MODEL",
        defaultModel: "qwen-plus", defaultRegion: "cn", regionEnv: "QWEN_REGION",
        endpoints: {
            cn: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            intl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1"
        },
    },
};

export function parseProvider(value: string): Provider {
    if (value === "deepseek" || value === "kimi" || value === "mimo" || value === "qwen") return value;
    throw new HarnessError("CONFIG", "HARNESS_PROVIDER must be deepseek, kimi, mimo, or qwen.");
}

export function getProviderProfile(provider: Provider) {
    return profiles[parseProvider(provider)];
}

const qwenRegions: Record<string, string> = {
    cn: "cn-beijing", intl: "ap-southeast-1", us: "us-east-1",
    eu: "eu-central-1", jp: "ap-northeast-1", hk: "cn-hongkong",
};

export function providerEndpoint(provider: Provider, region: string, workspaceId?: string): string {
    const profile = getProviderProfile(provider);
    if (workspaceId !== undefined) {
        if (provider !== "qwen" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(workspaceId)) {
            throw new HarnessError("CONFIG", "QWEN_WORKSPACE_ID must be a lowercase DNS label and is only supported by Qwen.");
        }
        if (!Object.hasOwn(qwenRegions, region)) {
            throw new HarnessError("CONFIG", "QWEN_REGION must be cn, intl, us, eu, jp, or hk.");
        }
        return `https://${workspaceId}.${qwenRegions[region]}.maas.aliyuncs.com/compatible-mode/v1`;
    }
    if (provider === "qwen" && ["us", "eu", "jp", "hk"].includes(region)) {
        throw new HarnessError("CONFIG", "QWEN_REGION requires QWEN_WORKSPACE_ID for us, eu, jp, and hk.");
    }
    // Avoid prototype properties and never accept arbitrary hosts for provider credentials.
    if ((region === "cn" || region === "global" || region === "intl") && profile.endpoints[region]) {
        return profile.endpoints[region];
    }
    throw new HarnessError("CONFIG", `${profile.regionEnv ?? "Provider region"} must be ${Object.keys(profile.endpoints).join(" or ")}.`);
}
