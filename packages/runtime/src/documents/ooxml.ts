import { posix } from "node:path";
import { DocumentArchive } from "./archive.js";
import { documentError, documentLimit, documentLimits, parsedDocument } from "./limits.js";
import type { DocumentLocation, DocumentUnit, ParsedDocument } from "./types.js";
import { attribute, children, descendants, localName, parseXml, type XmlElement } from "./xml.js";

interface Relationship {
	id: string;
	type: string;
	target: string;
	external: boolean;
}

function relationships(archive: DocumentArchive, part: string): Relationship[] {
	const file = posix.join(posix.dirname(part), "_rels", `${posix.basename(part)}.rels`);
	if (!archive.has(file)) return [];
	return children(parseXml(archive.read(file)), "Relationship").map((element) => {
		const id = attribute(element, "Id");
		const target = attribute(element, "Target");
		const type = attribute(element, "Type");
		if (!id || !target || !type) documentError("An Office relationship is incomplete.");
		const external = attribute(element, "TargetMode") === "External";
		const normalized = target.startsWith("/") ? posix.normalize(target.slice(1)) : posix.join(posix.dirname(part), target);
		if (!external && (normalized.startsWith("../") || normalized.includes("\\") || normalized.includes(":"))) {
			documentError("An Office relationship points outside its package.");
		}
		return { id, type, target: normalized, external };
	});
}

function resolvePart(relations: Relationship[], id: string | undefined): string {
	const relation = relations.find((item) => item.id === id);
	if (!relation || relation.external) documentError("A required Office relationship is missing or external.");
	return relation.target;
}

function paragraphText(paragraph: XmlElement): string {
	let result = "";
	const visit = (node: XmlElement): void => {
		const name = localName(node);
		if (name === "del" || name === "moveFrom" || name === "instrText") return;
		if (name === "t") { result += node.text; return; }
		if (name === "tab") result += "\t";
		if (name === "br" || name === "cr") result += "\n";
		for (const child of node.children) visit(child);
	};
	visit(paragraph);
	return result;
}

function addUnit(units: DocumentUnit[], text: string, location: DocumentLocation, id: string): void {
	if (units.length >= documentLimits.units) documentLimit("The document exceeds the 20000-unit parsing limit.");
	units.push({ id, text, location, provenance: "native-text" });
}

function parseWord(archive: DocumentArchive): ParsedDocument {
	const root = parseXml(archive.read("word/document.xml"));
	if (localName(root) !== "document") documentError("The Word document body is invalid.");
	const body = children(root, "body")[0];
	if (!body) documentError("The Word document has no body.");
	const styles = new Map<string, { name: string; level?: number }>();
	if (archive.has("word/styles.xml")) {
		for (const style of children(parseXml(archive.read("word/styles.xml")), "style")) {
			const id = attribute(style, "styleId");
			const name = attribute(children(style, "name")[0], "val") ?? id;
			const outline = attribute(descendants(style, "outlineLvl")[0], "val");
			const heading = /heading\s*([1-9])/i.exec(name ?? "");
			const level = outline !== undefined ? Number(outline) + 1 : heading ? Number(heading[1]) : undefined;
			if (id && name) styles.set(id, { name, ...(level !== undefined && level > 0 && level <= 9 ? { level } : {}) });
		}
	}
	const units: DocumentUnit[] = [];
	let heading: string | undefined;
	let headingLevel: number | undefined;
	for (const [index, paragraph] of descendants(body, "p").entries()) {
		const text = paragraphText(paragraph);
		const styleId = attribute(descendants(paragraph, "pStyle")[0], "val");
		const outline = attribute(descendants(paragraph, "outlineLvl")[0], "val");
		const directHeading = /^heading\s*([1-9])$/i.exec(styleId ?? "");
		const level = outline !== undefined ? Number(outline) + 1 : styles.get(styleId ?? "")?.level ?? (directHeading ? Number(directHeading[1]) : undefined);
		if (level !== undefined && level >= 1 && level <= 9 && text.trim()) { heading = text; headingLevel = level; }
		addUnit(units, text, { kind: "paragraph", paragraph: index + 1,
			...(heading !== undefined ? { heading, headingLevel: headingLevel! } : {}) }, `paragraph-${index + 1}`);
	}
	const warnings = ["Word locations identify body paragraphs, including table-cell paragraphs; page numbers and visual layout are not inferred."];
	if (descendants(body, "drawing").length || descendants(body, "pict").length) warnings.push("Embedded images, charts, and drawing objects are not described by native text extraction. Export relevant pages as PDF or images for visual analysis.");
	if (archive.names().some((name) => /^word\/(header|footer|footnotes|endnotes|comments)/.test(name))) {
		warnings.push("Headers, footers, footnotes, endnotes, and comments are outside this body-text extraction.");
	}
	if (descendants(body, "del").length || descendants(body, "moveFrom").length) warnings.push("Deleted and moved-from tracked-change text is excluded; inserted text is included. This is not a revision comparison.");
	return parsedDocument("docx", units, warnings);
}

