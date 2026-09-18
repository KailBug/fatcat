import { HarnessError } from "./errors.js";

export type Config = {
  apiKey: string;
  model: string;
  maxIterations: number;
  requestTimeoutMs: number;
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
  const apiKey = env.DEEPSEEK_API_KEY?.trim();
  if (!apiKey) {
    throw new HarnessError("CONFIG", "DEEPSEEK_API_KEY is required. Set it in .env or the environment.");
  }
  const model = (env.DEEPSEEK_MODEL ?? "deepseek-flash").trim();
  if (!model) {
    throw new HarnessError("CONFIG", "DEEPSEEK_MODEL must not be empty.");
  }
  return {
    apiKey,
    model,
    maxIterations: positiveInteger(env.HARNESS_MAX_ITERATIONS ?? "8", "HARNESS_MAX_ITERATIONS", Number.MAX_SAFE_INTEGER),
    requestTimeoutMs: positiveInteger(env.HARNESS_REQUEST_TIMEOUT_MS ?? "60000", "HARNESS_REQUEST_TIMEOUT_MS", 2_147_483_647),
  };
}
