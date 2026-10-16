import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { HarnessError } from "../../src/errors.js";
import { parseDocument, renderDocumentPages } from "../../src/documents/parse.js";
import { documentParserVersion } from "../../src/documents/types.js";
import { imageFixture, officeFixture, officeFixtureFiles, pdfFixture, zipFixture } from "../fixtures/document-fixtures.js";

function code(expected: string): (error: unknown) => boolean {
	return (error) => error instanceof HarnessError && error.code === expected;
}

test("Markdown keeps exact line identity and inherited headings without interpreting fenced headings", async () => {
	const parsed = await parseDocument("plan.md", Buffer.from("# Plan\r\nOne\n```\n# Code\n```\nTwo\n"));
	assert.equal(parsed.parserVersion, documentParserVersion);
	assert.equal(parsed.format, "markdown");
	assert.equal(parsed.units.length, 7);
	assert.deepEqual(parsed.units[1]?.location, { kind: "line", line: 2, heading: "Plan", headingLevel: 1 });
	assert.equal(parsed.units[5]?.location.heading, "Plan");
	assert.equal(parsed.units[3]?.text, "# Code");
});

test("Word extracts body and table paragraphs with real paragraph and heading identities", async () => {
	const parsed = await parseDocument("report.docx", officeFixture("docx"));
	assert.equal(parsed.format, "docx");
	assert.equal(parsed.totalUnits, 3);
	assert.equal(parsed.units[0]?.text, "Project Atlas");
	assert.equal(parsed.units[1]?.text, "Launch requires two reviews.\tKeep evidence.");
	assert.deepEqual(parsed.units[2]?.location, { kind: "paragraph", paragraph: 3, heading: "Project Atlas", headingLevel: 1 });
	assert.match(parsed.warnings.join(" "), /page numbers.*not inferred/);
});

test("Excel preserves sheets, raw cells and formula caches without treating stale cache as calculated fact", async () => {
	const parsed = await parseDocument("budget.xlsx", officeFixture("xlsx"));
	assert.equal(parsed.totalUnits, 5);
	assert.equal(parsed.units[0]?.text, "A1: Cost");
	const formula = parsed.units.find((unit) => unit.location.cell === "B3");
	assert.deepEqual(formula?.location, { kind: "cell", sheet: "Budget", cell: "B3", valueType: "n", rawValue: "999", formula: "SUM(B1:B2)", formulaStatus: "not-calculated", cachedValue: "999" });
	assert.match(formula!.text, /unverified/);
	assert.equal(parsed.units.at(-1)?.location.sheet, "Notes");
	assert.match(parsed.warnings.join(" "), /not recalculated/);
});

test("PowerPoint uses presentation slide order and separates speaker notes", async () => {
	const parsed = await parseDocument("review.pptx", officeFixture("pptx"));
	assert.equal(parsed.totalUnits, 2);
	assert.deepEqual(parsed.units[0]?.location, { kind: "slide", slide: 1, notes: false });
	assert.match(parsed.units[0]!.text, /Architecture review/);
	assert.deepEqual(parsed.units[1]?.location, { kind: "slide", slide: 1, notes: true });
	assert.match(parsed.units[1]!.text, /confirm project ownership/);
});

test("PDF extracts each native page and preserves pages needing visual analysis", async () => {
	const parsed = await parseDocument("evidence.pdf", pdfFixture(["First page evidence", "", "Third page evidence"]));
	assert.equal(parsed.totalUnits, 3);
	assert.equal(parsed.units[0]?.text, "First page evidence");
	assert.equal(parsed.units[1]?.text, "");
	assert.deepEqual(parsed.units[1]?.location, { kind: "page", page: 2 });
	assert.match(parsed.warnings.join(" "), /native text.*2/);
});

