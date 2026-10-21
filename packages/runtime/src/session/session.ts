import { HarnessError, checkCancellation } from "../errors.js";
import { runAgentTurn } from "../loop.js";
import type { LoopOptions } from "../loop.js";
import type { Message, Model } from "../model-types.js";
import { compactContext, prepareCompaction } from "../context/compaction.js";
import type { CompactionOptions, CompactionResult } from "../context/compaction.js";
import { decodeCompaction, inspectContext } from "../context/manager.js";
import type { CompactionState, ContextStatus } from "../context/manager.js";
import { validateHistory } from "./history.js";

export interface SessionOptions extends Pick<LoopOptions, "model" | "maxIterations" | "tools"> {
	compactionModel?: Model;
	maxRequestBytes?: number;
	autoCompaction?: boolean;
}

export interface SessionExecutionOptions extends Pick<LoopOptions, "signal" | "onEvent" | "onCheckpoint"> {
	/** Publish a generated context before using it in the running turn. */
	onCompaction?: (compaction: CompactionState) => Promise<void>;
}

/** Own complete successful history and its model projection in a process-local conversation. */
export class Session {
	private history: Message[];
	private running = false;
	private compaction: CompactionState | undefined;
	private readonly options: SessionOptions;

	constructor(options: SessionOptions, initialHistory: readonly Message[] = [], compaction?: CompactionState) {
		this.options = options;
		this.history = validateHistory(initialHistory);
		this.compaction = compaction === undefined ? undefined : decodeCompaction(compaction, this.history);
	}

	get messages(): Message[] {
		return structuredClone(this.history);
	}

	get context(): ContextStatus {
		return inspectContext(this.history, this.compaction);
	}

	async run(prompt: string, options: SessionExecutionOptions = {}): Promise<string> {
		this.requireIdle();
		this.running = true;
		try {
			const result = await runAgentTurn(prompt, this.history, {
				...this.options, ...options, ...(this.compaction ? { compaction: this.compaction } : {}),
				...(this.options.autoCompaction === false ? {} : {
					onContextLimit: (maxRequests: number, iteration: number) => this.compactDuringTurn(maxRequests, iteration, options),
				}),
			});
			checkCancellation(options.signal);
			this.history = result.messages;
			return result.answer;
		} finally {
			this.running = false;
		}
	}

	private async compactDuringTurn(maxRequests: number, iteration: number, options: SessionExecutionOptions) {
		// Only successful history is eligible; the running prompt and tool results stay intact.
		const boundary = this.history.findLastIndex((message) => message.role === "user");
		if (boundary <= (this.compaction?.firstKeptMessage ?? 1)) return;
		const plan = prepareCompaction(this.history, this.compaction, this.options.maxRequestBytes, maxRequests, options);
		const beforeBytes = this.context.projectedBytes;
		options.onEvent?.({ type: "compaction_start", reason: "request_limit" });
		const candidate = await compactContext(this.options.compactionModel ?? this.options.model,
			this.history, this.compaction, plan, {
				...(options.signal ? { signal: options.signal } : {}),
				onEvent: (event) => options.onEvent?.("iteration" in event ? { ...event, iteration: event.iteration + iteration } : event),
			});
		checkCancellation(options.signal);
		await options.onCompaction?.(candidate);
		this.compaction = candidate;
		options.onEvent?.({ type: "compaction_end", requests: plan.chunks.length,
			beforeBytes, afterBytes: this.context.projectedBytes });
		return { compaction: candidate, requests: plan.chunks.length };
	}

	async compact(options: CompactionOptions = {}): Promise<CompactionResult> {
		this.requireIdle();
		this.running = true;
		let result: CompactionResult;
		try {
			const plan = prepareCompaction(this.history, this.compaction, this.options.maxRequestBytes, this.options.maxIterations, options);
			const candidate = await compactContext(this.options.compactionModel ?? this.options.model,
				this.history, this.compaction, plan, options);
			checkCancellation(options.signal);
			this.compaction = candidate;
			result = { ...this.context, requests: plan.chunks.length };
		} catch (error) {
			options.onEvent?.({ type: "stopped", code: error instanceof HarnessError ? error.code : "INTERNAL" });
			throw error;
		} finally {
			this.running = false;
		}
		options.onEvent?.({ type: "completed", iterations: result.requests });
		return result;
	}

	reset(): void {
		this.requireIdle();
		this.history = [];
		this.compaction = undefined;
	}

	private requireIdle(): void {
		if (this.running) throw new HarnessError("SESSION_BUSY", "A turn or compaction is already running in this session.");
	}
}
