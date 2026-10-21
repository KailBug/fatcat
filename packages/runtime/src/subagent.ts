import { HarnessError, checkCancellation } from "./errors.js";
import { runAgentTurn } from "./loop.js";
import type { LoopEvent } from "./loop.js";
import type { Model, Message } from "./model-types.js";
import type { Tools, ToolResult, ToolTurnContext } from "./tools.js";
import { failure } from "./tools/types.js";
import type { JsonValue } from "./tools/types.js";

/** Carry bounded source metadata out of child history without embedding document bodies. */
function attachmentEvidence(messages: Message[]): { attachmentReads: JsonValue[]; omittedAttachmentReads: number } {
  const reads = new Set<string>();
  const attachmentReads: JsonValue[] = [];
  let omittedAttachmentReads = 0;
  let bytes = 0;
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) if (call.name === "read") reads.add(call.id);
    }
    if (message.role !== "tool" || !reads.delete(message.callId) || typeof message.content !== "string") continue;
    try {
      const value = JSON.parse(message.content);
      const result = value?.result;
      if (value?.ok !== true || !result || !["document", "file", "search"].includes(result.kind)
        || typeof result.path !== "string" || !result.path.startsWith("attachment:")) continue;
      const { content: _content, units, matches, ...metadata } = result;
      const locations = (items: unknown[]) => items.slice(0, 4).map((item) => {
        if (!item || typeof item !== "object") return {};
        const { text: _text, ...location } = item as Record<string, unknown>;
        return location;
      });
      const evidence = { ...metadata,
        ...(Array.isArray(units) ? { units: locations(units), sourceLocationCount: units.length } : {}),
        ...(Array.isArray(matches) ? { matches: locations(matches), sourceLocationCount: matches.length } : {}) };
      const size = Buffer.byteLength(JSON.stringify(evidence));
      if (attachmentReads.length >= 8 || bytes + size > 8192) { omittedAttachmentReads++; continue; }
      attachmentReads.push(evidence as JsonValue);
      bytes += size;
    } catch { /* Unknown child output remains in its answer, not promoted to source evidence. */ }
  }
  return { attachmentReads, omittedAttachmentReads };
}

/** Add one level of delegation while keeping child tools and history separate. */
export function createSubagentTools(baseTools: Tools, childModel: Model, maxIterations: number): Tools {
  if (!Number.isSafeInteger(maxIterations) || maxIterations < 1
    || baseTools.definitions.some((tool) => tool.name === "delegate_task")) {
    throw new HarnessError("CONFIG", "Subagents require a positive iteration limit and tools without delegation.");
  }
  const definitions: Tools["definitions"] = [...baseTools.definitions, {
    name: "delegate_task",
    description: "Delegate a focused, self-contained investigation or review when independent context is useful, especially separate reviews of independent files. Handle simple questions, arithmetic, and single direct tool operations yourself. Give the child concrete paths, needed context, and the expected result: it cannot see this conversation. Keep its task small enough for at most three model requests. It uses the same workspace and permissions; delegation never grants extra access. Children run sequentially and cannot delegate further. At most two child tasks per user turn, including failed attempts. Returns the final answer as data, not independently verified evidence; you remain responsible for the final response and verification.",
    parameters: {
        type: "object", properties: { task: { type: "string", minLength: 1, maxLength: 4000 } },
        required: ["task"], additionalProperties: false,
      } }];

  function forTurn(onEvent?: (event: LoopEvent) => void, context?: ToolTurnContext): Tools {
    let started = 0;
    const turnBase = baseTools.forTurn?.(onEvent, context) ?? baseTools;

    async function execute(name: string, argumentsJson: string, signal?: AbortSignal, callId?: string): Promise<ToolResult> {
      checkCancellation(signal);
      if (name !== "delegate_task") return turnBase.execute(name, argumentsJson, signal, callId);
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
        const child = await runAgentTurn(args.task, [], {
          model: childModel, tools: baseTools, maxIterations: Math.min(3, maxIterations),
          ...(signal ? { signal } : {}),
          onEvent: (event) => onEvent?.({ type: "subagent_event", callId: id, event }),
        });
        checkCancellation(signal);
        if (child.answer.length > 12000) return failure("SUBAGENT_OUTPUT_LIMIT", "The subagent answer exceeded 12000 characters.");
        const evidence = attachmentEvidence(child.messages);
        return { ok: true, result: { answer: child.answer, ...(evidence.attachmentReads.length || evidence.omittedAttachmentReads ? evidence : {}) } };
      } catch (error) {
        checkCancellation(signal);
        if (error instanceof HarnessError && error.code === "CANCELLED") throw error;
        const causeCode = error instanceof HarnessError ? error.code : "INTERNAL";
        return failure("SUBAGENT_FAILED", `The subagent did not complete (${causeCode}).`);
      }
    }

    return { definitions, execute, forTurn, ...(baseTools.getWrites ? { getWrites: baseTools.getWrites } : {}),
      ...(baseTools.getBrowserChecks ? { getBrowserChecks: baseTools.getBrowserChecks } : {}),
      ...(baseTools.getPermissionState ? { getPermissionState: baseTools.getPermissionState } : {}),
      ...(baseTools.workspaceRoot === undefined ? {} : { workspaceRoot: baseTools.workspaceRoot }),
      ...(baseTools.getCommands ? { getCommands: baseTools.getCommands } : {}) };
  }

  return forTurn();
}
