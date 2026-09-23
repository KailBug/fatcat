import { randomUUID } from "node:crypto";
import { HarnessError, checkCancellation } from "../errors.js";
import { runPowerShell } from "./process.js";
import type { ProcessResult } from "./process.js";
import type {Tool, ToolResult} from "./types.js";
import type { Workspace } from "./workspace.js";

export type ShellPermission = "ask" | "deny" | "allow";
export type ShellRequest = { command: string; cwd: string; timeoutMs: number };
export type ApproveShell = (request: ShellRequest, signal?: AbortSignal) => Promise<boolean>;
export type ShellOptions = { permission?: ShellPermission; approve?: ApproveShell };
export type CommandRecord = ShellRequest & ProcessResult & { id: string; outputSummaryTruncated: boolean };
export type CommandEventRecord = Omit<CommandRecord, "command" | "stdout" | "stderr">;

function parseArguments(args: unknown): ShellRequest {
  if (typeof args !== "object" || args === null || Array.isArray(args)
    || Object.keys(args).some((key) => !["command", "cwd", "timeoutMs"].includes(key))
    || !("command" in args) || typeof args.command !== "string" || !args.command.trim()
    || args.command.length > 4000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(args.command)
    || Buffer.from(args.command, "utf8").toString("utf8") !== args.command) {
    throw new HarnessError("INVALID_ARGUMENTS", "Expected a PowerShell command containing 1 to 4000 well-formed characters without control codes.");
  }
  const cwd = "cwd" in args ? args.cwd : ".";
  const timeoutMs = "timeoutMs" in args ? args.timeoutMs : 30000;
  if (typeof cwd !== "string" || !cwd.trim() || cwd.length > 1024
    || typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) {
    throw new HarnessError("INVALID_ARGUMENTS", "cwd must be a relative directory; timeoutMs must be an integer from 100 to 120000.");
  }
  return { command: args.command, cwd, timeoutMs };
}

export function createShellTool(workspace: Workspace, options: ShellOptions = {}, runner = runPowerShell) {
  const permission = options.permission ?? "deny";
  if (!["ask", "deny", "allow"].includes(permission)) throw new HarnessError("CONFIG", "Shell permission must be ask, deny, or allow.");
  const records: CommandRecord[] = [];
  let busy = false;
  let cleanupFailed = false;

  async function execute(args:unknown, signal?:AbortSignal):Promise<ToolResult> {
    checkCancellation(signal);
    if (permission === "deny") throw new HarnessError("PERMISSION_DENIED", "Shell execution is denied for this run.");
    if (process.platform !== "win32") throw new HarnessError("UNSUPPORTED_PLATFORM", "Shell execution currently requires native Windows PowerShell.");
    const request = parseArguments(args);
    if (busy) throw new HarnessError("SHELL_BUSY", "A shell request is already running or awaiting approval.");
    if (cleanupFailed) throw new HarnessError("SHELL_CLEANUP", "A prior process tree could not be confirmed stopped. Inspect it before starting a new run.");
    if (records.length >= 20) throw new HarnessError("SHELL_LIMIT", "The process-local command journal has reached 20 attempts. Review it before starting a new run.");
    busy = true;
    try {
      const target = await workspace.resolvePath(request.cwd, signal);
      if (!target.stat.isDirectory()) throw new HarnessError("INVALID_ARGUMENTS", "Shell cwd must be an existing directory.");
      request.cwd = target.relative;
      if (permission === "ask") {
        if (!options.approve || !await options.approve({ ...request }, signal)) {
          throw new HarnessError("PERMISSION_DENIED", "The command was not approved. No process was started.");
        }
      }
      checkCancellation(signal);
      const current = await workspace.resolvePath(request.cwd, signal);
      if (current.absolute !== target.absolute || current.stat.dev !== target.stat.dev || current.stat.ino !== target.stat.ino) {
        throw new HarnessError("PATH_NOT_ALLOWED", "The command directory changed while awaiting approval.");
      }
      const id = randomUUID();
      // Record before launch so even unexpected runner failures cannot erase an attempted execution.
      const record: CommandRecord = { ...request, id, status: "termination_failed", exitCode: null,
        stdout: "", stderr: "", truncated: false, durationMs: 0, cleanup: "unconfirmed", outputSummaryTruncated: false };
      records.push(record);
      let outcome: ProcessResult;
      try {
        outcome = await runner(request.command, target.absolute, request.timeoutMs, signal);
      } catch {
        cleanupFailed = true; throw new HarnessError("SHELL_CLEANUP", "Command execution failed without a confirmed outcome. Inspect its record before retrying.");
      }
      Object.assign(record, outcome, { stdout: Array.from(outcome.stdout).slice(0, 1000).join(""),
        stderr: Array.from(outcome.stderr).slice(0, 1000).join(""),
        outputSummaryTruncated: Array.from(outcome.stdout).length > 1000 || Array.from(outcome.stderr).length > 1000 });
      cleanupFailed = outcome.cleanup === "unconfirmed";
      checkCancellation(signal);
      // The tool completed; success describes the command, not merely the transport.
      return { ok: true, result: { recordId: id, ...outcome,
          success: outcome.status === "completed" && outcome.exitCode === 0 && !outcome.truncated } };
    } finally {
      busy = false;
    }
  }

  const tool: Tool = {
    definition: { type: "function", function: {
      name: "shell",
      description: "Run a foreground command in Windows PowerShell (not Bash), in a fresh non-interactive process. cwd defaults to the workspace root. Requires separate command authorization. No OS sandbox: commands can access files and network with current-user permissions. Do not launch background processes or interactive programs. Output is capped at 16 KiB combined; exceeding it stops the process tree. Check success, exitCode, status and truncated before claiming verification passed. Earlier side effects are never rolled back. Native nonzero exit codes and PowerShell errors are failures.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", minLength: 1, maxLength: 4000 },
          cwd: { type: "string", maxLength: 1024 },
          timeoutMs: { type: "integer", minimum: 100, maximum: 120000 },
        },
        required: ["command"],
        additionalProperties: false },
    } },
    execute,
  };
  return { tool, getCommands: (): CommandRecord[] => structuredClone(records) };
}
