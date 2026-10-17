export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Provider-reported prompt cache hits, absent when not reported or inconsistent. */
  cachedPromptTokens?: number;
};

function tokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function cachedPromptTokens(raw: Record<string, unknown>, promptTokens: number): number | undefined {
  const details = raw.prompt_tokens_details;
  const standard = typeof details === "object" && details !== null && !Array.isArray(details)
    ? (details as Record<string, unknown>).cached_tokens : undefined;
  const deepseek = raw.prompt_cache_hit_tokens;
  const reported = [standard, deepseek].filter((value) => value !== undefined);
  if (!reported.length || !reported.every((value) => tokenCount(value) && value <= promptTokens)) return undefined;
  const hit = reported[0] as number;
  if (reported.some((value) => value !== hit)) return undefined;
  // DeepSeek's optional miss counter must agree when it accompanies a hit counter.
  const miss = raw.prompt_cache_miss_tokens;
  if (miss !== undefined && (!tokenCount(miss) || miss > promptTokens || hit + miss !== promptTokens)) return undefined;
  return hit;
}

/** Accept only consistent provider counters; missing or malformed usage is unknown, not zero. */
export function parseTokenUsage(value: unknown): TokenUsage | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const counts = [raw.prompt_tokens, raw.completion_tokens, raw.total_tokens];
  if (!counts.every(tokenCount)) return null;
  const [promptTokens, completionTokens, totalTokens] = counts as [number, number, number];
  if (promptTokens + completionTokens !== totalTokens) return null;
  const cached = cachedPromptTokens(raw, promptTokens);
  return { promptTokens, completionTokens, totalTokens, ...(cached === undefined ? {} : { cachedPromptTokens: cached }) };
}
