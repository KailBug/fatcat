import { HarnessError } from "../errors.js";
import { documentParserVersion, type DocumentUnit, type ParsedDocument } from "./types.js";

export const documentLimits = {
	originalBytes: 16 * 1024 * 1024,
	expandedBytes: 32 * 1024 * 1024,
	xmlBytes: 8 * 1024 * 1024,
	textBytes: 4 * 1024 * 1024,
	units: 20_000,
	zipEntries: 2_000,
	xmlNodes: 200_000,
	xmlDepth: 128,
	pdfPages: 200,
	renderPages: 4,
	imagePixels: 16_000_000,
	renderPixels: 4_000_000,
	renderSide: 2_048,
	renderBytes: 8 * 1024 * 1024,
	deadlineMs: 30_000,
} as const;

export function documentError(message: string): never {
	throw new HarnessError("DOCUMENT_INVALID", message);
}

export function documentLimit(message: string): never {
	throw new HarnessError("DOCUMENT_LIMIT", message);
}

export function parsedDocument(format: string, units: DocumentUnit[], warnings: string[]): ParsedDocument {
	if (units.length > documentLimits.units) documentLimit("The document exceeds the 20000-unit parsing limit.");
	let bytes = 0;
	for (const unit of units) {
		bytes += Buffer.byteLength(unit.text, "utf8") + Buffer.byteLength(JSON.stringify(unit.location), "utf8");
		if (bytes > documentLimits.textBytes) documentLimit("The parsed document exceeds the 4 MiB text and location limit.");
	}
	return { parserVersion: documentParserVersion, format, units, totalUnits: units.length, warnings };
}
