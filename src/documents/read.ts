import { extname } from "node:path";
import { HarnessError, checkCancellation } from "../errors.js";
import { attachmentPage, attachmentReadOptions, readAttachmentContent } from "../attachments/read.js";
import type { AttachmentReadOptions, AttachmentReadResult } from "../attachments/read.js";
import { attachmentReference } from "../attachments/record.js";
import type { AttachmentInfo } from "../attachments/record.js";
import type { ModelObservation } from "../model.js";
import type { ToolTurnContext } from "../tools.js";
import { derivedSnapshot, documentSnapshot, splitSourceText } from "./cache.js";
import type { DocumentCache, DocumentSnapshot, SourceUnit } from "./cache.js";
import { parseDocument, renderDocumentPages } from "./parse.js";
import { documentParserVersion } from "./types.js";
import type { DocumentVision } from "./vision.js";

export interface DocumentReadResult {
	kind: "document";
	path: string;
	name: string;
	parserVersion: string;
	format: string;
	units: Array<SourceUnit & { citation: string }>;
	offset: number;
	totalUnits: number;
	selectedUnits: number;
	truncated: boolean;
	nextOffset: number | null;
	coverage: { mode: "document" | "literal-search" | "visual" | "transcribe"; complete: boolean;
		returnedUnits: number; selectedUnits: number; totalUnits: number; unreadUnits: number; uncovered: string[] };
	warnings: string[];
	query?: string;
}

export function documentCitation(reference: string, version: string, id: string): string {
	return `${reference}#parse=${encodeURIComponent(version)}&unit=${encodeURIComponent(id)}`;
}

function matchesScope(unit: SourceUnit, options: AttachmentReadOptions): boolean {
	return (options.unit === undefined || unit.id === options.unit)
		&& (options.pages === undefined || options.pages.includes(unit.location.page ?? unit.location.slide ?? 0))
		&& (options.sheet === undefined || unit.location.sheet === options.sheet)
		&& (options.section === undefined || unit.location.heading === options.section);
}

function pageResult(record: AttachmentInfo, document: DocumentSnapshot, options: AttachmentReadOptions,
	mode: DocumentReadResult["coverage"]["mode"] = "document", uncovered: string[] = []): DocumentReadResult {
	const { offset, limit, query } = attachmentReadOptions(options);
	const path = attachmentReference(record);
	if (options.pages?.some((page) => !document.units.some((unit) => (unit.location.page ?? unit.location.slide) === page))) {
		throw new HarnessError("DOCUMENT_LOCATION", "At least one selected page or slide is absent in this parse. Word and Excel do not have inferred page numbers.");
	}
	const scope = document.units.filter((unit) => matchesScope(unit, options));
	if (!scope.length && (options.unit !== undefined || options.pages !== undefined || options.sheet !== undefined || options.section !== undefined)) {
		throw new HarnessError("DOCUMENT_LOCATION", "The requested source location does not exist in this parse version.");
	}
	const selected = query === undefined ? scope : scope.filter((unit) => unit.text.includes(query));
	const entries = selected.map((unit) => ({ ...unit, citation: documentCitation(path, document.parserVersion, unit.id) }));
	const page = attachmentPage(entries, offset, limit, (entry) => Buffer.byteLength(JSON.stringify(entry)) + 1);
	const missing = scope.filter((unit) => (!unit.text.trim() && ["page", "image", "slide"].includes(unit.location.kind)) || unit.provenance !== "native-text").map((unit) =>
		!unit.text.trim() ? `No extracted text at ${unit.id}; visual inspection may be needed.` : `${unit.id} is model-generated and may contain omissions or recognition errors.`);
	const unreadUnits = Math.max(0, scope.length - page.items.length);
	return { kind: "document", path, name: record.name, parserVersion: document.parserVersion, format: document.format,
		units: page.items, offset, totalUnits: document.totalUnits, selectedUnits: selected.length,
		truncated: page.truncated, nextOffset: page.nextOffset,
		coverage: { mode: query === undefined ? mode : "literal-search", complete: query === undefined && offset === 0 && !page.truncated
			&& !missing.length && !uncovered.length && !document.warnings.length && mode === "document",
			returnedUnits: page.items.length, selectedUnits: scope.length, totalUnits: document.totalUnits, unreadUnits,
			uncovered: [...uncovered, ...missing].slice(0, 200) }, warnings: document.warnings,
		...(query === undefined ? {} : { query }) };
}

/** Keep full model responses in the versioned cache while returning bounded, resumable units. */
function recognizedUnits(text: string, page: number, mode: "visual" | "transcribe", model: string, provider: string): SourceUnit[] {
	const pieces = splitSourceText(text);
	return pieces.map((value, index) => ({ id: `${mode}-${page}-${index + 1}`, text: value,
		location: { kind: "page", page }, provenance: mode === "transcribe" ? "model-transcription" : "model-description", model, provider }));
}

