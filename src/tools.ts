import type { LoopEvent } from "./loop.js";
import { HarnessError, checkCancellation } from "./errors.js";
import { sumTool } from "./tools/sum.js";
import { createWorkspace } from "./tools/workspace.js";
import { createReadTool } from "./tools/read.js";
import { createWriteTool } from "./tools/write.js";
import type { ApproveWrite, WorkspacePermission, WriteRecord } from "./tools/write.js";
import { createShellTool } from "./tools/shell.js";
import type { CommandRecord, ShellOptions } from "./tools/shell.js";
import { failure } from "./tools/types.js";
import type { Tool, ToolResult } from "./tools/types.js";

export type { ToolResult } from "./tools/types.js";
export type Tools = {
  definitions: Tool["definition"][];
  readonly workspaceRoot?: string;
  getWrites?: () => WriteRecord[];
  getCommands?: () => CommandRecord[];
  execute: (name: string, argumentsJson: string, signal?: AbortSignal, callId?: string) => Promise<ToolResult>;
  forTurn?: (onEvent?: (event: LoopEvent) => void) => Tools;
};

function collectTools(tools: Tool[]) {
  const byName = new Map(tools.map((tool) => [tool.definition.function.name, tool]));

  async function execute(name: string, argumentsJson: string, signal?: AbortSignal): Promise<ToolResult> {
    checkCancellation(signal);
    const tool = byName.get(name);
    if (!tool) return failure("UNKNOWN_TOOL", "The requested tool is not available in this run.");
    let args: unknown;
    try {
      args = JSON.parse(argumentsJson);
    } catch {
      return failure("INVALID_ARGUMENTS", "Tool arguments must be valid JSON.");
    }
    try {
      const result = await tool.execute(args, signal);
      checkCancellation(signal);
      return result;
    } catch (error) {
      checkCancellation(signal);
      if (error instanceof HarnessError) {
        if (error.code === "CANCELLED") throw error;
        return failure(error.code, error.message);
      }
      const code = (error as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") return failure("NOT_FOUND", "The requested path does not exist.");
      return failure("TOOL_IO", "The workspace operation could not be completed.");
    }
  }

  return {
    definitions: tools.map((tool) => tool.definition),
    execute,
  };
}

export const defaultTools: Tools = collectTools([sumTool]);

/** Filesystem access is enabled only by an explicit workspace selection. */
export async function createTools(workspace?: string, permission: WorkspacePermission = "read-only", approveWrite?: ApproveWrite, shell: ShellOptions = {}): Promise<Tools> {
  if (permission !== "ask" && permission !== "read-only" && permission !== "workspace-write") {
    throw new HarnessError("CONFIG", "Workspace permission must be ask, read-only, or workspace-write.");
  }
  if (shell.permission !== undefined && !["ask", "deny", "allow"].includes(shell.permission)) {
    throw new HarnessError("CONFIG", "Shell permission must be ask, deny, or allow.");
  }
  if (permission === "read-only" && shell.permission !== undefined && shell.permission !== "deny") {
    throw new HarnessError("CONFIG", "Read-only access cannot authorize shell execution.");
  }
  if (workspace === undefined) {
    if (shell.permission === "allow" || shell.permission === "ask") throw new HarnessError("CONFIG", "Shell execution requires an explicit workspace.");
    if (permission === "workspace-write") throw new HarnessError("CONFIG", "Writing requires an explicit workspace.");
    return defaultTools;
  }
  const scope = await createWorkspace(workspace);
  const writer = createWriteTool(scope, permission, undefined, approveWrite);
  const commands = createShellTool(scope, shell);
  return { ...collectTools([sumTool, createReadTool(scope), writer.tool, commands.tool]),
    workspaceRoot: scope.root, getWrites: writer.getWrites, getCommands: commands.getCommands };
}

export const toolDefinitions = defaultTools.definitions;
export const executeTool = defaultTools.execute;
