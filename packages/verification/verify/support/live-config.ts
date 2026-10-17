import { loadConfig } from "@fatcat/runtime/config";
import { HarnessError } from "@fatcat/runtime/errors";

/** Existing live fixtures target DeepSeek; selecting another provider must never retarget them silently. */
export function loadLiveConfig() {
  const config = loadConfig();
  if (config.provider !== "deepseek") {
    throw new HarnessError("CONFIG", "Live verification fixtures require HARNESS_PROVIDER=deepseek. Other providers are verified offline.");
  }
  return config;
}
