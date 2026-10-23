import { HarnessError } from "@fatcat/runtime/errors";
import { parseTokenUsage, type TokenUsage } from "@fatcat/runtime/model-usage";

// Dated, peak-rate ceiling. Recheck the official tariff before authorizing another run.
export const deepseekPricing = {
	checkedOn: "2026-10-23", source: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/",
	model: "deepseek-flash", documentedVersion: "DeepSeek-V4.1-Flash-1017",
	contextTokens: 1048576, outputTokens: 16384,
	inputCnyPerMillion: 2, cachedInputCnyPerMillion: 0.04, outputCnyPerMillion: 8,
	maximumCny: 10,
} as const;

interface RequestRecord {
	index: number;
	startedAt: string;
	finishedAt: string | null;
	httpStatus: number | null;
	responseId: string | null;
	responseModel: string | null;
	usage: TokenUsage | null;
	reservedNanoCny: number;
	accountedNanoCny: number;
	accounting: "reserved" | "peak-usage-ceiling";
}

/** One ledger wraps every SDK call, including delegation and compaction, before network dispatch. */
export function createDeepSeekBudget(requestLimit: number, transport: typeof fetch, priorCostNanoCny = 0) {
	if (!Number.isSafeInteger(requestLimit) || requestLimit < 1 || requestLimit > 32) throw new Error("Request limit must be 1..32.");
	if (!Number.isSafeInteger(priorCostNanoCny) || priorCostNanoCny < 0 || priorCostNanoCny > deepseekPricing.maximumCny * 1e9) {
		throw new Error("Prior cost must be an integer nanoyuan ceiling within the authorized CNY allowance.");
	}
	const inputRate = deepseekPricing.inputCnyPerMillion * 1000;
	const cachedRate = deepseekPricing.cachedInputCnyPerMillion * 1000;
	const outputRate = deepseekPricing.outputCnyPerMillion * 1000;
	const records: RequestRecord[] = [];
	let accountedNanoCny = priorCostNanoCny;
	let stoppedReason: string | null = null;
	const reject = (reason: string): never => {
		stoppedReason = reason;
		throw new HarnessError("EVAL_BUDGET", reason);
	};
	const bounded: typeof fetch = async (input, init) => {
		if (init?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
		const url = input instanceof Request ? input.url : String(input);
		if (url !== "https://api.deepseek.com/chat/completions" || init?.method !== "POST" || typeof init.body !== "string") {
			return reject("Only the official DeepSeek Chat Completions endpoint is authorized.");
		}
		const body = JSON.parse(init.body);
		if (body.model !== deepseekPricing.model || body.stream !== false
			|| !Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > deepseekPricing.outputTokens
			|| body.tools?.some((tool: { type?: string }) => tool.type !== "function")) {
			return reject("Request does not match the reviewed text/function-call pricing profile.");
		}
		if (records.length >= requestLimit) return reject("Global request allowance exhausted.");
		// Reserve the entire provider context at cache-miss peak price: no tokenizer estimate is needed.
		// Integer nanoyuan avoid rounding down. A timeout or unknown usage never releases this reserve.
		const reservation = deepseekPricing.contextTokens * inputRate + body.max_tokens * outputRate;
		if (accountedNanoCny + reservation > deepseekPricing.maximumCny * 1e9) return reject("CNY allowance cannot cover another worst-case request.");
		accountedNanoCny += reservation;
		const record: RequestRecord = { index: records.length + 1, startedAt: new Date().toISOString(), finishedAt: null,
			httpStatus: null, responseId: null, responseModel: null, usage: null,
			reservedNanoCny: reservation, accountedNanoCny: reservation, accounting: "reserved" };
		records.push(record);
		try {
			// Redirects must not forward credentials or create an unpriced request to a different endpoint.
			const response = await transport(input, { ...init, redirect: "error" });
			record.httpStatus = response.status;
			const payload = await response.clone().json().catch(() => null) as Record<string, unknown> | null;
			record.responseId = typeof payload?.id === "string" ? payload.id : null;
			record.responseModel = typeof payload?.model === "string" ? payload.model : null;
			const usage = parseTokenUsage(payload?.usage);
			if (response.ok && usage && usage.promptTokens <= deepseekPricing.contextTokens && usage.completionTokens <= body.max_tokens) {
				record.usage = usage;
				const cached = usage.cachedPromptTokens ?? 0;
				const ceiling = (usage.promptTokens - cached) * inputRate + cached * cachedRate + usage.completionTokens * outputRate;
				accountedNanoCny -= reservation - ceiling;
				record.accountedNanoCny = ceiling;
				record.accounting = "peak-usage-ceiling";
			}
			return response;
		} finally {
			record.finishedAt = new Date().toISOString();
		}
	};
	return { transport: bounded, snapshot: () => ({ pricing: { ...deepseekPricing }, requestLimit, stoppedReason,
		priorCostNanoCny, currentAttemptCnyCeiling: (accountedNanoCny - priorCostNanoCny) / 1e9,
		accountedCnyCeiling: accountedNanoCny / 1e9, usageComplete: records.length > 0 && records.every((record) => record.usage !== null),
		requests: structuredClone(records) }) };
}
