import { createHash } from "node:crypto";
import { extname } from "node:path";
import { HarnessError, checkCancellation } from "../errors.js";
import type { Tools, ToolTurnContext } from "../tools.js";
import type { ModelObservation } from "../model-types.js";
import type { DocumentVision } from "../documents/vision.js";
import { renderDocumentPages } from "../documents/parse.js";
import { failure } from "./types.js";

/** Reuse current model vision and task budgets; never persist inline image bytes in history. */
export function withImageRead(base: Tools, vision: DocumentVision, turn?: ToolTurnContext): Tools {
	if (!base.readImportFile) return base;
	const definition = { name: "image_read", description: "Inspect one local PNG/JPEG, including a browser screenshot, for a required question (max 2000 characters). Uses current workspace permissions; no URLs. Reads at most 16 MiB, validates/decodes in a bounded worker, resizes within 2048px/4M pixels. Calls the current chat model once using this task's auxiliary request allowance, reserving final delivery. Returns a fallible model description plus source SHA-256 and dimensions, not exact OCR or an immutable attachment citation. Image bytes stay out of saved history. Current image support: " + (vision.capability.supported ? "available." : "unavailable; select a supported model."),
		parameters: { type: "object", properties: { path: { type: "string", minLength: 1, maxLength: 1024 },
			question: { type: "string", minLength: 1, maxLength: 2000 } }, required: ["path", "question"], additionalProperties: false } };
	return { ...base, definitions: [...base.definitions, definition],
		forTurn: (onEvent, context) => withImageRead(base.forTurn?.(onEvent, context) ?? base, vision, context),
		async execute(name, json, signal, callId) {
			if (name !== "image_read") return base.execute(name, json, signal, callId);
			checkCancellation(signal);
			let args: unknown;
			try { args = JSON.parse(json); } catch { return failure("INVALID_ARGUMENTS", "Tool arguments must be valid JSON."); }
			if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).length !== 2
				|| !("path" in args) || typeof args.path !== "string" || !args.path.trim() || args.path.length > 1024
				|| !("question" in args) || typeof args.question !== "string" || !args.question.trim() || args.question.length > 2000
				|| Buffer.from(args.question).toString() !== args.question) return failure("INVALID_ARGUMENTS", "Use a local path and nonblank question up to 2000 characters.");
			try {
				if (!vision.capability.supported) throw new HarnessError("DOCUMENT_VISION_UNAVAILABLE", vision.capability.reason);
				if (!turn) throw new HarnessError("DOCUMENT_BUDGET", "Image reading requires an active budgeted task.");
				if (![".png", ".jpg", ".jpeg"].includes(extname(args.path).toLowerCase())) throw new HarnessError("UNSUPPORTED_FILE", "image_read supports PNG and JPEG only.");
				const original = await base.readImportFile!(args.path, signal);
				const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
				const sha256 = digest(original.bytes);
				const images = await renderDocumentPages(original.name, Buffer.from(original.bytes), [1], signal);
				const current = await base.readImportFile!(args.path, signal);
				if (digest(current.bytes) !== sha256) throw new HarnessError("IMAGE_CHANGED", "The image changed during decoding. Read it again.");
				let observe: ((event: ModelObservation) => void) | undefined;
				const result = await vision.analyze(images, { mode: "visual", question: args.question, ...(signal ? { signal } : {}),
					beforeRequest: () => { observe = turn.documentRequest(); }, observe: (event) => observe?.(event) });
				checkCancellation(signal);
				return { ok: true, result: { kind: "image", path: args.path, sha256, width: images[0]!.width, height: images[0]!.height,
					...result, notice: "Model interpretation of this captured version; the local file may change. No exact transcription is guaranteed." } };
			} catch (error) {
				checkCancellation(signal);
				if (error instanceof HarnessError) { if (error.code === "CANCELLED") throw error; return failure(error.code, error.message); }
				return failure("IMAGE_IO", "The local image could not be read or analyzed.");
			}
		} };
}
