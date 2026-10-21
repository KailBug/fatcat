import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming } from "openai/resources/chat/completions";
import {prepareRequestContext} from "./context/request.js";
import {parseTokenUsage} from "./model-usage.js";

import type {Config} from "./config.js";
import {HarnessError, checkCancellation} from "./errors.js";
import {getProviderProfile, providerEndpoint} from "./providers.js";
import {defaultModelSelection, getModelDescriptor} from "./model-catalog.js";
import {resolveModelProtocol} from "./model-protocol.js";

import type {ModelRequestOptions} from "./model-preparation.js";
import {defaultTools} from "./tools.js";
import type {Tools} from "./tools.js";

import type { Message, Model } from "./model-types.js";
import { encodeChatMessages, encodeChatTools, parseChatResponse } from "./model-adapters/chat-completions.js";

/** Share the bounded SDK transport while keeping provider-specific protocol settings explicit. */
export function createModel(config: Config, transport?: typeof fetch, tools: Tools = defaultTools): Model {
    const profile = getProviderProfile(config.provider);
    const baseURL = providerEndpoint(config.provider, config.region, config.workspaceId);
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
        ...(transport ? {fetch: transport} : {}),
    });

    const selection = {
        ...defaultModelSelection(config.provider, config.region, config.model, config.workspaceId),
        ...(config.thinking !== undefined ? {thinking: config.thinking} : {})
    };
    const prepare = async (messages: Message[], signal?: AbortSignal, options?: ModelRequestOptions) => {
        checkCancellation(signal);
        const descriptor = getModelDescriptor(config.provider, config.model);
        if (descriptor.chatUnavailableReason && options?.purpose !== "document" && options?.purpose !== "compaction") {
            throw new HarnessError("MODEL_UNAVAILABLE", descriptor.chatUnavailableReason);
        }
        const protocol = resolveModelProtocol(selection, options?.purpose);
        const includeTools = options?.purpose !== "compaction" && options?.purpose !== "document"
            && !(options?.toolChoice === "none" && config.provider === "mimo");
        const replay = protocol.reasoningHistory === "all" || (protocol.reasoningHistory === "with-tools" && includeTools);
        const encode = (input: { messages: Message[] }): ChatCompletionCreateParamsNonStreaming => ({
            model: config.model,
            messages: encodeChatMessages(input.messages, selection, replay),
            ...(includeTools ? { tools: encodeChatTools(tools.definitions), tool_choice: options?.toolChoice ?? "auto" } : {}),
            stream: false,
            ...protocol.generation,
        });
        const prepared = prepareRequestContext({ messages }, config.maxRequestBytes, signal,
            options?.completedHistory === true ? 1 : 2, encode);
        const body = encode(prepared.body);
        return { ...prepared, body, json: JSON.stringify(body),
            selection: structuredClone(selection), limitBytes: config.maxRequestBytes };
    };
    const callModel: Model = async (messages, signal, observe, options) => {
        const prepared = await prepare(messages, signal, options);
        const protocol = resolveModelProtocol(selection, options?.purpose);
        const { bytes } = prepared;
        if (prepared.omittedReadResults) observe?.({ type: "context_reduction", beforeBytes: prepared.beforeBytes,
            afterBytes: bytes, omittedReadResults: prepared.omittedReadResults });
        const accepted = bytes <= config.maxRequestBytes;
        observe?.({ type: "model_input", bytes, limitBytes: config.maxRequestBytes, accepted });
        if (!accepted) {
            if (options?.purpose === "document") {
                throw new HarnessError("MODEL_CONTEXT_LIMIT", `Document request is ${bytes} bytes; the local limit is ${config.maxRequestBytes}. Read fewer pages or use a smaller image. Explicitly increasing HARNESS_MAX_REQUEST_BYTES also changes the shared request budget. This request was not sent.`);
            }
            throw new HarnessError("MODEL_CONTEXT_LIMIT", `Model request is ${bytes} bytes; the local limit is ${config.maxRequestBytes}. Use /compact in chat, TUI, or Web UI for older turns, or start a smaller task with /reset. Execution records survive reset and may still exceed the limit; review them before starting a new process or explicitly increasing HARNESS_MAX_REQUEST_BYTES. Eligible older read outputs were considered for omission; protected messages remain intact. This request was not sent.`);
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
            return parseChatResponse(response, profile.label,
                !options?.purpose && protocol.reasoningHistory !== "none" ? selection : undefined);
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

    callModel.prepare = async (messages, signal, options) => {
        const { body: _body, ...prepared } = await prepare(messages, signal, options);
        return prepared;
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
