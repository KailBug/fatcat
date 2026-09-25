import type { LoopEvent } from "./loop.js";
import type { CommandEventRecord } from "./tools/shell.js";
import type { WriteRecord } from "./tools/write.js";

export type ExecutionReport = {
  outcome: "answered" | "stopped";
  stopCode: string | null;
  taskVerification: "not_assessed";
  modelRequests: { parent: number; children: number };
  toolResults: { ok: number; errors: number };
  writes: WriteRecord[];
  commands: (CommandEventRecord & { succeeded: boolean; laterWriteAttempt: boolean })[];
};
export type ReportEvent = LoopEvent | { type: "execution_report"; report: ExecutionReport };

/** Observe one root turn without changing the loop, tool permissions, or saved history. */
export function createTurnReporter(emit: (event: ReportEvent) => void): (event: LoopEvent) => void {
  const modelRequests = { parent: 0, children: 0 };
  const toolResults = { ok: 0, errors: 0 };
  const writes = new Map<string, WriteRecord>();
  const commands = new Map<string, ExecutionReport["commands"][number]>();
  let finished = false;

  function observe(event: LoopEvent, child = false): void {
    if (event.type === "subagent_event") {
      observe(event.event, true);
    } else if (event.type === "model_request") {
      modelRequests[child ? "children" : "parent"]++;
    } else if (event.type === "tool_result") {
      toolResults[event.ok ? "ok" : "errors"]++;
    } else if (event.type === "write_record") {
      // A child's shared journal is reported again by the parent; do not reorder it.
      if (JSON.stringify(writes.get(event.record.id)) === JSON.stringify(event.record)) return;
      writes.set(event.record.id, structuredClone(event.record));
      for (const command of commands.values()) command.laterWriteAttempt = true;
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
        modelRequests, toolResults, writes: [...writes.values()], commands: [...commands.values()],
      }) });
    }
  };
}
