import { HarnessError } from "../errors.js";
import type { Message } from "../model.js";
import { systemPrompt } from "../system-prompt.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function invalidSession(): never {
  throw new HarnessError("SESSION_CORRUPT", "Session data is invalid or unsupported. The saved file was not changed.");
}

/** Only the text conversation format produced by our Loop is resumable. */
export function validateHistory(value: unknown, complete = true): Message[] {
  if (!Array.isArray(value) || value.length > 200000) return invalidSession();
  if (!value.length) return [];
  const messages: Message[] = [];
  let state: "user" | "assistant" | "tools" = "user";
  const pending = new Set<string>();
  const used = new Set<string>();
  for (let index = 0; index < value.length; index++) {
    const raw: unknown = value[index];
    if (!isRecord(raw)) return invalidSession();
    if (index === 0) {
      if (raw.role !== "system" || typeof raw.content !== "string") return invalidSession();
      // Runtime policy belongs to this version, not an editable saved transcript.
      messages.push({ role: "system", content: systemPrompt });
      continue;
    }
    if (raw.role === "user") {
      if (state !== "user" || typeof raw.content !== "string" || !raw.content.trim()) return invalidSession();
      used.clear();
      messages.push({ role: "user", content: raw.content });
      state = "assistant";
    } else if (raw.role === "assistant") {
      if (state !== "assistant" || (raw.content !== null && typeof raw.content !== "string")) return invalidSession();
      const calls = raw.tool_calls;
      if (calls !== undefined && (!Array.isArray(calls) || !calls.length)) return invalidSession();
      const toolCalls: NonNullable<Extract<Message, { role: "assistant" }>["tool_calls"]> = [];
      for (const call of (calls ?? []) as unknown[]) {
        if (!isRecord(call) || call.type !== "function" || typeof call.id !== "string" || !call.id.trim()
          || used.has(call.id) || !isRecord(call.function) || typeof call.function.name !== "string"
          || !call.function.name.trim() || typeof call.function.arguments !== "string") return invalidSession();
        used.add(call.id);
        pending.add(call.id);
        toolCalls.push({ type: "function", id: call.id, function: {
          name: call.function.name, arguments: call.function.arguments,
        } });
      }
      if (!toolCalls.length && (typeof raw.content !== "string" || !raw.content.trim())) return invalidSession();
      messages.push({ role: "assistant", content: raw.content as string | null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
      state = toolCalls.length ? "tools" : "user";
    } else if (raw.role === "tool") {
      if (state !== "tools" || typeof raw.tool_call_id !== "string" || !pending.delete(raw.tool_call_id)
        || typeof raw.content !== "string") return invalidSession();
      messages.push({ role: "tool", content: raw.content, tool_call_id: raw.tool_call_id });
      if (!pending.size) state = "assistant";
    } else return invalidSession();
  }
  if (complete && (messages.length < 3 || state !== "user")) return invalidSession();
  return messages;
}
