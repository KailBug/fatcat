import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { HarnessError, checkCancellation } from "@fatcat/runtime/errors";
import { ApprovalCoordinator } from "@fatcat/runtime/permissions/approval";
import { createTerminalApprovals } from "./permissions/terminal.js";
import { QuestionCoordinator } from "@fatcat/runtime/tools/ask-user";
import type { AskUser } from "@fatcat/runtime/tools/ask-user";

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
  const approvals = new ApprovalCoordinator<{ confirmation: { action: string; details: string } }>(() => {
    if (!approvals.snapshot()) approvalAnswer = undefined;
  });
  const questions = new QuestionCoordinator(() => {
    if (!questions.snapshot()) approvalAnswer = undefined;
  });
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
    approvals.deny();
    questions.skip();
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

  async function confirm(action: string, details: string, unattended: string, toolSignal?: AbortSignal): Promise<boolean> {
    const waitingSignal = toolSignal ? AbortSignal.any([signal, toolSignal]) : signal;
    checkCancellation(waitingSignal);
    if (!interactive || closed) {
      throw new HarnessError("PERMISSION_DENIED", `${action} approval requires an interactive terminal. No operation was approved.`
        + (unattended ? ` For unattended use, explicitly select ${unattended}.` : " Run interactively to review this command."));
    }
    if (approvals.snapshot() || questions.snapshot()) throw new HarnessError("PERMISSION_DENIED", "Another interaction is already pending.");
    const pending = approvals.request("confirmation", { action, details }, waitingSignal);
    const id = approvals.snapshot()!.id;
    approvalAnswer = (line) => {
      if (line === undefined || line.trim().toLowerCase() === "no") approvals.approve(id, false);
      else if (line.trim().toLowerCase() === "yes") approvals.approve(id, true);
      else {
        error.write("Please type yes or no.\n");
        lines.prompt();
      }
    };
    error.write(details);
    lines.setPrompt(`Allow this ${action.toLowerCase()}? [yes/no] `);
    lines.prompt();
    const allowed = await pending;
    checkCancellation(waitingSignal);
    error.write(`${action} ${allowed ? "approved" : "denied"}.\n`);
    return allowed;
  };

  const { approveWrite, approveShell, approveBrowser } = createTerminalApprovals(confirm);

  const askUser: AskUser = async (request, toolSignal) => {
    const waiting = toolSignal ? AbortSignal.any([signal, toolSignal]) : signal;
    checkCancellation(waiting);
    if (!interactive || closed) throw new HarnessError("QUESTION_UNAVAILABLE", "Clarification requires an interactive terminal; no input was consumed.");
    if (approvals.snapshot() || questions.snapshot()) throw new HarnessError("QUESTION_BUSY", "Another interaction is already pending.");
    const pending = questions.request(request, waiting);
    const id = questions.snapshot()!.id;
    const safe = (text: string) => JSON.stringify(text).replace(/[\u007f-\u009f]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
    error.write(`\nQuestion: ${safe(request.question)}\n`);
    request.options?.forEach((choice, index) => error.write(`${index + 1}. ${safe(choice)}\n`));
    approvalAnswer = (line) => {
      const selected = line && /^[1-6]$/.test(line.trim()) ? request.options?.[Number(line.trim()) - 1] : undefined;
      try { questions.answer(id, line === undefined || line.trim() === "/skip" ? null : selected ?? line); }
      catch { error.write("Enter a nonblank answer up to 4000 characters, a choice number, or /skip.\n"); lines.prompt(); }
    };
    lines.setPrompt("Answer (or /skip)> "); lines.prompt();
    return pending;
  };

  return { readTask, prompt, approveWrite, approveShell, approveBrowser, askUser, close, signal };
}

export type TerminalInput = ReturnType<typeof createTerminalInput>;
