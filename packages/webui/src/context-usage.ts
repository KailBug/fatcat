import type { ReportEvent } from "@fatcat/runtime/execution-report";
import { parseTokenUsage } from "@fatcat/runtime/model-usage";
import { getModelDescriptor } from "@fatcat/runtime/model-catalog";
import { parseProvider } from "@fatcat/runtime/providers";

export type ContextUsage = { promptTokens: number | null; capacityTokens: number | null };

/** Observe the latest parent request, rather than cumulative turn or subagent usage. */
export class WebContextUsage {
  private promptTokens: number | null = null;
  private auxiliary = false;
  private readonly capacityTokens: number | null;

  constructor(provider: string, model: string) {
    try { this.capacityTokens = getModelDescriptor(parseProvider(provider), model).contextWindowTokens; }
    catch { this.capacityTokens = null; }
  }

  reset(): void { this.promptTokens = null; this.auxiliary = false; }

  observe(event: ReportEvent): void {
    if (event.type === "model_request") {
      this.reset();
      this.auxiliary = event.purpose === "compaction" || event.purpose === "document";
    }
    if (event.type === "model_usage" && !this.auxiliary) {
      const usage = event.usage && parseTokenUsage({ prompt_tokens: event.usage.promptTokens,
        completion_tokens: event.usage.completionTokens, total_tokens: event.usage.totalTokens });
      this.promptTokens = usage?.promptTokens ?? null;
    }
  }

  snapshot(): ContextUsage {
    return { promptTokens: this.promptTokens, capacityTokens: this.capacityTokens };
  }
}
