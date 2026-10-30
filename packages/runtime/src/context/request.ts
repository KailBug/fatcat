import {checkCancellation} from "../errors.js";
import type {Message} from "../model-types.js";

function omission(content: Message["content"]): string | undefined {
    if (typeof content !== "string") return;
    try {
        const value = JSON.parse(content) as { ok?: unknown; result?: Record<string, unknown> } | null;
        const result = value?.result;
        if (value?.ok !== true || !result || typeof result.kind !== "string" || !["file", "directory", "search", "document", "glob", "output"].includes(result.kind)
            || (result.kind === "output" ? typeof result.outputId !== "string" : typeof result.path !== "string")) return;
        if ((result.kind === "file" && typeof result.content !== "string")
            || (result.kind === "directory" && !Array.isArray(result.entries))
            || (result.kind === "search" && !Array.isArray(result.matches))
            || (result.kind === "glob" && !Array.isArray(result.paths))
            || (result.kind === "output" && typeof result.content !== "string" && !Array.isArray(result.matches))
            || (result.kind === "document" && (!Array.isArray(result.units) || typeof result.parserVersion !== "string"))) return;
        return JSON.stringify({
            ok: true, result: {
                kind: "context_omitted", originalKind: result.kind,
                ...(result.kind === "output" ? {
                    outputId: result.outputId,
                    stream: result.stream
                } : {path: result.path}),
                ...(result.kind === "document" ? {parserVersion: result.parserVersion} : {}),
                notice: "Earlier read output omitted from this request to fit the byte budget. Repeat the original retrieval, or narrow it, if needed. Files may have changed; process-local output references may have expired. This marker is not retained content.",
            }
        });
    } catch {
        // Unknown or malformed results must remain visible, not be mistaken for disposable reads.
        return;
    }
}

/** Project older successful reads into explicit markers; never mutate the saved conversation. */
export function prepareRequestContext<T extends {
    messages: Message[]
}>(body: T, limitBytes: number, signal?: AbortSignal, protectedTurns = 2, encode: (body: T) => unknown = (value) => value) {
    checkCancellation(signal);
    const beforeBytes = Buffer.byteLength(JSON.stringify(encode(body)));
    let bytes = beforeBytes;
    let omittedReadResults = 0;
    const unchanged = {body, beforeBytes, bytes, omittedReadResults};
    if (bytes <= limitBytes) return unchanged;

    // Loop histories contain one user message per turn; execution facts precede that history.
    // Preserve the most recent completed turn and the current turn in full.
    let protectedFrom = 0;
    let users = 0;
    for (let index = body.messages.length - 1; index >= 0; index--) {
        checkCancellation(signal);
        if (body.messages[index]!.role === "user" && ++users === protectedTurns) {
            protectedFrom = index;
            break;
        }
    }
    const previous = body.messages[protectedFrom - 1];
    if (previous?.role !== "assistant" || previous.toolCalls?.length
        || typeof previous.content !== "string" || !previous.content.trim()) return unchanged;

    const messages = [...body.messages];
    const pending = new Map<string, string>();
    for (let index = 0; index < protectedFrom && bytes > limitBytes; index++) {
        checkCancellation(signal);
        const message = messages[index]!;
        if (message.role === "assistant") {
            pending.clear();
            for (const call of message.toolCalls ?? []) {
                pending.set(call.id, call.name);
            }
        } else if (message.role === "user" || message.role === "system" || message.role === "developer") {
            pending.clear();
        } else if (message.role === "tool") {
            const name = pending.get(message.callId);
            pending.delete(message.callId);
            if (!name || !["read", "grep", "glob", "output_read"].includes(name)) continue;
            const content = omission(message.content);
            if (content === undefined) continue;
            const replacement: Message = {...message, content};
            const saved = Buffer.byteLength(JSON.stringify(message)) - Buffer.byteLength(JSON.stringify(replacement));
            if (saved <= 0) continue;
            messages[index] = replacement;
            bytes = Buffer.byteLength(JSON.stringify(encode({...body, messages})));
            omittedReadResults++;
        }
    }
    checkCancellation(signal);
    if (!omittedReadResults) return unchanged;
    const prepared = {...body, messages};
    // Recheck the complete body rather than relying solely on per-message deltas.
    return {
        body: prepared,
        beforeBytes,
        bytes: Buffer.byteLength(JSON.stringify(encode(prepared))),
        omittedReadResults
    };
}
