import type { TokenUsage } from "./model-usage.js";
import type { LoopEvent } from "./loop.js";
import type { CommandEventRecord } from "./tools/shell.js";
import type { WriteRecord } from "./tools/write.js";
import type { BrowserRecord } from "./browser/protocol.js";

type InputSummary = { checked: number; rejected: number; maxBytes: number | null };
type ReductionSummary = { requests: number; omittedReadResults: number; bytesSaved: number };
type UsageSummary = { reportedRequests: number; totals: Pick<TokenUsage, "promptTokens" | "completionTokens" | "totalTokens"> | null };

function addUsage(summary: UsageSummary, usage: TokenUsage): void {
  if (summary.reportedRequests === 0) summary.totals = {
    promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, totalTokens: usage.totalTokens,
  };
  else if (summary.totals) {
    const totals = { promptTokens: summary.totals.promptTokens + usage.promptTokens,
      completionTokens: summary.totals.completionTokens + usage.completionTokens,
      totalTokens: summary.totals.totalTokens + usage.totalTokens };
    summary.totals = Object.values(totals).every(Number.isSafeInteger) ? totals : null;
  }
  // A null aggregate after overflow stays unknown rather than silently restarting the total.
  summary.reportedRequests++;
}

export type ExecutionReport = {
  outcome: "answered" | "stopped";
  stopCode: string | null;
  taskVerification: "not_assessed";
  modelRequests: { parent: number; children: number };
  requestBytes: { parent: InputSummary; children: InputSummary };
  contextReduction: { parent: ReductionSummary; children: ReductionSummary };
  tokenUsage: { parent: UsageSummary; children: UsageSummary };
  toolResults: { ok: number; errors: number };
  writes: WriteRecord[];
  browserChecks?: (BrowserRecord & { laterWriteAttempt: boolean })[];
  commands: (CommandEventRecord & { succeeded: boolean; laterWriteAttempt: boolean })[];
};
export type ReportEvent = LoopEvent | { type: "execution_report"; report: ExecutionReport };

/** Observe one root turn without changing the loop, tool permissions, or saved history. */
export function createTurnReporter(emit: (event: ReportEvent) => void): (event: LoopEvent) => void {
  const modelRequests = { parent: 0, children: 0 };
  const requestBytes: ExecutionReport["requestBytes"] = {
    parent: { checked: 0, rejected: 0, maxBytes: null }, children: { checked: 0, rejected: 0, maxBytes: null },
  };
  const contextReduction: ExecutionReport["contextReduction"] = {
    parent: { requests: 0, omittedReadResults: 0, bytesSaved: 0 }, children: { requests: 0, omittedReadResults: 0, bytesSaved: 0 },
  };
  const tokenUsage: ExecutionReport["tokenUsage"] = {
    parent: { reportedRequests: 0, totals: null }, children: { reportedRequests: 0, totals: null },
  };
  const toolResults = { ok: 0, errors: 0 };
  const writes = new Map<string, WriteRecord>();
  const browserChecks = new Map<string, BrowserRecord & { laterWriteAttempt: boolean }>();
  const commands = new Map<string, ExecutionReport["commands"][number]>();
  let finished = false;

  function observe(event: LoopEvent, child = false): void {
    if (event.type === "subagent_event") {
      observe(event.event, true);
    } else if (event.type === "model_request") {
      modelRequests[child ? "children" : "parent"]++;
    } else if (event.type === "model_input") {
      const input = requestBytes[child ? "children" : "parent"];
      input.checked++;
      if (!event.accepted) input.rejected++;
      input.maxBytes = Math.max(input.maxBytes ?? 0, event.bytes);
    } else if (event.type === "context_reduction") {
      const reduction = contextReduction[child ? "children" : "parent"];
      reduction.requests++;
      reduction.omittedReadResults += event.omittedReadResults;
      reduction.bytesSaved += event.beforeBytes - event.afterBytes;
    } else if (event.type === "model_usage" && event.usage) {
      addUsage(tokenUsage[child ? "children" : "parent"], event.usage);
    } else if (event.type === "tool_result") {
      toolResults[event.ok ? "ok" : "errors"]++;
    } else if (event.type === "write_record") {
      // A child's shared journal is reported again by the parent; do not reorder it.
      if (JSON.stringify(writes.get(event.record.id)) === JSON.stringify(event.record)) return;
      writes.set(event.record.id, structuredClone(event.record));
      for (const command of commands.values()) command.laterWriteAttempt = true;
      for (const check of browserChecks.values()) check.laterWriteAttempt = true;
    } else if (event.type === "browser_record" && !browserChecks.has(event.record.id)) {
      browserChecks.set(event.record.id, { ...event.record, laterWriteAttempt: false });
    } else if (event.type === "shell_record" && !commands.has(event.record.id)) {
      commands.set(event.record.id, { ...event.record,
        succeeded: event.record.status === "completed" && event.record.exitCode === 0
          && !event.record.truncated && event.record.cleanup !== "unconfirmed",
        laterWriteAttempt: false,
      });
    }
  }

  return (event) => {
    if (!finished) observe(event);
    emit(event);
    // Child completion is not completion of the user's turn.
    if (!finished && (event.type === "completed" || event.type === "stopped")) {
      finished = true;
      emit({ type: "execution_report", report: structuredClone({
        outcome: event.type === "completed" ? "answered" : "stopped",
        stopCode: event.type === "stopped" ? event.code : null,
        taskVerification: "not_assessed",
        modelRequests, requestBytes, contextReduction, tokenUsage, toolResults, writes: [...writes.values()], commands: [...commands.values()],
        ...(browserChecks.size ? { browserChecks: [...browserChecks.values()] } : {}),
      }) });
    }
  };
}
