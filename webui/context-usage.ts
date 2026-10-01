import type { ReportEvent } from "../src/execution-report.js";
import { parseTokenUsage } from "../src/model-usage.js";

export type ContextUsage = { promptTokens: number | null; capacityTokens: number | null };

// Official sources checked on 2026-10-01; unknown model overrides stay unknown.
// DeepSeek: https://api-docs.deepseek.com/api/list-models/
// Kimi: https://platform.kimi.ai/docs/models
// https://huggingface.co/moonshotai/Kimi-K2.6/blob/main/generation_config.json
// MiMo: https://mimo.mi.com/docs/en-US/tokenplan/integration/openclaw
// Qwen: https://www.alibabacloud.com/help/en/model-studio/qwen-plus
const capacities = new Map<string, number>([
  ["deepseek/deepseek-flash", 1_048_576],
  ["deepseek/deepseek-v4-pro", 1_048_576],
  ["kimi/kimi-k2.6", 262_144],
  ["mimo/mimo-v2.6-flash", 1_048_576],
  ["mimo/mimo-v2.6-pro", 1_048_576],
  ["qwen/qwen-plus", 1_000_000],
]);

/** Observe the latest parent request, rather than cumulative turn or subagent usage. */
export class WebContextUsage {
  private promptTokens: number | null = null;
  private readonly capacityTokens: number | null;

  constructor(provider: string, model: string) {
    this.capacityTokens = capacities.get(`${provider}/${model}`) ?? null;
  }

  reset(): void { this.promptTokens = null; }

  observe(event: ReportEvent): void {
    if (event.type === "model_request") this.reset();
    if (event.type === "model_usage") {
      const usage = event.usage && parseTokenUsage({ prompt_tokens: event.usage.promptTokens,
        completion_tokens: event.usage.completionTokens, total_tokens: event.usage.totalTokens });
      this.promptTokens = usage?.promptTokens ?? null;
    }
  }

  snapshot(): ContextUsage {
    return { promptTokens: this.promptTokens, capacityTokens: this.capacityTokens };
  }
}
