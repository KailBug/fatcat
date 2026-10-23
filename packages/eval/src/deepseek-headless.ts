import { createDeepSeekBudget } from "./deepseek-budget.js";
import type { HeadlessModel } from "./headless.js";

/** Assemble the dated evaluation profile; the runtime still owns model encoding and execution. */
export function createDeepSeekHeadlessModel(requests: number, apiKey: string, transport: typeof fetch, priorCostNanoCny = 0): HeadlessModel {
	if (!apiKey.trim()) throw new Error("A DeepSeek API key is required.");
	const budget = createDeepSeekBudget(requests, transport, priorCostNanoCny);
	return { evidence: "live",
		config: { provider: "deepseek", region: "global", model: "deepseek-flash", thinking: "high", apiKey,
			maxIterations: requests, maxRequestBytes: 1048576, requestTimeoutMs: 180000, autoCompaction: true },
		createTransport: () => budget.transport,
		metadata: () => ({ provider: "deepseek", thinking: "high", maxRequestBytes: 1048576, requestTimeoutMs: 180000, ...budget.snapshot() }),
	};
}
