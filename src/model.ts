import OpenAI from "openai";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { prepareRequestContext } from "./context.js";
import { parseTokenUsage } from "./model-usage.js";
import type { TokenUsage } from "./model-usage.js";
import type { Config } from "./config.js";
import { HarnessError, checkCancellation } from "./errors.js";
import { getProviderProfile, providerEndpoint } from "./providers.js";
import { defaultTools } from "./tools.js";
import type { Tools } from "./tools.js";

export type Message = ChatCompletionMessageParam;
export type ModelTurn = {
  message: ChatCompletionAssistantMessageParam;
  toolCalls: ChatCompletionMessageFunctionToolCall[];
};
export type ModelObservation =
  | { type: "context_reduction"; beforeBytes: number; afterBytes: number; omittedReadResults: number }
  | { type: "model_input"; bytes: number; limitBytes: number; accepted: boolean }
  | { type: "model_usage"; usage: TokenUsage | null };
export type Model = (messages: Message[], signal?: AbortSignal,
  observe?: (event: ModelObservation) => void,
  options?: { toolChoice: "auto" | "none" }) => Promise<ModelTurn>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidResponse(label: string): never {
  throw new HarnessError("MODEL_RESPONSE", `${label} returned an invalid or unsupported response.`);
}

function parseResponse(response: unknown, label: string): ModelTurn {
  if (!isRecord(response) || !Array.isArray(response.choices) || response.choices.length !== 1) {
    return invalidResponse(label);
  }
  const choice: unknown = response.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message)) return invalidResponse(label);
  if (choice.finish_reason === "length") {
    throw new HarnessError("MODEL_TRUNCATED", "The model output was truncated before completion.");
  }
  if (choice.finish_reason !== "stop" && choice.finish_reason !== "tool_calls") return invalidResponse(label);
  const raw = choice.message;
  if (raw.role !== "assistant" || (raw.content != null && typeof raw.content !== "string")) return invalidResponse(label);
  if (raw.tool_calls != null && !Array.isArray(raw.tool_calls)) return invalidResponse(label);

  const toolCalls: ChatCompletionMessageFunctionToolCall[] = [];
  const ids = new Set<string>();
  for (const call of (raw.tool_calls ?? []) as unknown[]) {
    if (!isRecord(call) || call.type !== "function"
      || typeof call.id !== "string" || !call.id.trim() || ids.has(call.id)
      || !isRecord(call.function) || typeof call.function.name !== "string" || !call.function.name.trim()
      || typeof call.function.arguments !== "string") return invalidResponse(label);
    ids.add(call.id);
    toolCalls.push({
      id: call.id,
      type: "function",
      function: { name: call.function.name, arguments: call.function.arguments },
    });
  }
  if ((choice.finish_reason === "tool_calls") !== (toolCalls.length > 0)) return invalidResponse(label);
  const content = typeof raw.content === "string" ? raw.content : null;
  if (!toolCalls.length && !content?.trim()) return invalidResponse(label);
  return {
    message: { role: "assistant", content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
    toolCalls,
  };
}

/** Share the bounded SDK transport while keeping provider-specific protocol settings explicit. */
export function createModel(config: Config, transport?: typeof fetch, tools: Tools = defaultTools): Model {
  const profile = getProviderProfile(config.provider);
  const baseURL = providerEndpoint(config.provider, config.region);
  if (!Number.isSafeInteger(config.maxRequestBytes) || config.maxRequestBytes < 1 || config.maxRequestBytes > 16 * 1024 * 1024) {
    throw new HarnessError("CONFIG", "maxRequestBytes must be a positive integer no greater than 16777216.");
  }
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL,
    organization: null,
    project: null,
    maxRetries: 0,
    timeout: config.requestTimeoutMs,
    logLevel: "off",
    ...(transport ? { fetch: transport } : {}),
  });

  const callModel: Model = async (messages, signal, observe, options) => {
    checkCancellation(signal);
    const body: ChatCompletionCreateParamsNonStreaming = {
      model: config.model,
      messages,
      // MiMo ignores non-auto tool_choice values; omit tools for a text-only request.
      ...(options?.toolChoice === "none" && config.provider === "mimo" ? {} : {
        tools: tools.definitions,
        tool_choice: options?.toolChoice ?? "auto",
      }),
      stream: false,
      ...profile.generation,
    };
    // Count the complete JSON body, including tools, guidance, history, and execution facts.
    const prepared = prepareRequestContext(body, config.maxRequestBytes, signal);
    const { bytes } = prepared;
    if (prepared.omittedReadResults) observe?.({ type: "context_reduction", beforeBytes: prepared.beforeBytes,
      afterBytes: bytes, omittedReadResults: prepared.omittedReadResults });
    const accepted = bytes <= config.maxRequestBytes;
    observe?.({ type: "model_input", bytes, limitBytes: config.maxRequestBytes, accepted });
    if (!accepted) {
      throw new HarnessError("MODEL_CONTEXT_LIMIT", `Model request is ${bytes} bytes; the local limit is ${config.maxRequestBytes}. Use a smaller task or /reset in chat. Execution records survive reset and may still exceed the limit; review them before starting a new process or explicitly increasing HARNESS_MAX_REQUEST_BYTES. Eligible older read outputs were considered for omission; protected messages remain intact. This request was not sent.`);
    }
    checkCancellation(signal);
    const deadline = AbortSignal.timeout(config.requestTimeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      const response = await client.chat.completions.create(prepared.body, { signal: requestSignal });
      // Record received usage even when the response is truncated, invalid, or canceled afterward.
      observe?.({ type: "model_usage", usage: parseTokenUsage(response?.usage) });
      checkCancellation(signal);
      if (deadline.aborted) throw new HarnessError("MODEL_TIMEOUT", `${profile.label} request timed out.`);
      return parseResponse(response, profile.label);
    } catch (error) {
      checkCancellation(signal);
      if (deadline.aborted || error instanceof OpenAI.APIConnectionTimeoutError) {
        throw new HarnessError("MODEL_TIMEOUT", `${profile.label} request timed out.`);
      }
      if (error instanceof HarnessError) throw error;
      if (error instanceof OpenAI.APIError && error.status !== undefined) {
        throw new HarnessError("MODEL_HTTP", `${profile.label} request failed (HTTP ${error.status}). Check credentials, model access, and service availability.`);
      }
      if (error instanceof OpenAI.APIConnectionError) {
        throw new HarnessError("MODEL_CONNECTION", `Could not connect to ${profile.label}.`);
      }
      throw new HarnessError("MODEL_RESPONSE", `${profile.label} request or response processing failed.`);
    }
  };

  return callModel;
}

/** Keep explicitly DeepSeek-only callers from silently contacting a different provider. */
export function createDeepSeekModel(config: Config, transport?: typeof fetch, tools: Tools = defaultTools): Model {
  if (config.provider !== "deepseek") {
    throw new HarnessError("CONFIG", "This operation requires HARNESS_PROVIDER=deepseek.");
  }
  return createModel(config, transport, tools);
}
