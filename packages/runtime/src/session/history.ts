import { HarnessError } from "../errors.js";
import type { Message } from "../model-types.js";
import { systemPrompt } from "../system-prompt.js";
import { decodeProviderReplayData } from "../provider-replay.js";

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
      const calls = raw.toolCalls;
      if (calls !== undefined && (!Array.isArray(calls) || !calls.length)) return invalidSession();
      const toolCalls: NonNullable<Extract<Message, { role: "assistant" }>["toolCalls"]> = [];
      for (const call of (calls ?? []) as unknown[]) {
        if (!isRecord(call) || typeof call.id !== "string" || !call.id.trim()
          || used.has(call.id) || typeof call.name !== "string"
          || !call.name.trim() || typeof call.arguments !== "string") return invalidSession();
        used.add(call.id);
        pending.add(call.id);
        toolCalls.push({ id: call.id, name: call.name, arguments: call.arguments });
      }
      if (!toolCalls.length && (typeof raw.content !== "string" || !raw.content.trim())) return invalidSession();
      const message: Extract<Message, { role: "assistant" }> = { role: "assistant", content: raw.content as string | null,
        ...(toolCalls.length ? { toolCalls } : {}) };
      if (raw.providerReplay !== undefined) {
        try { message.providerReplay = decodeProviderReplayData(raw.providerReplay, message); } catch { return invalidSession(); }
      }
      messages.push(message);
      state = toolCalls.length ? "tools" : "user";
    } else if (raw.role === "tool") {
      const callId = raw.callId;
      if (state !== "tools" || typeof callId !== "string" || !pending.delete(callId)
        || typeof raw.content !== "string") return invalidSession();
      messages.push({ role: "tool", content: raw.content, callId });
      if (!pending.size) state = "assistant";
    } else return invalidSession();
  }
  if (complete && (messages.length < 3 || state !== "user")) return invalidSession();
  return messages;
}
