# Retrieval, audio and future material capabilities (unimplemented proposals)

English | [简体中文](../../zh-CN/ARCHITECTURE/RAG.md)

[Architecture](README.md)

This page retains deferred, unimplemented proposals and acceptance constraints, not a delivery schedule. [Projects](PROJECTS.md), [Attachments](ATTACHMENTS.md), [Documents](DOCUMENTS.md) and [Memory](MEMORY.md) own implemented behavior rather than duplicating it here.

## Established design boundaries

- Attachment analysis does not require vectorization. Text retrieval can reuse parsing without waiting for full Memory; Memory does not depend on RAG.
- Originals, parsing/transcription, indexes, history and Memory have separate owners. Indexes are rebuildable derived data, never material owners.
- Models select files, pages, queries and continuation by task. Harness enforces actual Session scope, capabilities, budgets and cancellation without per-task internal retrieval switches.
- Full-document summaries/reviews require checkable coverage units. A few top-k hits cannot pose as full coverage; disclose insufficient budgets, failures and unread ranges.
- Prefer adapted chat models for vision/text extraction. Add standalone OCR only for demonstrated capability gaps or representative quality/location/cost/latency gains, not as a presumed prerequisite.
- Online Embeddings have configuration independent of chat models; audio transcription retains a separate-service direction. Do not add empty environment variables/invalid defaults for unimplemented services.

## Text retrieval proposal

Locate text by original version → chunk with provenance → build keyword/vector index → query authorized scope → expand full sections/tables/pages for review → cite fixed versions. Direct reading remains available when indexing fails or is unconfigured.

Index identity includes content/parser version, Embedding provider/model/dimension, chunk configuration and index generation. Configuration changes invalidate or rebuild separate indexes; never mix vector spaces. Same-name model updates may require explicit rebuild generations; equal dimensions do not prove compatibility.

Scope filtering and expansion both validate current associations, not merely hide cross-project hits in UI. Background/child work uses actual Session/Project/generation. Known IDs, same directories and historical references do not authorize. Removal immediately revokes query/expansion; retention pins do not restore access. Rebuilds cannot redirect old references to new content.

Establish exact keyword/text baselines before choosing chunking, databases, hybrid search and ranking using Chinese, terminology, identifiers and cross-document tasks. No library, Embedding provider or index implementation is selected; avoid premature large frameworks.

## Multimodal and audio proposals

| Direction | Selection condition | Required evidence |
| --- | --- | --- |
| Reusable OCR/visual text extraction | Current models insufficient or dedicated services demonstrate quality/location/cost/latency gains | Original/page/method/model version, success/failure and uncovered units |
| Native file input | Actual API/model support verified before adaptation | Fixed file version; no invented page numbers from file-only evidence |
| Multimodal retrieval | Transcription/description baseline insufficient and specialized representation validated on examples | Separate text, model descriptions and original visuals; disclose cross-modal omissions |
| Audio parsing | Task-driven transcription/understanding of selected segments | Time locations, failed segments, speaker uncertainty versus inference |
| Voice entry | Concrete interaction needs, reusing Session/Loop | Submit completed input once; cancellation/interruption/deduplication; incomplete transcription cannot confirm operations |

Image descriptions are not full originals. Chat-image support does not mean text Embeddings directly index images. Specialized page/image retrieval may use representations different from OCR, but needs separate query/provenance/quality validation. Never invent coordinates/confidence.

Excel aggregation still requires complete relevant ranges and checkable calculations, not fragment recall or unverified formula caches. Legacy Office conversion, Office rendering and formula recalculation need separate decisions; do not presume Office, LibreOffice, Python or remote services.

## External requests and data boundaries

Embeddings send indexed text/queries; vision sends selected images/pages; transcription sends audio; chat sends selected evidence. Local parsing does not make the chain offline. Shared credentials cannot expand material scope; do not switch providers implicitly.

Each request class needs count, batch, input/output, per-file/turn, deadline and cancellation limits. Retries/fallbacks consume the same budget. Unknown usage remains unknown; states distinguish pending, ready, partial, failed and cancelled. Partial success may retain sourced artifacts. Index failure cannot break original reads. Credentials never enter records/logs.

## Acceptance and decisions before resuming

Reread implementation and select representative tasks before resuming a direction. Check isolation, version invalidation/rebuild, updates/deletion, fixed references, cancellation, resource overflow and external-request scope. Engineering checks use temporary data/injected transport; real parsing/OCR/transcription/Chinese retrieval quality requires business examples.

What materials/Memory may follow project detachment or cross-project migration remains a product decision; neither operation exists. Choose models, parsers, capacity and ranking from demonstrated gains, not reference-product names.

Retained reference ideas are general tools over structured content, separate normalization/provider conversion, and shared materials independent of chat history. These are design choices, not claims about other projects' current implementation or Fatcat performance.
