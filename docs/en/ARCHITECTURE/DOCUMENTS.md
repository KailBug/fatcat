# Documents: parsing, vision and stable provenance

English | [简体中文](../../zh-CN/ARCHITECTURE/DOCUMENTS.md)

[Architecture](README.md) · [Formats and operation](../GUIDES/MATERIALS.md#supported-content)

Documents derives locatable content from authorized attachments without another Agent Loop or format-specific model tools. [Attachments](ATTACHMENTS.md) owns originals and authorization.

## Modules and data flow

| Source | Responsibility |
| --- | --- |
| `packages/runtime/src/documents/parse.ts` | Worker dispatch, concurrency, deadlines and cancellation |
| `types.ts`, `limits.ts` | Parsed units, locations and resource limits |
| `archive.ts`, `xml.ts`, `ooxml.ts` | Bounded ZIP/XML and modern Office extraction |
| `text.ts`, `pdf.ts`, `images.ts` | Text/headings, PDF page text/rendering and PNG/JPEG decoding |
| `cache.ts` | Immutable snapshots, version index and transcription page pointers |
| `read.ts` | Scoped reads, literal search, visual selection, coverage and references |
| `vision.ts` | Current chat model image-request adaptation and usage; [Providers](PROVIDERS.md) owns capabilities |
| `packages/runtime/src/session/attachments.ts` | Adapt explicit execution identity to original/derived cache access; host previews/model reads share authorization wrappers |

Authorized original read → load/generate native parse snapshot → general read selects ranges, search or explicit visual pages → return units/coverage/provenance → Session saves tool results. Cached reads and source previews never implicitly request vision.

## Parsing and reading contracts

The guide owns the user format matrix. Preserve these architectural distinctions:

- PDF extracts page text without guaranteeing layout order. Scanned pages retain missing-text warnings rather than successful empty pages. Visual rendering requires explicit page numbers.
- DOCX extracts body headings, paragraphs and table paragraphs without inferring Word pagination or full table layout; unsupported headers/footnotes are excluded.
- XLSX retains sheet/cell/rawValue/valueType. Formulas retain expressions and unverified caches with formulaStatus=not-calculated. No display formatting, recalculation or external-workbook connections.
- PPTX extracts slide text and separately located notes without rendering masters, charts or animations. Office vision requires conversion to supported pages first.
- PNG/JPEG are actually decoded, transparent images placed on white and scaled within bounds. Default reads do not auto-OCR. Legacy Office, macro/encrypted documents and unsupported formats explicitly reject parsing.
- OOXML reads restricted packages without disk extraction or external relationships. ZIP64, multipart archives, unsupported compression, CRC/size anomalies, invalid XML, DTDs and external entities are rejected.

read can select pages, sheet, section, unit, parserVersion, mode and visual question. Pages/slides start at 1; offset counts parsed units from zero (matching units for search). sheet/section match exactly; query is case-sensitive literal text.

Results report returned/selected/total units, nextOffset, warnings and coverage.uncovered. Search is not full coverage; parse warnings, missing pages and generated content cannot pose as complete native extraction. Large text splits deterministically into located part units. Oversized Excel raw fields become named continuations at the same cell, without silent truncation or pretending calculation.

## Fixed references and derived cache

References use `attachment:<uuid>@<original-sha256>#parse=<snapshot-version>&unit=<unit-id>`. Native parser version is currently documents-v1; derived versions identify content, locations, generation method, model and warnings together. Parsing changes require a new parserVersion. Missing old snapshots return DOCUMENT_VERSION_UNAVAILABLE rather than redirecting to newer content; text-line references remain supported.

native-text, model-transcription and model-description distinguish native text, model transcription and description. The latter retain provider/model without invented coordinates/confidence. Descriptions do not automatically become searchable full transcriptions; direct image analysis does not require prior full OCR.

Snapshots live under `attachments/derived/<id>/<original-version>/`; index.json records retained versions and latest transcription pages. A version is reusable only with identical content. Saving the same version can repair interrupted index publication; corruption explicitly fails. SessionManager resolves targets; `session/attachments.ts` wraps each cache load/transcripts/save with authorization/cancellation checks, rechecking scope before external requests and publication. Parsing/network run outside the metadata gate. Wrappers bind only the current identity; already-read bytes grant no lasting authorization and UI switching cannot retarget another session. Host previews add no model-read pins; model execution still pins on original read.

`cache.ts` directly uses bounded JSON reads/atomic publication from `metadata/files.ts`, without depending on transaction coordination. Shared file mechanics do not alter index repair, version lifecycles or per-operation authorization; [Metadata](METADATA.md) retains cross-file commit decisions.

Deleting originals also cleans derived directories. Removing associations revokes cache access; pins protect under original rules. In-memory mode uses MemoryDocumentCache. New visual tasks cannot claim execution from old descriptions.

## Resource and model budgets

| Boundary | Limit |
| --- | --- |
| Original; ZIP parts/expanded bytes | 16 MiB; 2000 parts / 32 MiB |
| XML size/nodes/depth | 8 MiB / 200000 / 128 |
| Extracted text/locations; units | 4 MiB; 20000 |
| Unit location metadata | 4096 JSON bytes |
| PDF; selected visual pages per call | 200 pages; 1–4 unique page numbers |
| Image decode; rendering | 16 million pixels; longest edge 2048, 4 million pixels |
| Visual input | Four images, 8 MiB total; current materials request page by page |
| worker | 30 seconds, two active workers, 256 MiB V8 old generation |
| Snapshot; per-original cache | 8 MiB; 64 versions / 32 MiB |
| In-memory derived cache | 64 MiB across originals, counted separately from original buffers |
| read result | About 16 KiB of complete units, default 100 and maximum 200 units |
| Model output | 2048 tokens with thinking off; mandatory-thinking models use 16384 tokens including reasoning; 32 KiB result text (see [protocol budgets](PROVIDERS.md#capability-catalog-and-session-contract)) |

V8 limits do not constrain all native decoding memory and are not an OS sandbox. Cancellation terminates workers. Auxiliary vision consumes the current parent/child allowance, full JSON byte limit and deadline while reserving final delivery. Image base64 exists only in temporary requests, not sessions. Successful pages may retain snapshots while failures/uncovered pages remain explicit; consumed usage does not roll back.

## Dependencies and verification limits

pdfjs-dist supplies PDF text/rendering, @napi-rs/canvas native Canvas/images and saxes strict XML. Office uses Node zlib and narrow package parsing without Office, Python or large RAG frameworks. xml.ts retains a narrow type boundary without disabling repository strict mode. package.json defines versions.

Existing checks use synthetic documents with known structures for local parsing/rendering, plus injected SDK and Edge checks for budgets, provenance, authorization and UI. No real vision API was run; OCR, complex charts, representative business materials and account availability are not established. See [Development](../DEVELOPMENT.md).

Standalone OCR, native PDF/Office model inputs, Office page rendering, formula recalculation, audio and retrieval are unimplemented. Future choices depend on real examples and location/cost needs; see [RAG](RAG.md).