export async function readDocumentContent(record: AttachmentInfo, bytes: Uint8Array, options: AttachmentReadOptions,
	cache: DocumentCache, signal?: AbortSignal, vision?: DocumentVision, turn?: ToolTurnContext): Promise<AttachmentReadResult> {
	checkCancellation(signal);
	const checked = attachmentReadOptions(options);
	const extension = extname(record.name).toLowerCase();
	if ([".txt", ".md", ".markdown"].includes(extension) && checked.parserVersion === undefined && checked.section === undefined
		&& checked.unit === undefined && checked.pages === undefined && checked.sheet === undefined && (checked.mode ?? "text") === "text") {
		return readAttachmentContent(record, bytes, checked, signal);
	}
	if (checked.parserVersion !== undefined) {
		const saved = await cache.load(checked.parserVersion);
		if (!saved) throw new HarnessError("DOCUMENT_VERSION_UNAVAILABLE", "This exact parse version is unavailable. The citation has not been redirected to newer content.");
		checkCancellation(signal);
		return pageResult(record, saved, checked);
	}
	let native = await cache.load(documentParserVersion);
	if (!native) {
		native = documentSnapshot(await parseDocument(record.name, Buffer.from(bytes), signal));
		checkCancellation(signal);
		native = await cache.save(native);
	}
	if (checked.mode === "visual" || checked.mode === "transcribe") {
		if (!vision?.capability.supported) throw new HarnessError("DOCUMENT_VISION_UNAVAILABLE", vision?.capability.reason
			?? "Image understanding requires a supported current chat model and an executing task. Native document text remains available.");
		if (!turn) throw new HarnessError("DOCUMENT_BUDGET", "Visual reading is available only inside a budgeted task, never from a source preview.");
		const pages = checked.pages ?? (["image", "png", "jpeg"].includes(native.format) ? [1] : undefined);
		if (!pages?.length || pages.length > 4) throw new HarnessError("DOCUMENT_LOCATION", "Select one to four explicit page numbers for visual reading. Read native text first to inspect document scope.");
		const units: SourceUnit[] = [];
		const uncovered: string[] = [];
		for (const page of pages) {
			checkCancellation(signal);
			try {
				// Authorization is refreshed before external transmission and again before cache publication.
				await cache.load(documentParserVersion);
				const images = await renderDocumentPages(record.name, Buffer.from(bytes), [page], signal);
				await cache.load(documentParserVersion);
				let observe: ((event: ModelObservation) => void) | undefined;
				const result = await vision.analyze(images, { mode: checked.mode,
					...(checked.question === undefined ? {} : { question: checked.question }), ...(signal ? { signal } : {}),
					beforeRequest: () => { observe = turn.documentRequest(); }, observe: (event) => observe?.(event) });
				checkCancellation(signal);
				const recognized = recognizedUnits(result.text, page, checked.mode, result.model, result.provider);
				const snapshot = derivedSnapshot(native, recognized, ["Model-generated content is not exact original text; verify details against the original page. No character bounding boxes or confidence scores are available."]);
				await cache.save(snapshot, checked.mode === "transcribe" ? page : undefined);
				units.push(...recognized);
			} catch (error) {
				checkCancellation(signal);
				if (!units.length) throw error;
				uncovered.push(`Page ${page}: ${error instanceof HarnessError ? `${error.code}: ${error.message}` : "Document processing failed."}`);
			}
		}
		const snapshot = await cache.save(derivedSnapshot(native, units, [
			`Requested pages: ${pages.join(", ")}. Successful source units identify completed coverage. Other pages and embedded Office objects were not inspected.`,
			checked.mode === "visual" ? "This is a model description, not a complete transcription." : "Model transcription can omit or misread text; verify against original pages.",
			...uncovered,
		]));
		return pageResult(record, snapshot, { offset: checked.offset, limit: checked.limit }, checked.mode, uncovered);
	}
	const baseVersion = native.baseParserVersion;
	const transcripts = (await cache.transcripts()).filter((item) => item.baseParserVersion === baseVersion);
	if (transcripts.length) {
		const units = [...native.units.filter((unit) => unit.text.trim() || !transcripts.some((item) => item.units.some((other) => other.location.page === unit.location.page))),
			...transcripts.flatMap((item) => item.units)];
		native = await cache.save(derivedSnapshot(native, units, [...native.warnings, "Cached model transcriptions are included with their provenance; they are not native text."]));
	}
	checkCancellation(signal);
	return pageResult(record, native, checked);
}
