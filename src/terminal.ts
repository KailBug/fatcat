import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { HarnessError, checkCancellation } from "./errors.js";
import type { ApproveShell } from "./tools/shell.js";
import type { ApproveWrite } from "./tools/write.js";

/** One input owner routes approval answers separately from queued chat tasks. */
export function createTerminalInput(
  input: Readable & { isTTY?: boolean },
  error: Writable & { isTTY?: boolean },
  externalSignal?: AbortSignal,
  env: NodeJS.ProcessEnv = process.env,
) {
  const controller = new AbortController();
  const signal = externalSignal ? AbortSignal.any([externalSignal, controller.signal]) : controller.signal;
  checkCancellation(signal);
  const interactive = Boolean(input.isTTY && error.isTTY);
  const color = interactive && env.NO_COLOR === undefined && env.TERM !== "dumb";
  const lines = createInterface({ input, output: error, terminal: interactive, crlfDelay: Infinity });
  const queued: string[] = [];
  let closed = false;
  let nextTask: ((line: string | undefined) => void) | undefined;
  let approvalAnswer: ((line: string | undefined) => void) | undefined;
  const cancel = () => controller.abort();
  const close = () => lines.close();
  lines.on("SIGINT", cancel);
  signal.addEventListener("abort", close, { once: true });
  lines.on("line", (line: string) => {
    if (approvalAnswer) approvalAnswer(line);
    else if (nextTask) {
      const resolve = nextTask;
      nextTask = undefined;
      resolve(line);
    } else queued.push(line);
  });
  lines.once("close", () => {
    closed = true;
    approvalAnswer?.(undefined);
    nextTask?.(undefined);
    nextTask = undefined;
    signal.removeEventListener("abort", close);
    lines.off("SIGINT", cancel);
  });

  async function readTask(): Promise<string | undefined> {
    checkCancellation(signal);
    if (queued.length) return queued.shift();
    if (closed) return undefined;
    return new Promise((resolve) => { nextTask = resolve; });
  }

  function prompt(): void {
    if (!interactive || closed) return;
    lines.setPrompt(color ? "\x1b[92mYou>\x1b[0m " : "You> ");
    lines.prompt();
  }

  function preview(value: string, limit = 1200): string {
    // JSON escaping keeps file content from injecting terminal control sequences.
    const encoded = JSON.stringify(value).replace(/[\u007f-\u009f]/g,
      (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
    return encoded.length > limit ? encoded.slice(0, limit) + " ... [preview truncated]" : encoded;
  }

  async function confirm(action: string, details: string, unattended: string, toolSignal?: AbortSignal): Promise<boolean> {
    const waitingSignal = toolSignal ? AbortSignal.any([signal, toolSignal]) : signal;
    checkCancellation(waitingSignal);
    if (!interactive || closed) {
      throw new HarnessError("PERMISSION_DENIED", `${action} approval requires an interactive terminal. No operation was approved. For unattended use, explicitly select ${unattended}.`);
    }
    if (approvalAnswer) throw new HarnessError("PERMISSION_DENIED", "Another approval is already pending.");
    const allowed = await new Promise<boolean>((resolve) => {
      const finish = (approved: boolean) => {
        approvalAnswer = undefined;
        waitingSignal.removeEventListener("abort", abort);
        resolve(approved);
      };
      const abort = () => finish(false);
      approvalAnswer = (line) => {
        if (line === undefined || line.trim().toLowerCase() === "no") finish(false);
        else if (line.trim().toLowerCase() === "yes") finish(true);
        else {
          error.write("Please type yes or no.\n");
          lines.prompt();
        }
      };
      waitingSignal.addEventListener("abort", abort, { once: true });
      error.write(details);
      lines.setPrompt(`Allow this ${action.toLowerCase()}? [yes/no] `);
      lines.prompt();
    });
    checkCancellation(waitingSignal);
    error.write(`${action} ${allowed ? "approved" : "denied"}.\n`);
    return allowed;
  };

  const approveWrite: ApproveWrite = (request, toolSignal) => confirm("Write",
    `\nWrite request: ${request.operation} ${preview(request.path)} (${request.bytes} bytes after write)\n`
      + (request.oldText === undefined ? "" : `Replace: ${preview(request.oldText)}\n`)
      + `${request.operation === "create" ? "Content" : "With"}: ${preview(request.newText)}\n`,
    "--permission workspace-write", toolSignal);

  const approveShell: ApproveShell = (request, toolSignal) => confirm("Command",
    `\nPowerShell request in ${preview(request.cwd)} (timeout ${request.timeoutMs} ms)\n`
      + "This runs with your user permissions, including access outside the workspace and to the network.\n"
      + `Command: ${preview(request.command, Infinity)}\n`, "--shell-permission allow", toolSignal);

  return { readTask, prompt, approveWrite, approveShell, close, signal };
}

export type TerminalInput = ReturnType<typeof createTerminalInput>;
