import { extname } from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import { HarnessError, checkCancellation } from "../errors.js";
import { documentLimits, parsedDocument } from "./limits.js";
import { documentParserVersion, type DocumentImage, type ParsedDocument } from "./types.js";

export { documentParserVersion };
export type { DocumentImage, DocumentLocation, DocumentUnit, ParsedDocument } from "./types.js";

interface ParserRequest {
	fatcatDocumentParser: true;
	mode: "parse" | "render";
	name: string;
	bytes: Uint8Array;
	pages: number[];
}

type ParserResponse = { ok: true; result: ParsedDocument | DocumentImage[] } | { ok: false; code: string; message: string };
let activeParsers = 0;

function validateInput(name: string, bytes: Buffer): void {
	if (!name || !bytes.length) throw new HarnessError("DOCUMENT_INVALID", "The document is empty or has no name.");
	if (bytes.length > documentLimits.originalBytes) throw new HarnessError("DOCUMENT_LIMIT", "The document exceeds the 16 MiB original-file limit.");
}

async function parseInWorker(request: ParserRequest): Promise<ParsedDocument | DocumentImage[]> {
	const bytes = Buffer.from(request.bytes);
	validateInput(request.name, bytes);
	const extension = extname(request.name).toLowerCase();
	if (request.mode === "render") {
		if (extension === ".pdf") return (await import("./pdf.js")).renderPdfPages(bytes, request.pages);
		if ([".png", ".jpg", ".jpeg"].includes(extension)) {
			if (request.pages.some((page) => page !== 1)) throw new HarnessError("INVALID_ARGUMENTS", "An image has only page 1.");
			return [await (await import("./images.js")).readImage(bytes, extension === ".png" ? "png" : "jpeg")];
		}
		throw new HarnessError("DOCUMENT_VISUAL_UNSUPPORTED", "Visual analysis supports PNG, JPEG, and selected PDF pages. Export Office charts or pages to one of those formats.");
	}
	if ([".md", ".markdown", ".txt", ".csv", ".tsv"].includes(extension)) return (await import("./text.js")).parseText(bytes, [".md", ".markdown"].includes(extension));
	if (extension === ".pdf") return (await import("./pdf.js")).parsePdf(bytes);
	if ([".docx", ".xlsx", ".pptx"].includes(extension)) return (await import("./ooxml.js")).parseOffice(extension.slice(1) as "docx" | "xlsx" | "pptx", bytes);
	if ([".png", ".jpg", ".jpeg"].includes(extension)) {
		const image = await (await import("./images.js")).readImage(bytes, extension === ".png" ? "png" : "jpeg");
		return parsedDocument(extension === ".png" ? "png" : "jpeg", [{ id: "image-1", text: "", location: { kind: "image", page: 1 }, provenance: "native-text" }], [`Image decoded (${image.width} x ${image.height} visual input). No native text is assumed; request visual analysis or transcription.`]);
	}
	throw new HarnessError("DOCUMENT_UNSUPPORTED", "Document analysis supports UTF-8 text/Markdown/CSV/TSV, PDF, DOCX, XLSX, PPTX, PNG, and JPEG. Legacy Office, macro-enabled files, and other image formats require conversion.");
}

function runParser(request: ParserRequest, signal?: AbortSignal): Promise<ParsedDocument | DocumentImage[]> {
	checkCancellation(signal);
	if (activeParsers >= 2) throw new HarnessError("DOCUMENT_BUSY", "Two document parsers are already active. Retry after one completes.");
	return new Promise((resolve, reject) => {
		const worker = new Worker(new URL(import.meta.url), { workerData: request, resourceLimits: { maxOldGenerationSizeMb: 256 } });
		activeParsers++;
		let finished = false;
		const finish = (error?: Error, result?: ParsedDocument | DocumentImage[]): void => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			const settled = (): void => {
				activeParsers--;
				if (error) reject(error);
				else resolve(result!);
			};
			void worker.terminate().then(settled, settled);
		};
		const abort = (): void => finish(new HarnessError("CANCELLED", "Document parsing cancelled."));
		const timer = setTimeout(() => finish(new HarnessError("DOCUMENT_TIMEOUT", "Document parsing exceeded its 30-second deadline.")), documentLimits.deadlineMs);
		signal?.addEventListener("abort", abort, { once: true });
		worker.once("message", (response: ParserResponse) => {
			if (response.ok) finish(undefined, response.result);
			else finish(new HarnessError(response.code, response.message));
		});
		worker.once("error", () => finish(new HarnessError("DOCUMENT_INVALID", "The document parser failed or exceeded its memory budget.")));
		worker.once("exit", () => { if (!finished) finish(new HarnessError("DOCUMENT_INVALID", "The document parser exited before producing a result.")); });
	});
}

export async function parseDocument(name: string, bytes: Buffer, signal?: AbortSignal): Promise<ParsedDocument> {
	validateInput(name, bytes);
	return await runParser({ fatcatDocumentParser: true, mode: "parse", name, bytes, pages: [] }, signal) as ParsedDocument;
}

export async function renderDocumentPages(name: string, bytes: Buffer, pages: number[], signal?: AbortSignal): Promise<DocumentImage[]> {
	validateInput(name, bytes);
	if (!pages.length || pages.length > documentLimits.renderPages || new Set(pages).size !== pages.length
		|| pages.some((page) => !Number.isSafeInteger(page) || page < 1 || page > documentLimits.pdfPages)) {
		throw new HarnessError("INVALID_ARGUMENTS", "Select one to four distinct page numbers between 1 and 200 for visual input.");
	}
	const images = await runParser({ fatcatDocumentParser: true, mode: "render", name, bytes, pages }, signal) as DocumentImage[];
	return images.map((image) => ({ ...image, data: Buffer.from(image.data) }));
}

if (!isMainThread && (workerData as Partial<ParserRequest> | undefined)?.fatcatDocumentParser) {
	try {
		parentPort!.postMessage({ ok: true, result: await parseInWorker(workerData as ParserRequest) } satisfies ParserResponse);
	} catch (error) {
		parentPort!.postMessage({ ok: false,
			code: error instanceof HarnessError ? error.code : "DOCUMENT_INVALID",
			message: error instanceof HarnessError ? error.message : "The document is corrupt or uses unsupported features.",
		} satisfies ParserResponse);
	}
}
