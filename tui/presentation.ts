import type { ReportEvent } from "../src/execution-report.js";
import type { BrowserRequest } from "../src/browser/protocol.js";
import type { ShellRequest, WriteApprovalRequest } from "../src/permissions/types.js";
import type { TuiMessage } from "./view.js";

/** Format an eligible event; the app owns telemetry, evidence deduplication and rendering. */
export function eventPresentation(event: ReportEvent): { activity?: string; messages: TuiMessage[] } {
  const messages: TuiMessage[] = [];
  const child = event.type === "subagent_event";
  const detail = child ? event.event : event;
  const prefix = child ? "Child" : "Agent";
  switch (detail.type) {
    case "model_request":
      return { activity: `${prefix} ${detail.purpose === "compaction" ? "summary" : "request"} ${detail.iteration}`, messages };
    case "model_usage":
      return { activity: `${prefix} processing response`, messages };
    case "compaction_start":
      messages.push({ role: "system", text: "Request limit reached; compacting older turns before continuing.", label: "CONTEXT" });
      break;
    case "compaction_end":
      messages.push({ role: "system", text: `Context compacted: ${detail.beforeBytes} to ${detail.afterBytes} conversation bytes; continuing current request.`, label: "CONTEXT" });
      break;
    case "tool_result":
      messages.push({ role: "tool", text: `${detail.tool}: ${detail.ok ? "OK" : "error"}`, label: prefix });
      break;
    case "write_record":
      messages.push({ role: "tool", text: `${detail.record.operation} ${detail.record.path}: ${detail.record.status}`, label: "WRITE" });
      break;
    case "shell_record":
      messages.push({ role: "tool", text: `Command ${detail.record.status}; exit ${detail.record.exitCode ?? "N/A"}; ${detail.record.durationMs} ms`, label: "SHELL" });
      break;
  }
  if (event.type === "execution_report") {
    const report = event.report;
    messages.push({ role: "system", text: `${report.outcome}; ${report.modelRequests.parent} parent + ${report.modelRequests.children} child requests; `
      + `${report.writes.length} writes, ${report.commands.length} commands. Task verification: not assessed.`, label: "TURN REPORT" });
    for (const command of report.commands) {
      if (command.laterWriteAttempt) messages.push({ role: "system", text: "A write was attempted after a command. Earlier checks may be stale.", label: "EVIDENCE" });
    }
    for (const check of report.browserChecks ?? []) {
      messages.push({ role: "system", text: [`${check.path}: ${check.status}; ${check.errorCount} diagnostics, ${check.blockedCount} blocked.`,
        ...(check.reportPath ? [`Report: ${check.reportPath}`] : []),
        ...(check.screenshotPath ? [`Screenshot: ${check.screenshotPath}`] : []),
        ...(check.laterWriteAttempt ? ["A later write was attempted. Run a fresh browser check."] : []),
      ].join("\n"), label: "BROWSER EVIDENCE" });
    }
  }
  return { messages };
}

function preview(value: string): string {
  const escaped = JSON.stringify(value);
  return escaped.length <= 4000 ? escaped : `${escaped.slice(0, 4000)} ... [preview truncated]`;
}

export function writeApprovalDetails(request: WriteApprovalRequest): string {
  return [
    `${request.operation} ${JSON.stringify(request.path)} (${request.bytes} bytes after write)`,
    ...(request.oldText === undefined ? [] : [`Replace: ${preview(request.oldText)}`]),
    `${request.operation === "create" ? "Content" : "With"}: ${preview(request.newText)}`,
  ].join("\n");
}

export function shellApprovalDetails(request: ShellRequest, workspace: string | undefined): string {
  return [
    `Workspace: ${workspace ?? "disabled"}`, `Working directory: ${JSON.stringify(request.cwd)}`,
    `Timeout: ${request.timeoutMs} ms`, "PowerShell runs with your user permissions, including outside the workspace and on the network.",
    ...(request.approvalReason ? [`Approval reason: ${JSON.stringify(request.approvalReason)}`] : []),
    `Command: ${JSON.stringify(request.command)}`,
  ].join("\n");
}

export function browserApprovalDetails(request: BrowserRequest, workspace: string | undefined): string {
  return [
    `Workspace: ${workspace ?? "disabled"}`,
    `Browser check: ${JSON.stringify(request)}`,
    "Runs local page scripts with external traffic blocked; saves JSON/PNG under fatcat-browser-evidence.",
  ].join("\n");
}
