import type { Model, Message, ModelObservation, ModelTurn } from "./model.js";
import { HarnessError, checkCancellation } from "./errors.js";
import { systemPrompt } from "./system-prompt.js";
import { defaultTools } from "./tools.js";
import type { Tools } from "./tools.js";
import type { CommandEventRecord } from "./tools/shell.js";
import type { WriteRecord } from "./tools/write.js";
import type { BrowserRecord } from "./browser/protocol.js";
import { prepareTurnMessages } from "./context/turn-request.js";
import type { CompactionState } from "./context/manager.js";

export type LoopEvent =
  | (ModelObservation & { iteration: number })
  | { type: "shell_record"; record: CommandEventRecord }
  | { type: "write_record"; record: WriteRecord }
  | { type: "browser_record"; record: BrowserRecord }
  | { type: "model_request"; iteration: number; purpose?: "compaction" | "document" }
  | { type: "compaction_start"; reason: "request_limit" }
  | { type: "compaction_end"; requests: number; beforeBytes: number; afterBytes: number }
  | { type: "tool_result"; iteration: number; callId: string; tool: string; ok: boolean }
  | { type: "completed"; iterations: number }
  | { type: "stopped"; code: string }
  | { type: "subagent_event"; callId: string; event: LoopEvent };

export type LoopOptions = {
  model: Model;
  maxIterations: number;
  tools?: Tools;
  signal?: AbortSignal;
  onEvent?: (event: LoopEvent) => void;
  /** Persist a transcript checkpoint before work and after each recorded response. */
  onCheckpoint?: (messages: readonly Message[]) => Promise<void>;
  compaction?: CompactionState;
  /** Recover a locally rejected request without restarting the turn or replaying tools. */
  onContextLimit?: (maxRequests: number, iteration: number) => Promise<{
    compaction: CompactionState; requests: number;
  } | undefined>;
};

/** Run one task with fresh history, preserving the original single-task API. */
export async function runAgent(prompt: string, options: LoopOptions): Promise<string> {
  return (await runAgentTurn(prompt, [], options)).answer;
}

