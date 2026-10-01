import type { ApproveShell, ApproveWrite } from "./types.js";

type ConfirmApproval = (action: "Write" | "Command", details: string, unattended: string,
  signal?: AbortSignal) => Promise<boolean>;

function preview(value: string, limit = 1200): string {
  // JSON escaping keeps file content from injecting terminal control sequences.
  const encoded = JSON.stringify(value).replace(/[\u007f-\u009f]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return encoded.length > limit ? encoded.slice(0, limit) + " ... [preview truncated]" : encoded;
}

/** Format permission requests; the terminal interface owns input and single-operation confirmation. */
export function createTerminalApprovals(confirm: ConfirmApproval): { approveWrite: ApproveWrite; approveShell: ApproveShell } {
  const approveWrite: ApproveWrite = (request, signal) => confirm("Write",
    `\nWrite request: ${request.operation} ${preview(request.path)} (${request.bytes} bytes after write)\n`
      + (request.oldText === undefined ? "" : `Replace: ${preview(request.oldText)}\n`)
      + `${request.operation === "create" ? "Content" : "With"}: ${preview(request.newText)}\n`,
    "--permission workspace-write", signal);

  const approveShell: ApproveShell = (request, signal) => confirm("Command",
    `\nPowerShell request in ${preview(request.cwd)} (timeout ${request.timeoutMs} ms)\n`
      + "This runs with your user permissions, including access outside the workspace and to the network.\n"
      + (request.approvalReason ? `Approval reason: ${preview(request.approvalReason)}\n` : "")
      + `Command: ${preview(request.command, Infinity)}\n`, request.approvalReason ? "" : "--shell-permission allow", signal);

  return { approveWrite, approveShell };
}
