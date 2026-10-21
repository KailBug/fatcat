import type { Model, Message } from "./model-types.js";
import type { ModelSelection } from "./model-catalog.js";

export interface ModelRequestOptions {
	toolChoice: "auto" | "none";
	purpose?: "compaction" | "document";
	/** Preview of the next request excludes the unsent user turn. Never serialized. */
	completedHistory?: boolean;
}

export interface PreparedModelRequest {
	selection: ModelSelection;
	/** Exact serialized provider request, shared by preview and byte accounting. */
	json: string;
	bytes: number;
	beforeBytes: number;
	omittedReadResults: number;
	limitBytes: number;
}

/** Share request-only transforms without ever invoking the generation function for preview. */
export function mapModelMessages(model: Model, transform: (messages: Message[], signal?: AbortSignal) => Message[] | Promise<Message[]>,
	previewTransform = transform): Model {
	const wrapped: Model = async (messages, signal, observe, options
                            ) => model(await transform(messages, signal), signal, observe, options);
	if (model.prepare) {
		const prepare = model.prepare;
		wrapped.prepare = async (messages, signal, options
                            ) => prepare(await previewTransform(messages, signal), signal, options);
	}
	return wrapped;
}