test("PDF selected-page rendering produces bounded real PNG pixels", async () => {
	const images = await renderDocumentPages("evidence.pdf", pdfFixture(["First", ""]), [2]);
	assert.equal(images.length, 1);
	assert.equal(images[0]?.page, 2);
	assert.equal(images[0]?.mimeType, "image/png");
	assert.equal(images[0]?.data.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
	assert.equal(images[0]?.width, 800);
	assert.equal(images[0]?.height, 600);
	const canvas = createCanvas(800, 600);
	const context = canvas.getContext("2d");
	context.drawImage(await loadImage(images[0]!.data), 0, 0);
	const pixel = context.getImageData(100, 400, 1, 1).data;
	assert.ok(pixel[2]! > 150 && pixel[0]! < 50, "The rendered selected page contains its known blue rectangle.");
	await assert.rejects(renderDocumentPages("evidence.pdf", pdfFixture(), [3]), code("INVALID_ARGUMENTS"));
});

test("Password-protected PDFs report their encryption boundary explicitly", async () => {
	await assert.rejects(parseDocument("protected.pdf", pdfFixture(["Secret"], true)), (error) =>
		error instanceof HarnessError && error.code === "DOCUMENT_INVALID" && /Encrypted PDFs/.test(error.message));
});

test("PNG and JPEG decode to visual pages while native extraction never invents OCR text", async () => {
	for (const format of ["png", "jpeg"] as const) {
		const bytes = imageFixture(format);
		const parsed = await parseDocument(`diagram.${format}`, bytes);
		assert.equal(parsed.totalUnits, 1);
		assert.equal(parsed.units[0]?.text, "");
		assert.equal(parsed.units[0]?.location.kind, "image");
		assert.match(parsed.warnings.join(" "), /No native text/);
		const [image] = await renderDocumentPages(`diagram.${format}`, bytes, [1]);
		assert.equal(image?.width, 320);
		assert.equal(image?.height, 160);
		assert.ok(image!.data.length > 100);
	}
});

test("Legacy, macro and unsupported image extensions explicitly require conversion", async () => {
	for (const extension of ["doc", "xls", "ppt", "docm", "xlsm", "pptm", "gif", "webp", "tiff"]) {
		await assert.rejects(parseDocument(`legacy.${extension}`, Buffer.from("content")), code("DOCUMENT_UNSUPPORTED"));
	}
	await assert.rejects(renderDocumentPages("chart.xlsx", officeFixture("xlsx"), [1]), code("DOCUMENT_VISUAL_UNSUPPORTED"));
});

test("Corrupt inputs and invalid XML do not become empty documents", async () => {
	for (const extension of ["docx", "xlsx", "pptx", "pdf", "png", "jpeg"]) {
		await assert.rejects(parseDocument(`broken.${extension}`, Buffer.from("not a document")), code("DOCUMENT_INVALID"));
	}
	await assert.rejects(parseDocument("invalid.md", Buffer.from([0xff, 0xfe])), code("DOCUMENT_INVALID"));
	const files = officeFixtureFiles("docx");
	files["word/document.xml"] = "<document><body></document>";
	await assert.rejects(parseDocument("broken.docx", zipFixture(files)), code("DOCUMENT_INVALID"));
});

test("Office packages reject entity declarations, hidden macros and checksum failures", async () => {
	const entity = officeFixtureFiles("docx");
	entity["word/document.xml"] = '<!DOCTYPE document [<!ENTITY secret SYSTEM "file:///C:/secret.txt">]><document><body><p><t>&secret;</t></p></body></document>';
	await assert.rejects(parseDocument("entity.docx", zipFixture(entity)), code("DOCUMENT_INVALID"));
	await assert.rejects(parseDocument("macro.docx", zipFixture({ ...officeFixtureFiles("docx"), "word/vbaProject.bin": "macro" })), code("DOCUMENT_INVALID"));
	const corrupt = officeFixture("docx");
	const central = corrupt.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
	corrupt.writeUInt32LE(0, central + 16);
	await assert.rejects(parseDocument("checksum.docx", corrupt), code("DOCUMENT_INVALID"));
});

test("Office declared expansion and dishonest entry sizes remain bounded", async () => {
	const expanded = officeFixture("docx");
	const central = expanded.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
	expanded.writeUInt32LE(40 * 1024 * 1024, central + 24);
	await assert.rejects(parseDocument("large.docx", expanded), code("DOCUMENT_LIMIT"));
	const files = officeFixtureFiles("docx");
	files["word/document.xml"] = `<document><body><p><t>${"a".repeat(1024 * 1024)}</t></p></body></document>`;
	const dishonest = zipFixture(files);
	const end = dishonest.length - 22;
	const directory = dishonest.readUInt32LE(end + 16);
	let part = directory;
	while (dishonest.subarray(part + 46, part + 46 + dishonest.readUInt16LE(part + 28)).toString("utf8") !== "word/document.xml") {
		part += 46 + dishonest.readUInt16LE(part + 28) + dishonest.readUInt16LE(part + 30) + dishonest.readUInt16LE(part + 32);
	}
	dishonest.writeUInt32LE(10, part + 24);
	await assert.rejects(parseDocument("dishonest.docx", dishonest), code("DOCUMENT_INVALID"));
});

test("PDF page counts, render selection and image pixel limits are explicit", async () => {
	await assert.rejects(parseDocument("large.pdf", pdfFixture(Array(201).fill("Page"))), code("DOCUMENT_LIMIT"));
	await assert.rejects(renderDocumentPages("evidence.pdf", pdfFixture(), [1, 1]), code("INVALID_ARGUMENTS"));
	await assert.rejects(renderDocumentPages("evidence.pdf", pdfFixture(), [1, 2, 3, 4, 5]), code("INVALID_ARGUMENTS"));
	const png = imageFixture();
	png.writeUInt32BE(100001, 16);
	await assert.rejects(parseDocument("huge.png", png), code("DOCUMENT_LIMIT"));
});

test("Cancellation works before parsing and terminates an active parser worker", async () => {
	await assert.rejects(parseDocument("report.docx", officeFixture("docx"), AbortSignal.abort()), code("CANCELLED"));
	const controller = new AbortController();
	const pending = parseDocument("report.pdf", pdfFixture(Array(100).fill("Evidence")), controller.signal);
	setTimeout(() => controller.abort(), 10);
	await assert.rejects(pending, code("CANCELLED"));
});

test("Text output limits and unparsed Office drawing coverage are explicit", async () => {
	await assert.rejects(parseDocument("long.txt", Buffer.from("a".repeat(4 * 1024 * 1024 + 1))), code("DOCUMENT_LIMIT"));
	await assert.rejects(parseDocument("lines.md", Buffer.from("line\n".repeat(20001))), code("DOCUMENT_LIMIT"));
	const files = officeFixtureFiles("docx");
	files["word/document.xml"] = files["word/document.xml"]!.replace("</w:body>", "<w:p><w:r><w:drawing/></w:r></w:p></w:body>");
	files["word/header1.xml"] = "<header/>";
	const parsed = await parseDocument("drawing.docx", zipFixture(files));
	assert.match(parsed.warnings.join(" "), /Embedded images, charts/);
	assert.match(parsed.warnings.join(" "), /Headers, footers/);
});

test("Concurrent parser admission is bounded and cancellation releases a slot", async () => {
	const controller = new AbortController();
	const pending = [parseDocument("one.pdf", pdfFixture(Array(100).fill("One")), controller.signal),
		parseDocument("two.pdf", pdfFixture(Array(100).fill("Two")), controller.signal)];
	await assert.rejects(parseDocument("three.md", Buffer.from("Three")), code("DOCUMENT_BUSY"));
	controller.abort();
	await Promise.all(pending.map(async (promise) => assert.rejects(promise, code("CANCELLED"))));
	assert.equal((await parseDocument("next.md", Buffer.from("Next"))).units[0]?.text, "Next");
});
