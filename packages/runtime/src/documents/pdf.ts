import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { getDocument, type PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";
import { HarnessError } from "../errors.js";
import { documentError, documentLimit, documentLimits, parsedDocument } from "./limits.js";
import type { DocumentImage, DocumentUnit, ParsedDocument } from "./types.js";

const pdfRoot = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));

function resourcePath(directory: string): string {
	return join(pdfRoot, directory).replaceAll("\\", "/") + "/";
}

async function withPdf<T>(bytes: Buffer, operation: (document: PDFDocumentProxy) => Promise<T>): Promise<T> {
	if (!bytes.subarray(0, 1024).includes(Buffer.from("%PDF-"))) documentError("The PDF header is missing.");
	const loading = getDocument({
		data: new Uint8Array(bytes), verbosity: 0, stopAtErrors: true,
		cMapUrl: resourcePath("cmaps"), cMapPacked: true,
		standardFontDataUrl: resourcePath("standard_fonts"),
		wasmUrl: resourcePath("wasm"),
		useWorkerFetch: false, useSystemFonts: false, disableFontFace: true,
		maxImageSize: documentLimits.imagePixels, canvasMaxAreaInBytes: documentLimits.renderPixels * 4,
		enableXfa: false,
	});
	try {
		const document = await loading.promise;
		if (document.numPages > documentLimits.pdfPages) documentLimit("The PDF exceeds the 200-page parsing limit.");
		const metadata = await document.getMetadata();
		const info = metadata.info as { EncryptFilterName?: string | null; IsXFAPresent?: boolean };
		if (info.EncryptFilterName) documentError("Encrypted PDFs are not supported. Export an unencrypted copy before importing.");
		if (info.IsXFAPresent) documentError("XFA form PDFs are not supported. Export flattened pages before importing.");
		return await operation(document);
	} catch (error) {
		if (error instanceof HarnessError) throw error;
		if (error instanceof Error && error.name === "PasswordException") documentError("Encrypted PDFs are not supported. Export an unencrypted copy before importing.");
		return documentError("The PDF could not be parsed or rendered. It may be corrupt, encrypted, or use unsupported features.");
	} finally {
		await loading.destroy();
	}
}

export async function parsePdf(bytes: Buffer): Promise<ParsedDocument> {
	return withPdf(bytes, async (document) => {
		const units: DocumentUnit[] = [];
		const emptyPages: number[] = [];
		let textBytes = 0;
		for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber++) {
			const page = await document.getPage(pageNumber);
			const content = await page.getTextContent();
			let text = "";
			for (const item of content.items) {
				if (!("str" in item)) continue;
				text += item.str + (item.hasEOL ? "\n" : " ");
			}
			text = text.trimEnd();
			textBytes += Buffer.byteLength(text, "utf8");
			if (textBytes > documentLimits.textBytes) documentLimit("The extracted PDF text exceeds the 4 MiB limit.");
			if (!text.trim()) emptyPages.push(pageNumber);
			units.push({ id: `page-${pageNumber}`, text, location: { kind: "page", page: pageNumber }, provenance: "native-text" });
			page.cleanup();
		}
		const warnings = ["PDF text extraction preserves page numbers, not visual reading order, tables, diagrams, or coverage of all visible content. Use visual analysis for figures and layout."];
		if (emptyPages.length) warnings.push(`Pages with no extractable native text (visual analysis may be needed): ${emptyPages.join(", ")}. These pages are not treated as empty documents.`);
		return parsedDocument("pdf", units, warnings);
	});
}

export async function renderPdfPages(bytes: Buffer, pages: number[]): Promise<DocumentImage[]> {
	return withPdf(bytes, async (document) => {
		const images: DocumentImage[] = [];
		let renderedBytes = 0;
		for (const pageNumber of pages) {
			if (pageNumber > document.numPages) throw new HarnessError("INVALID_ARGUMENTS", `PDF page ${pageNumber} is outside the document's ${document.numPages} pages.`);
			const page = await document.getPage(pageNumber);
			const original = page.getViewport({ scale: 1 });
			if (!Number.isFinite(original.width) || !Number.isFinite(original.height) || original.width <= 0 || original.height <= 0) documentError("The PDF page dimensions are invalid.");
			const scale = Math.min(2, documentLimits.renderSide / Math.max(original.width, original.height), Math.sqrt(documentLimits.renderPixels / (original.width * original.height)));
			const viewport = page.getViewport({ scale });
			const width = Math.max(1, Math.floor(viewport.width));
			const height = Math.max(1, Math.floor(viewport.height));
			const canvas = createCanvas(width, height);
			await page.render({ canvas: null, canvasContext: canvas.getContext("2d") as unknown as CanvasRenderingContext2D, viewport, background: "white" }).promise;
			const data = canvas.toBuffer("image/png");
			renderedBytes += data.length;
			if (renderedBytes > documentLimits.renderBytes) documentLimit("The rendered PDF pages exceed the 8 MiB image budget. Select fewer pages.");
			images.push({ data, mimeType: "image/png", page: pageNumber, width, height });
			page.cleanup();
		}
		return images;
	});
}
