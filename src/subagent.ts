import { HarnessError, checkCancellation } from "./errors.js";
import { runAgent } from "./loop.js";
import type { LoopEvent } from "./loop.js";
import type { Model } from "./model.js";
import type { Tools, ToolResult } from "./tools.js";
import { failure } from "./tools/types.js";

/** Add one level of delegation while keeping child tools and history separate. */
export function createSubagentTools(baseTools: Tools, childModel: Model, maxIterations: number): Tools {
  if (!Number.isSafeInteger(maxIterations) || maxIterations < 1
    || baseTools.definitions.some((tool) => tool.function.name === "delegate_task")) {
    throw new HarnessError("CONFIG", "Subagents require a positive iteration limit and tools without delegation.");
  }
  const definitions: Tools["definitions"] = [...baseTools.definitions, {
    type: "function",
    function: {
      name: "delegate_task",
      description: "Delegate a self-contained task to an isolated assistant with the same basic tools and workspace. Include all needed context: it cannot see this conversation. It cannot delegate further. At most two child tasks per user turn; each has at most three model requests. Returns its final answer as data.",
      parameters: {
        type: "object", properties: { task: { type: "string", minLength: 1, maxLength: 4000 } },
        required: ["task"], additionalProperties: false,
      },
    },
  }];

  function forTurn(onEvent?: (event: LoopEvent) => void): Tools {
    let started = 0;

    async function execute(name: string, argumentsJson: string, signal?: AbortSignal, callId?: string): Promise<ToolResult> {
      checkCancellation(signal);
      if (name !== "delegate_task") return baseTools.execute(name, argumentsJson, signal, callId);
      let args: unknown;
      try {
        args = JSON.parse(argumentsJson);
      } catch {
        return failure("INVALID_ARGUMENTS", "Tool arguments must be valid JSON.");
      }
      if (typeof args !== "object" || args === null || Array.isArray(args)
        || Object.keys(args).length !== 1 || !("task" in args) || typeof args.task !== "string"
        || !args.task.trim() || args.task.length > 4000) {
        return failure("INVALID_ARGUMENTS", "Expected only task, a non-empty string up to 4000 characters.");
      }
      if (started >= 2) return failure("SUBAGENT_LIMIT", "At most two subagent tasks may start per user turn.");
      const id = callId ?? `subagent-${started + 1}`;
      started++;
      try {
        const answer = await runAgent(args.task, {
          model: childModel, tools: baseTools, maxIterations: Math.min(3, maxIterations),
          ...(signal ? { signal } : {}),
          onEvent: (event) => onEvent?.({ type: "subagent_event", callId: id, event }),
        });
        checkCancellation(signal);
        if (answer.length > 12000) return failure("SUBAGENT_OUTPUT_LIMIT", "The subagent answer exceeded 12000 characters.");
        return { ok: true, result: { answer } };
      } catch (error) {
        checkCancellation(signal);
        if (error instanceof HarnessError && error.code === "CANCELLED") throw error;
        const causeCode = error instanceof HarnessError ? error.code : "INTERNAL";
        return failure("SUBAGENT_FAILED", `The subagent did not complete (${causeCode}).`);
      }
    }

    return { definitions, execute, forTurn, ...(baseTools.getWrites ? { getWrites: baseTools.getWrites } : {}),
      ...(baseTools.getCommands ? { getCommands: baseTools.getCommands } : {}) };
  }

  return forTurn();
}
