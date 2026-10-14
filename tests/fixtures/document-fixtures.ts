import { createCanvas } from "@napi-rs/canvas";
import { deflateRawSync } from "node:zlib";

function crc32(bytes: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
	}
	return (crc ^ 0xffffffff) >>> 0;
}

export function zipFixture(files: Record<string, string | Buffer>, compressed = true): Buffer {
	const contents: Buffer[] = [];
	const directory: Buffer[] = [];
	let offset = 0;
	for (const [name, content] of Object.entries(files)) {
		const nameBytes = Buffer.from(name);
		const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
		const data = compressed ? deflateRawSync(bytes) : bytes;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50);
		local.writeUInt16LE(20, 4);
		local.writeUInt16LE(0x800, 6);
		local.writeUInt16LE(compressed ? 8 : 0, 8);
		local.writeUInt32LE(crc32(bytes), 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(bytes.length, 22);
		local.writeUInt16LE(nameBytes.length, 26);
		contents.push(local, nameBytes, data);
		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50);
		central.writeUInt16LE(20, 4);
		central.writeUInt16LE(20, 6);
		central.writeUInt16LE(0x800, 8);
		central.writeUInt16LE(compressed ? 8 : 0, 10);
		central.writeUInt32LE(crc32(bytes), 16);
		central.writeUInt32LE(data.length, 20);
		central.writeUInt32LE(bytes.length, 24);
		central.writeUInt16LE(nameBytes.length, 28);
		central.writeUInt32LE(offset, 42);
		directory.push(central, nameBytes);
		offset += local.length + nameBytes.length + data.length;
	}
	const index = Buffer.concat(directory);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50);
	end.writeUInt16LE(Object.keys(files).length, 8);
	end.writeUInt16LE(Object.keys(files).length, 10);
	end.writeUInt32LE(index.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...contents, index, end]);
}

const namespace = "http://schemas.openxmlformats.org";
const relationshipsNamespace = `${namespace}/package/2006/relationships`;
const officeRelationship = `${namespace}/officeDocument/2006/relationships`;
function packageParts(format: "docx" | "xlsx" | "pptx"): Record<string, string> {
	const main = format === "docx" ? "word/document.xml" : format === "xlsx" ? "xl/workbook.xml" : "ppt/presentation.xml";
	const type = format === "docx" ? "wordprocessingml.document" : format === "xlsx" ? "spreadsheetml.sheet" : "presentationml.presentation";
	const overrides = format === "xlsx" ? '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>'
		: format === "pptx" ? '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/notesSlides/notesSlide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>' : "";
	return {
		"[Content_Types].xml": `<Types xmlns="${namespace}/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/${main}" ContentType="application/vnd.openxmlformats-officedocument.${type}.main+xml"/>${overrides}</Types>`,
		"_rels/.rels": `<Relationships xmlns="${relationshipsNamespace}"><Relationship Id="rId1" Type="${officeRelationship}/officeDocument" Target="${main}"/></Relationships>`,
	};
}

