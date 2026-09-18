import OpenAI from "openai";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import type { Config } from "./config.js";
import { HarnessError, checkCancellation } from "./errors.js";
import { toolDefinitions } from "./tools.js";

export type Message = ChatCompletionMessageParam;
export type ModelTurn = {
  message: ChatCompletionAssistantMessageParam;
  toolCalls: ChatCompletionMessageFunctionToolCall[];
};
export type Model = (messages: Message[], signal?: AbortSignal) => Promise<ModelTurn>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidResponse(): never {
  throw new HarnessError("MODEL_RESPONSE", "DeepSeek returned an invalid or unsupported response.");
}

function parseResponse(response: unknown): ModelTurn {
  if (!isRecord(response) || !Array.isArray(response.choices) || response.choices.length !== 1) {
    return invalidResponse();
  }
  const choice: unknown = response.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) return invalidResponse();
  if (choice.finish_reason === "length") {
    throw new HarnessError("MODEL_TRUNCATED", "The model output was truncated before completion.");
  }
  if (choice.finish_reason !== "stop" && choice.finish_reason !== "tool_calls") return invalidResponse();
  const raw = choice.message;
  if (raw.role !== "assistant" || (raw.content != null && typeof raw.content !== "string")) return invalidResponse();
  if (raw.tool_calls != null && !Array.isArray(raw.tool_calls)) return invalidResponse();

  const toolCalls: ChatCompletionMessageFunctionToolCall[] = [];
  const ids = new Set<string>();
  for (const call of (raw.tool_calls ?? []) as unknown[]) {
    if (!isRecord(call) || call.type !== "function"
      || typeof call.id !== "string" || !call.id.trim() || ids.has(call.id)
      || !isRecord(call.function) || typeof call.function.name !== "string" || !call.function.name.trim()
      || typeof call.function.arguments !== "string") return invalidResponse();
    ids.add(call.id);
    toolCalls.push({
      id: call.id,
      type: "function",
      function: { name: call.function.name, arguments: call.function.arguments },
    });
  }
  if ((choice.finish_reason === "tool_calls") !== (toolCalls.length > 0)) return invalidResponse();
  const content = typeof raw.content === "string" ? raw.content : null;
  if (!toolCalls.length && !content?.trim()) return invalidResponse();
  return {
    message: { role: "assistant", content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
    toolCalls,
  };
}

/** The optional transport keeps SDK-level tests offline without adding another provider. */
export function createDeepSeekModel(config: Config, transport?: typeof fetch): Model {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: "https://api.deepseek.com",
    organization: null,
    project: null,
    maxRetries: 0,
    timeout: config.requestTimeoutMs,
    logLevel: "off",
    ...(transport ? { fetch: transport } : {}),
  });

  async function callModel(messages: Message[], signal?: AbortSignal) :Promise<ModelTurn>{
    checkCancellation(signal);
    const deadline = AbortSignal.timeout(config.requestTimeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const body: ChatCompletionCreateParamsNonStreaming & { thinking: { type: "disabled" } } = {
      model: config.model,
      messages,
      tools: toolDefinitions,
      tool_choice: "auto",
      thinking: { type: "disabled" },
      stream: false,
      max_completion_tokens: 2048,
    };
    try {
      const response = await client.chat.completions.create(body, { signal: requestSignal });
      checkCancellation(signal);
      if (deadline.aborted) throw new HarnessError("MODEL_TIMEOUT", "DeepSeek request timed out.");
      return parseResponse(response);
    } catch (error) {
      checkCancellation(signal);
      if (deadline.aborted || error instanceof OpenAI.APIConnectionTimeoutError) {
        throw new HarnessError("MODEL_TIMEOUT", "DeepSeek request timed out.");
      }
      if (error instanceof HarnessError) throw error;
      if (error instanceof OpenAI.APIError && error.status !== undefined) {
        throw new HarnessError("MODEL_HTTP", `DeepSeek request failed (HTTP ${error.status}). Check credentials, model access, and service availability.`);
      }
      if (error instanceof OpenAI.APIConnectionError) {
        throw new HarnessError("MODEL_CONNECTION", "Could not connect to DeepSeek.");
      }
      throw new HarnessError("MODEL_RESPONSE", "DeepSeek request or response processing failed.");
    }
  }

  return callModel;
}
