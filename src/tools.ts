import type { LoopEvent } from "./loop.js";
import { HarnessError, checkCancellation } from "./errors.js";
import { sumTool } from "./tools/sum.js";
import { createWorkspace } from "./tools/workspace.js";
import { createReadTool } from "./tools/read.js";
import { createWriteTool } from "./tools/write.js";
import type { ApproveWrite, WorkspacePermission, WriteRecord } from "./tools/write.js";
import { failure } from "./tools/types.js";
import type { Tool, ToolResult } from "./tools/types.js";

export type { ToolResult } from "./tools/types.js";
export type Tools = {
  definitions: Tool["definition"][];
  getWrites?: () => WriteRecord[];
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
export async function createTools(workspace?: string, permission: WorkspacePermission = "read-only", approveWrite?: ApproveWrite): Promise<Tools> {
  if (permission !== "ask" && permission !== "read-only" && permission !== "workspace-write") {
    throw new HarnessError("CONFIG", "Workspace permission must be ask, read-only, or workspace-write.");
  }
  if (workspace === undefined) {
    if (permission === "workspace-write") throw new HarnessError("CONFIG", "Writing requires an explicit workspace.");
    return defaultTools;
  }
  const scope = await createWorkspace(workspace);
  const writer = createWriteTool(scope, permission, undefined, approveWrite);
  return { ...collectTools([sumTool, createReadTool(scope), writer.tool]), getWrites: writer.getWrites };
}

export const toolDefinitions = defaultTools.definitions;
export const executeTool = defaultTools.execute;
