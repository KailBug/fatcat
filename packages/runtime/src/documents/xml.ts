import { createRequire } from "node:module";
import { documentError, documentLimit, documentLimits } from "./limits.js";

interface XmlParser {
	on(event: "doctype" | "error" | "closetag", callback: () => void): void;
	on(event: "text" | "cdata", callback: (value: string) => void): void;
	on(event: "opentag", callback: (tag: { name: string; attributes: Record<string, string> }) => void): void;
	write(value: string): XmlParser;
	close(): void;
}

// Saxes 6's published generic types do not support exactOptionalPropertyTypes.
// Keep its runtime boundary narrow instead of weakening project-wide checks.
const { SaxesParser } = createRequire(import.meta.url)("saxes") as {
	SaxesParser: new (options: { xmlns: false }) => XmlParser;
};

export interface XmlElement {
	name: string;
	attributes: Record<string, string>;
	children: XmlElement[];
	text: string;
}

export function parseXml(bytes: Buffer): XmlElement {
	if (bytes.length > documentLimits.xmlBytes) documentLimit("An Office XML part exceeds the 8 MiB limit.");
	let source: string;
	try {
		source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return documentError("Office XML must use valid UTF-8 encoding.");
	}
	const root: XmlElement = { name: "", attributes: {}, children: [], text: "" };
	const stack = [root];
	let count = 0;
	const parser = new SaxesParser({ xmlns: false });
	parser.on("doctype", () => documentError("XML document types and external entities are not supported."));
	parser.on("error", () => documentError("The Office XML is malformed."));
	parser.on("opentag", (tag) => {
		if (++count > documentLimits.xmlNodes || stack.length > documentLimits.xmlDepth) documentLimit("The Office XML exceeds its node or depth limit.");
		const element: XmlElement = { name: tag.name, attributes: tag.attributes, children: [], text: "" };
		stack.at(-1)!.children.push(element);
		stack.push(element);
	});
	parser.on("text", (value) => { stack.at(-1)!.text += value; });
	parser.on("cdata", (value) => { stack.at(-1)!.text += value; });
	parser.on("closetag", () => { stack.pop(); });
	parser.write(source).close();
	if (root.children.length !== 1) documentError("The Office XML has no unique document element.");
	return root.children[0]!;
}

export function localName(element: XmlElement): string {
	return element.name.split(":").at(-1)!;
}

export function children(element: XmlElement, name: string): XmlElement[] {
	return element.children.filter((child) => localName(child) === name);
}

export function descendants(element: XmlElement, name: string): XmlElement[] {
	const found: XmlElement[] = [];
	const visit = (node: XmlElement): void => {
		if (localName(node) === name) found.push(node);
		for (const child of node.children) visit(child);
	};
	visit(element);
	return found;
}

export function attribute(element: XmlElement | undefined, name: string): string | undefined {
	if (!element) return undefined;
	return Object.entries(element.attributes).find(([key]) => key.split(":").at(-1) === name)?.[1];
}
