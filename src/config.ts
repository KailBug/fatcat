import { HarnessError } from "./errors.js";
import { getProviderProfile, parseProvider, providerEndpoint } from "./providers.js";
import type { Provider, ProviderRegion } from "./providers.js";

export type Config = {
  provider: Provider;
  region: ProviderRegion;
  apiKey: string;
  model: string;
  maxIterations: number;
  requestTimeoutMs: number;
  maxRequestBytes: number;
};

function positiveInteger(value: string, name: string, maximum: number): number {
  const text = value.trim();
  const result = Number(text);
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(result) || result > maximum) {
    throw new HarnessError("CONFIG", `${name} must be a decimal positive integer no greater than ${maximum}.`);
  }
  return result;
}

/** Configuration contains credentials. Never log this object. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const provider = parseProvider((env.HARNESS_PROVIDER ?? "deepseek").trim());
  const profile = getProviderProfile(provider);
  const region = (profile.regionEnv ? env[profile.regionEnv] ?? profile.defaultRegion : profile.defaultRegion).trim();
  providerEndpoint(provider, region);
  const apiKey = env[profile.apiKeyEnv]?.trim();
  if (!apiKey) {
    throw new HarnessError("CONFIG", `${profile.apiKeyEnv} is required. Set it in .env or the environment.`);
  }
  const model = (env[profile.modelEnv] ?? profile.defaultModel).trim();
  if (!model) {
    throw new HarnessError("CONFIG", `${profile.modelEnv} must not be empty.`);
  }
  return {
    provider,
    region: region as ProviderRegion,
    apiKey,
    model,
    maxIterations: positiveInteger(env.HARNESS_MAX_ITERATIONS ?? "32", "HARNESS_MAX_ITERATIONS", Number.MAX_SAFE_INTEGER),
    maxRequestBytes: positiveInteger(env.HARNESS_MAX_REQUEST_BYTES ?? "262144", "HARNESS_MAX_REQUEST_BYTES", 16 * 1024 * 1024),
    requestTimeoutMs: positiveInteger(env.HARNESS_REQUEST_TIMEOUT_MS ?? "60000", "HARNESS_REQUEST_TIMEOUT_MS", 2_147_483_647),
  };
}
