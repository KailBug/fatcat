import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import type { AttachmentInfo } from "@fatcat/runtime/attachments/record";
import { diskDocumentCache, MemoryDocumentCache, derivedSnapshot } from "@fatcat/runtime/internal/documents/cache";
import type { DocumentSnapshot } from "@fatcat/runtime/internal/documents/cache";
import { readDocumentContent } from "@fatcat/runtime/internal/documents/read";
import { documentParserVersion } from "@fatcat/runtime/documents/types";
import type { DocumentVision } from "@fatcat/runtime/internal/documents/vision";
import { HarnessError } from "@fatcat/runtime/errors";
import { officeFixture, officeFixtureFiles, pdfFixture, zipFixture, imageFixture } from "../fixtures/document-fixtures.js";
import { temporaryWorkspace } from "../support/workspace.js";

function info(name: string, bytes: Buffer): AttachmentInfo {
	const sha256 = createHash("sha256").update(bytes).digest("hex");
	return { id: "12345678-1234-4234-8234-123456789abc", contentVersion: sha256, sha256, name, size: bytes.length,
		mediaType: "application/octet-stream", createdAt: new Date().toISOString(), uploaderSessionId: "source", scopeRevision: 1, removed: false, deleted: false };
}

function fakeVision(text: (page: number) => string): DocumentVision {
	return { capability: { supported: true, nativeFileInput: false, provider: "kimi", model: "kimi-k2.6", reason: "Injected offline adapter" },
		analyze: async (images, options) => {
			options.beforeRequest?.();
			return { text: text(images[0]!.page!), mode: options.mode, model: "kimi-k2.6", provider: "kimi",
				sourceKind: options.mode === "visual" ? "model-description" : "model-transcription" };
		} };
}

