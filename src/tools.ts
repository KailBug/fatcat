import { HarnessError, checkCancellation } from "./errors.js";
import { sumTool } from "./tools/sum.js";
import { createWorkspaceTools } from "./tools/workspace.js";
import { failure } from "./tools/types.js";
import type { Tool, ToolResult } from "./tools/types.js";

export type { ToolResult } from "./tools/types.js";
export type Tools = ReturnType<typeof collectTools>;

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

export const defaultTools = collectTools([sumTool]);

/** Filesystem access is enabled only by an explicit workspace selection. */
export async function createTools(workspace?: string): Promise<Tools> {
  return workspace === undefined ? defaultTools : collectTools([sumTool, ...await createWorkspaceTools(workspace)]);
}

export const toolDefinitions = defaultTools.definitions;
export const executeTool = defaultTools.execute;
