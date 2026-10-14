import { documentError, parsedDocument } from "./limits.js";
import type { DocumentUnit, ParsedDocument } from "./types.js";

export function parseText(bytes: Buffer, markdown: boolean): ParsedDocument {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return documentError("Text attachments must use valid UTF-8 encoding.");
	}
	if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) documentError("The text attachment contains unsupported binary control characters.");
	let heading: string | undefined;
	let headingLevel: number | undefined;
	let fence: string | undefined;
	const lines = text.split(/\r\n|\n|\r/);
	const units: DocumentUnit[] = lines.map((line, index) => {
		if (markdown) {
			const delimiter = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
			if (delimiter) {
				if (!fence) fence = delimiter;
				else if (delimiter[0] === fence[0] && delimiter.length >= fence.length) fence = undefined;
			} else if (!fence) {
				const match = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
				if (match) { heading = match[2]!; headingLevel = match[1]!.length; }
				else if (index > 0 && /^ {0,3}(?:={3,}|-{3,})\s*$/.test(line) && lines[index - 1]!.trim()) {
					heading = lines[index - 1]!.trim(); headingLevel = line.trim()[0] === "=" ? 1 : 2;
				}
			}
		}
		return {
			id: `line-${index + 1}`, text: line, provenance: "native-text",
			location: { kind: "line", line: index + 1, ...(heading !== undefined ? { heading, headingLevel: headingLevel! } : {}) },
		};
	});
	return parsedDocument(markdown ? "markdown" : "text", units, []);
}