test("document scopes and exact parse citations preserve headings, pages, cells, slides, and query coverage", async () => {
	for (const format of ["docx", "xlsx", "pptx"] as const) {
		const bytes = officeFixture(format);
		const cache = new MemoryDocumentCache();
		const record = info(`fixture.${format}`, bytes);
		const result = await readDocumentContent(record, bytes, {}, cache);
		assert.equal(result.kind, "document");
		if (result.kind !== "document") throw new Error("Expected a document");
		assert.ok(result.units.length);
		const unit = result.units.at(-1)!;
		const source = await readDocumentContent(record, bytes, { parserVersion: result.parserVersion, unit: unit.id }, cache);
		assert.equal(source.kind, "document");
		if (source.kind === "document") assert.deepEqual(source.units, [unit]);
		assert.match(unit.citation, /#parse=documents-v1&unit=/);
		assert.equal(result.coverage.complete, false, "Native text is not proof that omitted formatting/visuals were inspected");
		if (format === "xlsx") {
			const selected = await readDocumentContent(record, bytes, { sheet: "Budget", query: "SUM" }, cache);
			if (selected.kind !== "document") throw new Error("Expected a document");
			assert.equal(selected.units.length, 1);
			assert.equal(selected.units[0]!.location.formula, "SUM(B1:B2)");
			assert.equal(selected.units[0]!.location.cachedValue, "999");
			assert.equal(selected.coverage.complete, false);
			await assert.rejects(readDocumentContent(record, bytes, { pages: [1] }, cache), { code: "DOCUMENT_LOCATION" });
		}
	}
	const bytes = pdfFixture();
	const record = info("pages.pdf", bytes);
	const cache = new MemoryDocumentCache();
	await assert.rejects(readDocumentContent(record, bytes, { pages: [1, 200] }, cache), { code: "DOCUMENT_LOCATION" });
	const selected = await readDocumentContent(record, bytes, { pages: [2] }, cache);
	if (selected.kind !== "document") throw new Error("Expected a document");
	assert.equal(selected.units.length, 1);
	assert.equal(selected.units[0]!.location.page, 2);
	assert.match(selected.units[0]!.text, /Page two evidence/);
	await assert.rejects(readDocumentContent(record, bytes, { parserVersion: "old-unavailable", unit: "page-1" }, cache), { code: "DOCUMENT_VERSION_UNAVAILABLE" });
});

test("dense paragraphs and full reading are resumable without dropping text or pretending a first page is complete", async () => {
	const long = "Evidence ".repeat(6000);
	const files = officeFixtureFiles("docx");
	files["word/document.xml"] = files["word/document.xml"]!.replace("Launch requires two reviews.", long);
	const bytes = zipFixture(files);
	const record = info("long.docx", bytes);
	const cache = new MemoryDocumentCache();
	let offset = 0;
	const pieces: string[] = [];
	let pages = 0;
	do {
		const result = await readDocumentContent(record, bytes, { section: "Project Atlas", offset, limit: 2 }, cache);
		if (result.kind !== "document") throw new Error("Expected a document");
		if (!pages++) assert.equal(result.coverage.complete, false);
		pieces.push(...result.units.filter((unit) => unit.location.paragraph === 2).map((unit) => unit.text));
		if (result.nextOffset === null) break;
		offset = result.nextOffset;
	} while (pages < 20);
	assert.ok(pages > 2);
	assert.equal(pieces.join(""), `${long}\tKeep evidence.`);
});

test("visual descriptions stay separate from reusable model transcription and old revisions stay exact", async () => {
	const bytes = imageFixture();
	const record = info("image.png", bytes);
	const cache = new MemoryDocumentCache();
	const turn = { documentRequest: () => () => {} };
	const native = await readDocumentContent(record, bytes, {}, cache);
	if (native.kind !== "document") throw new Error("Expected a document");
	assert.equal(native.coverage.complete, false);
	assert.match(native.coverage.uncovered.join(" "), /No extracted text/);
	const described = await readDocumentContent(record, bytes, { mode: "visual", question: "Explain the chart" }, cache, undefined, fakeVision(() => "A green bar."), turn);
	if (described.kind !== "document") throw new Error("Expected a document");
	assert.equal(described.units[0]!.provenance, "model-description");
	assert.equal((await cache.transcripts()).length, 0);
	const first = await readDocumentContent(record, bytes, { mode: "transcribe" }, cache, undefined, fakeVision(() => "Project Atlas"), turn);
	if (first.kind !== "document") throw new Error("Expected a document");
	await readDocumentContent(record, bytes, { mode: "transcribe" }, cache, undefined, fakeVision(() => "Project Atlas [uncertain suffix]"), turn);
	const restored = await readDocumentContent(record, bytes, { parserVersion: first.parserVersion, unit: first.units[0]!.id }, cache);
	if (restored.kind !== "document") throw new Error("Expected a document");
	assert.equal(restored.units[0]!.text, "Project Atlas");
	const cached = await readDocumentContent(record, bytes, { query: "Atlas" }, cache);
	if (cached.kind !== "document") throw new Error("Expected a document");
	assert.equal(cached.units[0]!.provenance, "model-transcription");
	assert.match(cached.units[0]!.text, /uncertain/);
	assert.equal(cached.coverage.complete, false);
	await assert.rejects(readDocumentContent(record, bytes, { mode: "visual" }, cache), { code: "DOCUMENT_VISION_UNAVAILABLE" });
});

test("large quoted Excel values keep exact raw text in bounded cell continuations", async () => {
	const value = '"quoted value" '.repeat(2000);
	const files = officeFixtureFiles("xlsx");
	files["xl/worksheets/sheet2.xml"] = files["xl/worksheets/sheet2.xml"]!.replace("Formula cache is deliberately stale.", value);
	const bytes = zipFixture(files);
	const record = info("large.xlsx", bytes);
	const cache = new MemoryDocumentCache();
	let offset = 0;
	const parts: string[] = [];
	for (;;) {
		const result = await readDocumentContent(record, bytes, { sheet: "Notes", offset }, cache);
		if (result.kind !== "document") throw new Error("Expected a document");
		for (const unit of result.units.filter((item) => item.id.includes("rawValue"))) {
			assert.equal(unit.location.cell, "A1");
			parts.push(unit.text.replace(/^rawValue \(part \d+ of \d+\): /, ""));
		}
		if (result.nextOffset === null) break;
		offset = result.nextOffset;
	}
	assert.equal(parts.join(""), value);
});

test("partial page recognition reports budget exhaustion and preserves only successful page evidence", async () => {
	const bytes = pdfFixture(["", ""]);
	const cache = new MemoryDocumentCache();
	let calls = 0;
	const result = await readDocumentContent(info("scanned.pdf", bytes), bytes, { mode: "transcribe", pages: [1, 2] }, cache, undefined,
		fakeVision((page) => `Recognized page ${page}`), { documentRequest: () => {
			if (++calls > 1) throw new HarnessError("DOCUMENT_BUDGET", "Final response reserved");
			return () => {};
		} });
	if (result.kind !== "document") throw new Error("Expected a document");
	assert.equal(result.units.length, 1);
	assert.equal(result.units[0]!.location.page, 1);
	assert.match(result.coverage.uncovered.join(" "), /Page 2.*DOCUMENT_BUDGET/);
	assert.equal(result.coverage.complete, false);
	assert.equal((await cache.transcripts()).length, 1);
});

test("cache publication retains immutable snapshots, restores its manifest, and reuses a previous transcription", async (t) => {
	const { base } = await temporaryWorkspace(t);
	const root = join(base, "derived");
	const cache = diskDocumentCache(root);
	const native: DocumentSnapshot = { parserVersion: documentParserVersion, baseParserVersion: documentParserVersion,
		format: "png", units: [], totalUnits: 0, warnings: [] };
	const snapshot = (text: string) => derivedSnapshot(native, [{ id: "transcribe-1-1", text, provenance: "model-transcription", location: { kind: "page", page: 1 } }], []);
	const first = snapshot("first");
	const second = snapshot("second");
	await cache.save(first, 1);
	await cache.save(second, 1);
	await cache.save(first, 1);
	assert.equal((await cache.transcripts())[0]!.units[0]!.text, "first");
	await assert.rejects(cache.save({ ...first, units: second.units }), { code: "DOCUMENT_CACHE" });
	await writeFile(join(root, "index.json"), JSON.stringify({ versions: [], transcripts: {} }));
	await cache.save(first, 1);
	assert.equal((await cache.transcripts())[0]!.parserVersion, first.parserVersion);
	const stored = JSON.parse(await readFile(join(root, `${first.parserVersion}.json`), "utf8"));
	stored.units[0].text = "tampered";
	await writeFile(join(root, `${first.parserVersion}.json`), JSON.stringify(stored));
	await assert.rejects(cache.load(first.parserVersion), { code: "DOCUMENT_CACHE" });
});