function richText(element: XmlElement | undefined): string {
	return element ? descendants(element, "t").map((node) => node.text).join("") : "";
}

function parseWorkbook(archive: DocumentArchive): ParsedDocument {
	const part = "xl/workbook.xml";
	const workbook = parseXml(archive.read(part));
	if (localName(workbook) !== "workbook") documentError("The Excel workbook is invalid.");
	const relations = relationships(archive, part);
	const stringPart = relations.find((item) => item.type.endsWith("/sharedStrings") && !item.external)?.target;
	const strings = stringPart ? children(parseXml(archive.read(stringPart)), "si").map(richText) : [];
	const units: DocumentUnit[] = [];
	const warnings = ["Excel values are stored raw values. Number/date formatting is not applied, formulas are not recalculated, and cached formula results are unverified. Verify calculations against the relevant complete cell ranges."];
	if (archive.names().some((name) => /^xl\/(charts|drawings|externalLinks)\//.test(name))) warnings.push("Charts, drawing objects, and external linked workbooks are not evaluated. Export charts as PDF or images for visual analysis.");
	for (const sheet of descendants(workbook, "sheet")) {
		const name = attribute(sheet, "name");
		if (!name) documentError("An Excel worksheet has no name.");
		const sheetPart = resolvePart(relations, attribute(sheet, "id"));
		const root = parseXml(archive.read(sheetPart));
		if (localName(root) !== "worksheet") { warnings.push(`Sheet ${name} is not a cell worksheet and was not extracted.`); continue; }
		if (attribute(sheet, "state") && attribute(sheet, "state") !== "visible") warnings.push(`Hidden sheet ${name} is included in native extraction.`);
		if (descendants(root, "mergeCell").length) warnings.push(`Sheet ${name} has merged cells; values are retained at their stored anchor addresses.`);
		const addresses = new Set<string>();
		for (const cell of descendants(root, "c")) {
			const address = attribute(cell, "r");
			if (!address || !/^[A-Z]{1,3}[1-9][0-9]{0,6}$/.test(address) || addresses.has(address)) documentError("An Excel cell address is missing, invalid, or repeated.");
			addresses.add(address);
			const valueType = attribute(cell, "t") ?? "n";
			const value = children(cell, "v")[0]?.text;
			const formulaNode = children(cell, "f")[0];
			const formula = formulaNode?.text;
			let displayed = value ?? "";
			if (valueType === "s") {
				const index = Number(value);
				if (value === undefined || !/^\d+$/.test(value) || !Number.isSafeInteger(index) || index >= strings.length) documentError("An Excel shared-string reference is invalid.");
				displayed = strings[index]!;
			} else if (valueType === "inlineStr") displayed = richText(children(cell, "is")[0]);
			const formulaDescription = formulaNode ? (formula || `[${attribute(formulaNode, "t") ?? "shared"} formula without a local expression]`) : undefined;
			const text = formulaDescription !== undefined
				? `${address}: formula =${formulaDescription}; cached result (unverified): ${value ?? "not stored"}`
				: `${address}: ${displayed}`;
			addUnit(units, text, { kind: "cell", sheet: name, cell: address, valueType,
				...(value !== undefined ? { rawValue: value } : valueType === "inlineStr" ? { rawValue: displayed } : {}),
				...(formulaDescription !== undefined ? { formula: formulaDescription, formulaStatus: "not-calculated", ...(value !== undefined ? { cachedValue: value } : {}) } : {}) },
				`sheet-${units.length + 1}-${address}`);
		}
	}
	return parsedDocument("xlsx", units, warnings);
}

function parsePresentation(archive: DocumentArchive): ParsedDocument {
	const part = "ppt/presentation.xml";
	const presentation = parseXml(archive.read(part));
	if (localName(presentation) !== "presentation") documentError("The PowerPoint presentation is invalid.");
	const relations = relationships(archive, part);
	const units: DocumentUnit[] = [];
	let slide = 0;
	for (const slideId of descendants(presentation, "sldId")) {
		slide++;
		const id = slideId.attributes["r:id"] ?? Object.entries(slideId.attributes).find(([key]) => key.includes(":") && key.endsWith(":id"))?.[1];
		const slidePart = resolvePart(relations, id);
		const root = parseXml(archive.read(slidePart));
		if (localName(root) !== "sld") documentError("A PowerPoint slide is invalid.");
		const text = descendants(root, "p").map(paragraphText).filter(Boolean).join("\n");
		addUnit(units, text, { kind: "slide", slide, notes: false }, `slide-${slide}`);
		const notesPart = relationships(archive, slidePart).find((item) => item.type.endsWith("/notesSlide") && !item.external)?.target;
		if (notesPart) {
			const notes = parseXml(archive.read(notesPart));
			const paragraphs: string[] = [];
			for (const shape of descendants(notes, "sp")) {
				const placeholder = attribute(descendants(shape, "ph")[0], "type");
				if (placeholder && placeholder !== "body") continue;
				paragraphs.push(...descendants(shape, "p").map(paragraphText).filter(Boolean));
			}
			if (paragraphs.length) addUnit(units, paragraphs.join("\n"), { kind: "slide", slide, notes: true }, `slide-${slide}-notes`);
		}
	}
	return parsedDocument("pptx", units, ["Slide text and speaker notes are extracted in package order. Charts, images, visual layout, slide masters, animations, and embedded media are not interpreted; export relevant slides as PDF or images for visual analysis."]);
}

export function parseOffice(format: "docx" | "xlsx" | "pptx", bytes: Buffer): ParsedDocument {
	const archive = new DocumentArchive(bytes);
	const types = parseXml(archive.read("[Content_Types].xml"));
	if (localName(types) !== "Types") documentError("The Office package content types are invalid.");
	if (types.children.some((item) => /macroEnabled|vbaProject/i.test(attribute(item, "ContentType") ?? ""))) documentError("Macro-enabled Office files are not supported.");
	const main = format === "docx" ? "word/document.xml" : format === "xlsx" ? "xl/workbook.xml" : "ppt/presentation.xml";
	const type = format === "docx" ? "wordprocessingml.document" : format === "xlsx" ? "spreadsheetml.sheet" : "presentationml.presentation";
	if (!children(types, "Override").some((item) => attribute(item, "PartName") === `/${main}`
		&& attribute(item, "ContentType") === `application/vnd.openxmlformats-officedocument.${type}.main+xml`)) {
		documentError("The Office package does not declare the expected document content type.");
	}
	if (format === "docx") return parseWord(archive);
	if (format === "xlsx") return parseWorkbook(archive);
	return parsePresentation(archive);
}
