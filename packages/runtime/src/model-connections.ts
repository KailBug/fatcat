import type { Config } from "./config.js";
import { HarnessError } from "./errors.js";
import { defaultModelSelection, getModelDescriptor, listModelDescriptors, validateModelSelection } from "./model-catalog.js";
import type { ModelDescriptor, ModelSelection } from "./model-catalog.js";
import { getProviderProfile, providerEndpoint } from "./providers.js";
import type { Provider, ProviderRegion } from "./providers.js";

interface Connection {
	provider: Provider;
	region: ProviderRegion;
	workspaceId?: string;
	model: string;
	apiKey?: string;
	reason?: string;
}

export interface ModelChoice {
	selection: ModelSelection;
	descriptor: ModelDescriptor;
	available: boolean;
	reason?: string;
}

export interface ResolvedModelConnection {
	selection: ModelSelection;
	apiKey: string;
}

/** Host-owned credentials. Neither JSON serialization nor the public catalog exposes secrets. */
export class ModelConnections {
	readonly #connections: readonly Connection[];

	constructor(startup: Config, env: NodeJS.ProcessEnv = {}) {
		this.#connections = (["deepseek", "kimi", "mimo", "qwen", "glm"] as const).map((provider) => {
			if (provider === startup.provider) return { provider, region: startup.region, model: startup.model, apiKey: startup.apiKey,
				...(startup.workspaceId !== undefined ? { workspaceId: startup.workspaceId } : {}) };
			const profile = getProviderProfile(provider);
			const region = (profile.regionEnv ? env[profile.regionEnv] ?? profile.defaultRegion : profile.defaultRegion).trim();
			const model = (env[profile.modelEnv] ?? profile.defaultModel).trim();
			const apiKey = env[profile.apiKeyEnv]?.trim();
			const workspaceId = provider === "qwen" ? env.QWEN_WORKSPACE_ID?.trim() : undefined;
			try {
				providerEndpoint(provider, region, workspaceId);
				defaultModelSelection(provider, region as ProviderRegion, model, workspaceId);
			} catch {
				return { provider, region: profile.defaultRegion, model: profile.defaultModel,
					reason: "Provider configuration is invalid." };
			}
			return { provider, region: region as ProviderRegion, model,
				...(workspaceId !== undefined ? { workspaceId } : {}),
				...(apiKey ? { apiKey } : { reason: "Provider credentials are not configured." }) };
		});
	}

	list(): ModelChoice[] {
		return this.#connections.flatMap((connection) => {
			const descriptors = listModelDescriptors(connection.provider);
			if (!descriptors.some((item) => item.model === connection.model)) {
				descriptors.push(getModelDescriptor(connection.provider, connection.model));
			}
			return descriptors.map((descriptor) => {
				const reason = connection.reason ?? descriptor.chatUnavailableReason;
				return { descriptor,
					selection: defaultModelSelection(connection.provider, connection.region, descriptor.model, connection.workspaceId),
					available: !!connection.apiKey && !reason, ...(reason ? { reason } : {}) };
			});
		});
	}

	/** Resolve only the saved/selected endpoint identity, never silently route to another provider. */
	resolve(value: ModelSelection): ResolvedModelConnection {
		const selection = validateModelSelection(value);
		const reason = getModelDescriptor(selection.provider, selection.model).chatUnavailableReason;
		if (reason) throw new HarnessError("MODEL_UNAVAILABLE", reason);
		const connection = this.#connections.find((item) => item.provider === selection.provider && item.region === selection.region
			&& item.workspaceId === selection.workspaceId);
		if (!connection?.apiKey) throw new HarnessError("MODEL_UNAVAILABLE", "Credentials for this model's provider, region and workspace are unavailable. Configure them or select another model.");
		return { selection, apiKey: connection.apiKey };
	}
}
