import { extname } from "node:path";
import { setImmediate } from "node:timers/promises";
import { HarnessError, checkCancellation } from "../errors.js";
import { attachmentReference, maxAttachmentBytes } from "./record.js";
import type { AttachmentInfo } from "./record.js";

export interface AttachmentReadOptions {
	offset?: number;
	limit?: number;
	query?: string;
}

export type AttachmentReadResult = {
	kind: "file";
	path: string;
	name: string;
	citation: string;
	offset: number;
	totalLines: number;
	startLine: number | null;
	endLine: number | null;
	content: string;
	truncated: boolean;
	nextOffset: number | null;
	coverage: { mode: "lines"; complete: boolean };
} | {
	kind: "search";
	path: string;
	name: string;
	query: string;
	offset: number;
	totalMatches: number;
	totalLines: number;
	matches: { path: string; line: number; text: string; citation: string }[];
	truncated: boolean;
	nextOffset: number | null;
	scannedFiles: number;
	skippedFiles: number;
	complete: boolean;
	coverage: { mode: "literal-search"; complete: boolean };
};

export const attachmentPageBytes = 16 * 1024;
const textExtensions = new Set([".md", ".markdown", ".txt"]);

export function attachmentReadOptions(options: AttachmentReadOptions): Required<Pick<AttachmentReadOptions, "offset" | "limit">> & Pick<AttachmentReadOptions, "query"> {
	const offset = options.offset === undefined ? 0 : options.offset;
	const limit = options.limit === undefined ? 100 : options.limit;
	if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0
		|| typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
		throw new HarnessError("INVALID_ARGUMENTS", "offset must be a non-negative safe integer; limit must be an integer from 1 to 200.");
	}
	if (options.query !== undefined && (typeof options.query !== "string" || !options.query.trim() || options.query.length > 512
		|| /[\x00-\x08\x0a-\x1f\x7f-\x9f]/.test(options.query)
		|| Buffer.from(options.query, "utf8").toString("utf8") !== options.query)) {
		throw new HarnessError("INVALID_ARGUMENTS", "query must be a non-blank, well-formed single-line literal containing at most 512 characters.");
	}
	return { offset, limit, ...(options.query !== undefined ? { query: options.query } : {}) };
}

/** Keep complete items so following nextOffset never skips hidden text. */
export function attachmentPage<T>(items: readonly T[], offset: number, limit: number, sizeOf: (item: T) => number,
	signal?: AbortSignal): { items: T[]; truncated: boolean; nextOffset: number | null } {
	const selected: T[] = [];
	let bytes = 0;
	let end = Math.min(offset, items.length);
	while (end < items.length && selected.length < limit) {
		checkCancellation(signal);
		const item = items[end]!;
		const size = sizeOf(item);
		if (bytes + size > attachmentPageBytes) {
			if (!selected.length) throw new HarnessError("OUTPUT_LIMIT", "One attachment line or entry exceeds the 16384-byte page budget; it cannot be returned partially.");
			break;
		}
		selected.push(item);
		bytes += size;
		end++;
	}
	return { items: selected, truncated: end < items.length, nextOffset: end < items.length ? end : null };
}

/** Decode originals only; document parsing and model-generated descriptions have separate future owners. */
export async function readAttachmentContent(record: AttachmentInfo, bytes: Uint8Array, options: AttachmentReadOptions = {},
	signal?: AbortSignal): Promise<AttachmentReadResult> {
	checkCancellation(signal);
	const { offset, limit, query } = attachmentReadOptions(options);
	if (!textExtensions.has(extname(record.name).toLowerCase())) {
		throw new HarnessError("ATTACHMENT_UNSUPPORTED", "This original is saved, but content reading currently supports only UTF-8 .md, .markdown, and .txt files. Document parsing and image analysis are not available yet.");
	}
	if (bytes.byteLength > maxAttachmentBytes) throw new HarnessError("FILE_TOO_LARGE", "Attachment text must not exceed 16777216 bytes.");
	let content: string;
	try {
		content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
		if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content)) throw new Error();
	} catch {
		throw new HarnessError("ATTACHMENT_UNSUPPORTED", "The original is saved, but it is not valid UTF-8 text without binary control bytes.");
	}
	const path = attachmentReference(record);
	const lines: string[] = [];
	const matches: { path: string; line: number; text: string; citation: string }[] = [];
	let totalLines = 0;
	let totalMatches = 0;
	let pageBytes = 0;
	let pageFull = false;
	for (const item of content.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
		if (!item[0]) continue;
		if (totalLines % 4096 === 0) await setImmediate();
		checkCancellation(signal);
		totalLines++;
		const text = item[0].replace(/(?:\r\n|\r|\n)$/, "");
		if (query !== undefined && !text.includes(query)) continue;
		const index = query === undefined ? totalLines - 1 : totalMatches++;
		if (index < offset || pageFull) continue;
		const match = { path, line: totalLines, text, citation: `${path}#L${totalLines}-L${totalLines}` };
		const size = query === undefined ? Buffer.byteLength(item[0]) : Buffer.byteLength(JSON.stringify(match)) + 1;
		if (pageBytes + size > attachmentPageBytes) {
			if (!(lines.length || matches.length)) throw new HarnessError("OUTPUT_LIMIT", "One attachment line or match exceeds the 16384-byte page budget; it cannot be returned partially.");
			pageFull = true;
			continue;
		}
		if (query === undefined) lines.push(item[0]);
		else matches.push(match);
		pageBytes += size;
		pageFull = lines.length + matches.length === limit;
	}
	checkCancellation(signal);
	if (query !== undefined) {
		const end = Math.min(offset, totalMatches) + matches.length;
		return { kind: "search", path, name: record.name, query, offset, totalLines, totalMatches, matches,
			truncated: end < totalMatches, nextOffset: end < totalMatches ? end : null,
			scannedFiles: 1, skippedFiles: 0, complete: true, coverage: { mode: "literal-search", complete: true } };
	}
	const end = Math.min(offset, totalLines) + lines.length;
	return { kind: "file", path, name: record.name, citation: lines.length ? `${path}#L${offset + 1}-L${offset + lines.length}` : path,
		offset, totalLines, startLine: lines.length ? offset + 1 : null,
		endLine: lines.length ? offset + lines.length : null, content: lines.join(""),
		truncated: end < totalLines, nextOffset: end < totalLines ? end : null,
		coverage: { mode: "lines", complete: offset === 0 && end === totalLines } };
}