export function officeFixtureFiles(format: "docx" | "xlsx" | "pptx"): Record<string, string> {
	if (format === "docx") return {
		...packageParts(format),
		"word/document.xml": `<w:document xmlns:w="${namespace}/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Project Atlas</w:t></w:r></w:p><w:p><w:r><w:t>Launch requires two reviews.</w:t><w:tab/><w:t>Keep evidence.</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Table evidence</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>`,
	};
	if (format === "xlsx") return {
		...packageParts(format),
		"xl/workbook.xml": `<workbook xmlns="${namespace}/spreadsheetml/2006/main" xmlns:r="${officeRelationship}"><sheets><sheet name="Budget" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>`,
		"xl/_rels/workbook.xml.rels": `<Relationships xmlns="${relationshipsNamespace}"><Relationship Id="rId1" Type="${officeRelationship}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${officeRelationship}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${officeRelationship}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
		"xl/sharedStrings.xml": `<sst xmlns="${namespace}/spreadsheetml/2006/main"><si><t>Cost</t></si></sst>`,
		"xl/worksheets/sheet1.xml": `<worksheet xmlns="${namespace}/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>12</v></c></row><row r="2"><c r="B2"><v>8</v></c></row><row r="3"><c r="B3"><f>SUM(B1:B2)</f><v>999</v></c></row></sheetData></worksheet>`,
		"xl/worksheets/sheet2.xml": `<worksheet xmlns="${namespace}/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Formula cache is deliberately stale.</t></is></c></row></sheetData></worksheet>`,
	};
	return {
		...packageParts(format),
		"ppt/presentation.xml": `<p:presentation xmlns:p="${namespace}/presentationml/2006/main" xmlns:r="${officeRelationship}"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>`,
		"ppt/_rels/presentation.xml.rels": `<Relationships xmlns="${relationshipsNamespace}"><Relationship Id="rId1" Type="${officeRelationship}/slide" Target="slides/slide1.xml"/></Relationships>`,
		"ppt/slides/slide1.xml": `<p:sld xmlns:p="${namespace}/presentationml/2006/main" xmlns:a="${namespace}/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Architecture review</a:t></a:r></a:p><a:p><a:r><a:t>Keep sessions separate.</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
		"ppt/slides/_rels/slide1.xml.rels": `<Relationships xmlns="${relationshipsNamespace}"><Relationship Id="rId1" Type="${officeRelationship}/notesSlide" Target="../notesSlides/notesSlide1.xml"/></Relationships>`,
		"ppt/notesSlides/notesSlide1.xml": `<p:notes xmlns:p="${namespace}/presentationml/2006/main" xmlns:a="${namespace}/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>Speaker note: confirm project ownership.</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
	};
}

export function officeFixture(format: "docx" | "xlsx" | "pptx"): Buffer {
	return zipFixture(officeFixtureFiles(format));
}

/** A complete local PDF with known ASCII text, page objects, streams and xref. */
export function pdfFixture(pages: string[] = ["Page one evidence", "Page two evidence"], protectedDocument = false): Buffer {
	const objects: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
	const pageIds: number[] = [];
	for (const text of pages) {
		const pageId = objects.length + 1;
		const contentId = pageId + 1;
		pageIds.push(pageId);
		const escaped = text.replace(/[\\()]/g, "\\$&");
		const content = text ? `BT /F1 16 Tf 40 240 Td (${escaped}) Tj ET` : "0.1 0.3 0.7 rg 30 30 100 80 re f";
		objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
		objects.push(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
	}
	objects[1] = `<< /Type /Pages /Count ${pages.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] >>`;
	if (protectedDocument) objects.push(`<< /Filter /Standard /V 1 /R 2 /Length 40 /O <${"00".repeat(32)}> /U <${"00".repeat(32)}> /P -4 >>`);
	let output = "%PDF-1.4\n";
	const offsets = [0];
	for (const [index, object] of objects.entries()) {
		offsets.push(Buffer.byteLength(output));
		output += `${index + 1} 0 obj\n${object}\nendobj\n`;
	}
	const xref = Buffer.byteLength(output);
	output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, "0")} 00000 n \n`;
	const encryption = protectedDocument ? ` /Encrypt ${objects.length} 0 R /ID [<00112233445566778899aabbccddeeff><00112233445566778899aabbccddeeff>]` : "";
	output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R${encryption} >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(output);
}

export function imageFixture(format: "png" | "jpeg" = "png", width = 320, height = 160): Buffer {
	const canvas = createCanvas(width, height);
	const context = canvas.getContext("2d");
	context.fillStyle = "white";
	context.fillRect(0, 0, width, height);
	context.fillStyle = "#176646";
	context.fillRect(20, 40, 100, 60);
	context.fillStyle = "black";
	context.font = "18px sans-serif";
	context.fillText("Project Atlas", 20, 25);
	return format === "png" ? canvas.toBuffer("image/png") : canvas.toBuffer("image/jpeg", 90);
}
