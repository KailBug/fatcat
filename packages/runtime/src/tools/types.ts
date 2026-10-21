export interface ToolDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  strict?: boolean | null;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type ToolResult =
  | { ok: true; result: JsonValue }
  | { ok: false; error: { code: string; message: string } };

export type Tool = {
  definition: ToolDefinition;
  execute: (args: unknown, signal?: AbortSignal) => ToolResult | Promise<ToolResult>;
};

export function failure(code: string, message: string): ToolResult {
  return { ok: false, error: { code, message } };
}
