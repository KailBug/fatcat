import type { ChatCompletionFunctionTool } from "openai/resources/chat/completions";

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type ToolResult =
  | { ok: true; result: JsonValue }
  | { ok: false; error: { code: string; message: string } };

export type Tool = {
  definition: ChatCompletionFunctionTool;
  execute: (args: unknown, signal?: AbortSignal) => ToolResult | Promise<ToolResult>;
};

export function failure(code: string, message: string): ToolResult {
  return { ok: false, error: { code, message } };
}
