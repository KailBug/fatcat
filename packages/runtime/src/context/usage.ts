import { getModelDescriptor } from "../model-catalog.js";
import type { ModelSelection } from "../model-catalog.js";
import { resolveModelProtocol } from "../model-protocol.js";
import type { SessionConsumption } from "./accounting.js";

interface EstimateIdentity {
	kind: "estimated";
	selection: ModelSelection;
	contextRevision: number;
}

export type ContextEstimate = EstimateIdentity & ({
	status: "ready";
	inputTokens: number;
	measuredAt: string;
	method: string;
	approximate: boolean;
	limitations: string[];
} | {
	status: "pending" | "unknown";
	inputTokens: null;
	measuredAt: string | null;
	method: null;
	reason: string;
});

/** Immutable fact about one ordinary parent request; never an estimate of current context. */
export type ContextObservation = {
	kind: "reported";
	requestId: string;
	selection: ModelSelection;
	observedAt: string;
} & ({ inputTokens: number } | { inputTokens: null; reason: string });

export type ContextHeadroom = { tokens: number; status: "estimated" | "reference" }
	| { tokens: null; status: "unknown"; reason: string };

export interface ContextUsageSnapshot {
	consumption: SessionConsumption;
	/** Weighted cache-hit ratio (0..1) for the covered requests; null without a positive denominator. */
	cacheHitRate: number | null;
	contextRevision: number;
	estimate: ContextEstimate;
	lastReportedInput: ContextObservation | null;
	windowCapacityTokens: number | null;
	windowRemaining: ContextHeadroom;
	inputHeadroom: ContextHeadroom;
}

/** Negative headroom is intentional; only the UI's circle drawing may clamp a ratio. */
export function contextHeadroom(estimate: ContextEstimate): Pick<ContextUsageSnapshot,
	"windowCapacityTokens" | "windowRemaining" | "inputHeadroom"> {
	const descriptor = getModelDescriptor(estimate.selection.provider, estimate.selection.model);
	const windowCapacityTokens = descriptor.contextWindowTokens;
	const unknown = (reason: string): ContextHeadroom => ({ tokens: null, status: "unknown", reason });
	if (windowCapacityTokens === null || estimate.status !== "ready"
		|| !Number.isSafeInteger(estimate.inputTokens) || estimate.inputTokens < 0) {
		const reason = windowCapacityTokens === null ? "Model context window is unknown." : "Current context input is not available.";
		return { windowCapacityTokens, windowRemaining: unknown(reason), inputHeadroom: unknown(reason) };
	}
	const windowRemaining: ContextHeadroom = { tokens: windowCapacityTokens - estimate.inputTokens, status: "reference" };
	let protocol;
	try { protocol = resolveModelProtocol(estimate.selection); }
	catch { return { windowCapacityTokens, windowRemaining, inputHeadroom: unknown("The model protocol is unavailable.") }; }
	if (protocol.outputReservationTokens === null) return { windowCapacityTokens, windowRemaining,
		inputHeadroom: unknown("The model's generation reservation is unknown.") };
	const inputLimit = Math.min(windowCapacityTokens - protocol.outputReservationTokens,
		protocol.inputLimitTokens ?? windowCapacityTokens);
	return { windowCapacityTokens, windowRemaining,
		inputHeadroom: { tokens: inputLimit - estimate.inputTokens, status: "estimated" } };
}
