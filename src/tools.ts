import type { ChatCompletionTool } from "openai/resources/chat/completions";

export const toolDefinitions: ChatCompletionTool[] = [{
  type: "function",
  function: {
    name: "sum",
    description: "Add 2 to 32 finite numbers. Use this tool for arithmetic addition.",
    parameters: {
      type: "object",
      properties: {
        numbers: { type: "array", items: { type: "number" }, minItems: 2, maxItems: 32 },
      },
      required: ["numbers"],
      additionalProperties: false,
    },
  },
}];

export type ToolResult =
  | { ok: true; result: number }
  | { ok: false; error: { code: string; message: string } };

function failure(code: string, message: string): ToolResult {
  return { ok: false, error: { code, message } };
}

export function executeTool(name: string, argumentsJson: string): ToolResult {
  if (name !== "sum") {
    return failure("UNKNOWN_TOOL", "Only the sum tool is available.");
  }
  let args: unknown;
  try {
    args = JSON.parse(argumentsJson);
  } catch {
    return failure("INVALID_ARGUMENTS", "Tool arguments must be valid JSON.");
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)
    || Object.keys(args).length !== 1 || !("numbers" in args)) {
    return failure("INVALID_ARGUMENTS", "Expected an object containing only numbers.");
  }
  const numbers: unknown = args.numbers;
  if (!Array.isArray(numbers) || numbers.length < 2 || numbers.length > 32
    || !numbers.every((value: unknown) => typeof value === "number" && Number.isFinite(value))) {
    return failure("INVALID_ARGUMENTS", "numbers must contain 2 to 32 finite numbers.");
  }
  const result = (numbers as number[]).reduce((total, value) => total + value, 0);
  if (!Number.isFinite(result)) {
    return failure("TOOL_EXECUTION_FAILED", "The sum exceeds the finite number range.");
  }
  return { ok: true, result };
}
