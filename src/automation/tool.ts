import { checkCancellation, HarnessError } from "../errors.js";
import type { Tools } from "../tools.js";
import { defaultTools } from "../tools.js";
import type { Tool, JsonValue } from "../tools/types.js";
import { failure } from "../tools/types.js";

export const automationDefinition: Tool["definition"] = { type: "function", function: {
  name: "automation",
  description: "Manage scheduled or file-change tasks bound to this conversation. Use only for explicit user automation requests. Later runs continue this session with current permissions. Do not claim creation before success. Process must remain open; no offline catch-up. Default 20 runs / 24 hours. Ask about unclear timing. Automated turns cannot create or change tasks. list returns current time and tasks.",
  parameters: { type: "object", properties: {
    action: { type: "string", enum: ["create", "list", "pause", "resume", "delete"] },
    id: { type: "string", description: "Existing task ID for pause/resume/delete." },
    prompt: { type: "string", description: "Instructions to execute on each activation." },
    trigger: { type: "object", properties: {
      type: { type: "string", enum: ["cron", "interval", "at", "file_changed"] },
      expression: { type: "string", description: "Five numeric cron fields." },
      timezone: { type: "string", enum: ["local", "UTC"] },
      seconds: { type: "integer", minimum: 60, maximum: 604800 },
      time: { type: "string", description: "Future ISO timestamp with explicit timezone offset." },
      paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 32 },
      debounceMs: { type: "integer", minimum: 1000, maximum: 60000 },
    }, required: ["type"], additionalProperties: false },
    maxRuns: { type: "integer", minimum: 1, maximum: 1000 },
    maxRuntimeSeconds: { type: "integer", minimum: 1, maximum: 604800 },
  }, required: ["action"], additionalProperties: false },
} };

/** Parent-only schema; SessionManager binds execution to the actual target session. */
export function withAutomationTool(base: Tools = defaultTools,
  execute?: (args: unknown, signal?: AbortSignal) => Promise<unknown>): Tools {
  return { ...base,
    definitions: [...base.definitions.filter((tool) => tool.function.name !== "automation"), automationDefinition],
    forTurn: (event) => withAutomationTool(base.forTurn?.(event) ?? base, execute),
    execute: async (name, json, signal, callId) => {
      if (name !== "automation") return base.execute(name, json, signal, callId);
      checkCancellation(signal);
      if (!execute) return failure("AUTOMATION_UNAVAILABLE", "Automation requires a session-bound conversation.");
      try {
        let args: unknown;
        try { args = JSON.parse(json); } catch { throw new HarnessError("INVALID_ARGUMENTS", "Expected JSON arguments."); }
        const result = await execute(args, signal);
        return { ok: true, result: JSON.parse(JSON.stringify(result)) as JsonValue };
      } catch (error) {
        checkCancellation(signal);
        return error instanceof HarnessError ? failure(error.code, error.message) : failure("AUTOMATION_FAILED", "Could not update the automation task.");
      }
    },
  };
}
