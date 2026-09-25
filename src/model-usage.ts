export type TokenUsage = { promptTokens: number; completionTokens: number; totalTokens: number };

/** Accept only consistent provider counters; missing or malformed usage is unknown, not zero. */
export function parseTokenUsage(value: unknown): TokenUsage | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const counts = [raw.prompt_tokens, raw.completion_tokens, raw.total_tokens];
  if (!counts.every((count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0)) return null;
  const [promptTokens, completionTokens, totalTokens] = counts as [number, number, number];
  if (promptTokens + completionTokens !== totalTokens) return null;
  return { promptTokens, completionTokens, totalTokens };
}
