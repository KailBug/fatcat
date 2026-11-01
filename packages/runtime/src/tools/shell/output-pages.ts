import { outputChunks } from "./output-files.js";
import type { OutputFile } from "./output-files.js";

export function truncateShellOutputPreview(text: string, maxBytes = 8000): string {
	let bytes = 0;
	let end = 0;
	for (const char of text) {
		bytes += Buffer.byteLength(JSON.stringify(char)) - 2;
		if (bytes > maxBytes) break;
		end += char.length;
	}
	return text.slice(0, end);
}

export async function readOutputPage(file: OutputFile | undefined, offset: number, limit: number, tail: boolean, signal?: AbortSignal) {
	let total = 0;
	let selected: string[] = [];
	for await (const chunk of outputChunks(file, signal)) {
		const chars = Array.from(chunk);
		if (tail) selected = [...selected, ...chars].slice(-limit);
		else if (total + chars.length > offset && total < offset + limit) {
			selected.push(...chars.slice(Math.max(0, offset - total), Math.max(0, offset + limit - total)));
		}
		total += chars.length;
	}
	const content = tail ? Array.from(truncateShellOutputPreview(selected.reverse().join(""), 12000)).reverse().join("")
		: truncateShellOutputPreview(selected.join(""), 12000);
	const length = Array.from(content).length;
	const start = tail ? total - length : Math.min(offset, total);
	const end = start + length;
	return { content, offset: start, totalCharacters: total, truncated: start > 0 || end < total, nextOffset: end < total ? end : null };
}

export async function searchOutputPage(file: OutputFile | undefined, query: string, offset: number, limit: number, signal?: AbortSignal) {
	const matches: { line: number; text: string; characterOffset: number; textTruncated: boolean }[] = [];
	let totalMatches = 0, position = 0, start = 0, line = 1, lineLength = 0, bytes = 2;
	let prefix = "", overlap = "", matched = false, full = false, afterCR = false;
	function flush() {
		if (matched) {
			const index = totalMatches++;
			if (index >= offset && !full) {
				const match = { line, text: prefix, characterOffset: start, textTruncated: Array.from(prefix).length < lineLength };
				const size = Buffer.byteLength(JSON.stringify(match)) + 1;
				if (bytes + size > 12000 || matches.length >= limit) full = true;
				else { matches.push(match); bytes += size; }
			}
		}
		prefix = ""; overlap = ""; matched = false; lineLength = 0; line++;
	}
	for await (const chunk of outputChunks(file, signal)) {
		for (const part of chunk.matchAll(/[^\r\n]+|\r\n|\r|\n/g)) {
			let text = part[0];
			if (afterCR && text.startsWith("\n")) { position++; start++; text = text.slice(1); }
			afterCR = false;
			if (!text) continue;
			const length = Array.from(text).length;
			position += length;
			if (text[0] === "\r" || text[0] === "\n") {
				flush(); start = position; afterCR = text === "\r";
			} else {
				matched ||= (overlap + text).includes(query);
				overlap = (overlap + text).slice(-Math.max(0, query.length - 1));
				if (query.length === 1) overlap = "";
				prefix = truncateShellOutputPreview(prefix + text, 4000);
				lineLength += length;
			}
		}
	}
	if (lineLength) flush();
	const end = Math.min(offset, totalMatches) + matches.length;
	return { matches, offset, totalMatches, truncated: end < totalMatches, nextOffset: end < totalMatches ? end : null };
}
