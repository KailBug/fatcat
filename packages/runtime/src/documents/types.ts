export const documentParserVersion = "documents-v1";

export interface DocumentLocation {
	kind: "line" | "paragraph" | "page" | "cell" | "slide" | "image";
	line?: number;
	endLine?: number;
	page?: number;
	paragraph?: number;
	heading?: string;
	headingLevel?: number;
	sheet?: string;
	cell?: string;
	slide?: number;
	notes?: boolean;
	rawValue?: string;
	valueType?: string;
	formula?: string;
	cachedValue?: string;
	formulaStatus?: "not-calculated";
}

export interface DocumentUnit {
	id: string;
	text: string;
	location: DocumentLocation;
	provenance: "native-text";
}

export interface ParsedDocument {
	parserVersion: string;
	format: string;
	units: DocumentUnit[];
	totalUnits: number;
	warnings: string[];
}

export interface DocumentImage {
	data: Buffer;
	mimeType: "image/png" | "image/jpeg";
	page?: number;
	width: number;
	height: number;
}