/** Work on a copy; the session decides whether to keep a completed turn. */
export async function runAgentTurn(
  prompt: string,
  history: readonly Message[],
  options: LoopOptions,
): Promise<{ answer: string; messages: Message[] }> {
  const { model, maxIterations, tools = defaultTools, signal, onEvent } = options;
  const messages: Message[] = history.length ? structuredClone([...history]) : [
    {
      role: "system",
      content: systemPrompt,
    },
  ];
  messages.push({ role: "user", content: prompt });
  const seenCallIds = new Set<string>();
  let compaction = options.compaction;
  let compactionAttempted = false;
  let requests = 0;
  const turnTools = tools.forTurn?.(onEvent, {
    documentRequest: () => {
      checkCancellation(signal);
      if (requests >= maxIterations - 1) throw new HarnessError("DOCUMENT_BUDGET", "No document request remains in this turn. One request is reserved for the final response; report uncovered pages.");
      const iteration = ++requests;
      onEvent?.({ type: "model_request", iteration, purpose: "document" });
      return (event) => onEvent?.({ ...event, iteration });
    },
  }) ?? tools;
  const loggedWrites = new Map((turnTools.getWrites?.() ?? []).map((record) => [record.id, JSON.stringify(record)]));
  const loggedCommands = new Set((turnTools.getCommands?.() ?? []).map((record) => record.id));
  const loggedBrowsers = new Set((turnTools.getBrowserChecks?.() ?? []).map((record) => record.id));
  function reportExecutionRecords(): void {
    for (const record of turnTools.getBrowserChecks?.() ?? []) {
      if (!loggedBrowsers.has(record.id)) { loggedBrowsers.add(record.id); onEvent?.({ type: "browser_record", record }); }
    }
    for (const record of turnTools.getCommands?.() ?? []) {
      if (!loggedCommands.has(record.id)) {
        loggedCommands.add(record.id);
        const { command: _command, stdout: _stdout, stderr: _stderr, ...metadata } = record;
        onEvent?.({ type: "shell_record", record: metadata });
      }
    }
    for (const record of turnTools.getWrites?.() ?? []) {
      const snapshot = JSON.stringify(record);
      if (loggedWrites.get(record.id) !== snapshot) {
        loggedWrites.set(record.id, snapshot);
        onEvent?.({ type: "write_record", record });
      }
    }
  }
  try {
    if (!prompt.trim()) throw new HarnessError("INPUT", "The prompt must not be empty.");
    if (!Number.isSafeInteger(maxIterations) || maxIterations < 1) {
      throw new HarnessError("CONFIG", "maxIterations must be a positive safe integer.");
    }
    if (options.onCheckpoint) await options.onCheckpoint(structuredClone(messages));
    while (requests < maxIterations) {
      const iteration = ++requests;
      checkCancellation(signal);
      onEvent?.({ type: "model_request", iteration });
      const requestMessages = prepareTurnMessages(messages, compaction, turnTools, iteration, maxIterations);
      const finalRequest = iteration === maxIterations;
      let turn: ModelTurn;
      let locallyRejected = false;
      try {
        turn = await model(requestMessages, signal, (event) => {
          if (event.type === "model_input" && !event.accepted) locallyRejected = true;
          onEvent?.({ ...event, iteration });
        }, { toolChoice: finalRequest ? "none" : "auto" });
      } catch (error) {
        checkCancellation(signal);
        // Count the rejected attempt and summaries within the existing turn budget,
        // leaving one request for continuation. Provider failures never enter here.
        const available = maxIterations - iteration - 1;
        if (!locallyRejected || !(error instanceof HarnessError) || error.code !== "MODEL_CONTEXT_LIMIT"
          || compactionAttempted || !options.onContextLimit || available < 1) throw error;
        compactionAttempted = true;
        const recovered = await options.onContextLimit(available, iteration);
        if (!recovered) throw error;
        compaction = recovered.compaction;
        requests += recovered.requests;
        continue;
      }
      checkCancellation(signal);
      messages.push(turn.message);
      if (options.onCheckpoint) await options.onCheckpoint(structuredClone(messages));
      if (!turn.toolCalls.length) {
        const content = turn.message.content;
        if (typeof content !== "string" || !content.trim()) {
          throw new HarnessError("MODEL_RESPONSE", "The model did not return a final answer.");
        }
        onEvent?.({ type: "completed", iterations: iteration });
        return { answer: content, messages: structuredClone(messages) };
      }
      // A tool needs a following model turn; do not execute it when no turn remains.
      if (iteration === maxIterations) break;
      for (const call of turn.toolCalls) {
        if (seenCallIds.has(call.id)) {
          throw new HarnessError("MODEL_RESPONSE", "The model reused a tool call ID.");
        }
        seenCallIds.add(call.id);
      }
      for (const call of turn.toolCalls) {
        checkCancellation(signal);
        const result = await turnTools.execute(call.function.name, call.function.arguments, signal, call.id);
        reportExecutionRecords();
        checkCancellation(signal);
        messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
        if (options.onCheckpoint) await options.onCheckpoint(structuredClone(messages));
        onEvent?.({ type: "tool_result", iteration, callId: call.id, tool: call.function.name, ok: result.ok });
      }
    }
    throw new HarnessError("MAX_ITERATIONS", `The model still requested tools on the final request (${maxIterations}/${maxIterations}) instead of returning an answer. Check completed operations before retrying with a smaller task or increasing HARNESS_MAX_ITERATIONS.`);
  } catch (error) {
    reportExecutionRecords();
    onEvent?.({ type: "stopped", code: error instanceof HarnessError ? error.code : "INTERNAL" });
    throw error;
  } finally {
    reportExecutionRecords();
  }
}
