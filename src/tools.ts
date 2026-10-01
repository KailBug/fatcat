import type { LoopEvent } from "./loop.js";
import { HarnessError, checkCancellation } from "./errors.js";
import { sumTool } from "./tools/sum.js";
import { createWorkspace } from "./permissions/workspace.js";
import { PermissionPolicy } from "./permissions/policy.js";
import type { ApproveWrite, PermissionState, WorkspacePermission } from "./permissions/types.js";
import { createReadTool } from "./tools/read.js";
import { createWriteTool } from "./tools/write.js";
import type { WriteRecord } from "./tools/write.js";
import { createShellTool } from "./tools/shell.js";
import type { CommandRecord, ShellOptions } from "./tools/shell.js";
import { failure } from "./tools/types.js";
import { createWebTool } from "./tools/web.js";
import type { WebOptions } from "./tools/web.js";
import type { Tool, ToolResult } from "./tools/types.js";

export type { ToolResult } from "./tools/types.js";
export type Tools = {
  definitions: Tool["definition"][];
  readonly workspaceRoot?: string;
  getPermissionState?: () => PermissionState;
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
export async function createTools(workspace?: string, permission: WorkspacePermission = "read-only", approveWrite?: ApproveWrite,
  shell: ShellOptions = {}, web?: WebOptions, policy?: PermissionPolicy): Promise<Tools> {
  if (permission !== "ask" && permission !== "read-only" && permission !== "workspace-write") {
    throw new HarnessError("CONFIG", "Workspace permission must be ask, read-only, or workspace-write.");
  }
  if (shell.permission !== undefined && !["ask", "deny", "allow"].includes(shell.permission)) {
    throw new HarnessError("CONFIG", "Shell permission must be ask, deny, or allow.");
  }
  const sharedPolicy = policy ?? new PermissionPolicy({ permission, shellPermission: shell.permission ?? "deny" });
  const effective = sharedPolicy.snapshot();
  const webTools = web === undefined ? [] : [createWebTool(web, sharedPolicy)];
  if (workspace === undefined) {
    if (effective.shellPermission === "allow" || effective.shellPermission === "ask") throw new HarnessError("CONFIG", "Shell execution requires an explicit workspace.");
    if (effective.permission === "workspace-write") throw new HarnessError("CONFIG", "Writing requires an explicit workspace.");
    return webTools.length ? collectTools([sumTool, ...webTools]) : defaultTools;
  }
  const scope = await createWorkspace(workspace, sharedPolicy);
  const writer = createWriteTool(scope, permission, undefined, approveWrite, sharedPolicy);
  const commands = createShellTool(scope, shell, undefined, sharedPolicy);
  return { ...collectTools([sumTool, createReadTool(scope), writer.tool, commands.tool, ...webTools]),
    workspaceRoot: scope.root, getWrites: writer.getWrites, getCommands: commands.getCommands,
    getPermissionState: () => sharedPolicy.snapshot() };
}

export const toolDefinitions = defaultTools.definitions;
export const executeTool = defaultTools.execute;
