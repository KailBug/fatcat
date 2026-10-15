# Attachments, documents and Memory

[Documentation](../README.md) · [Sessions and projects](SESSIONS.md)

## Add and read materials

In chat/TUI, import a file permitted by the current file-access policy:

```text
/attach "notes.md"
/attachments
```

In Web UI, upload through the attachment controls. Originals are limited to 16 MiB each; the browser accepts at most four simultaneous uploads. Import/upload saves an immutable original and a scope association without a model request or moving the workspace file. An accepted attachment also saves a Web UI draft session.

Independent sessions have private materials; project sessions share project materials. A fork retains attachment associations. Moving a private session into a project shares its existing materials after confirmation. Editing a workspace file later does not silently change an attached version.

Ask Fatcat to list materials, read a named document, locate a passage or summarize specified pages. Reading reports scope and coverage; bounded searches or excerpts are not a full-document review. Citations identify a fixed original version and, for parsed documents, the parser version and source location. There is no cross-file vector retrieval.

## Supported content

| Format | Available reading | Limits to keep in mind |
| --- | --- | --- |
| UTF-8 `.txt`, `.md`, `.markdown` | Original text with line references | Paged and bounded |
| CSV, TSV | Rows and cells | No inferred types or calculated values |
| PDF | Native page text; selected rendered pages for visual analysis | Image-only pages may need vision |
| DOCX | Body headings and paragraphs | Headers, footnotes and comments are not included |
| XLSX | Cells, raw values and formulas | Cached values are unverified; no formula recalculation or date-format interpretation |
| PPTX | Slide text and notes | No layout or embedded-media interpretation |
| PNG, JPG, JPEG | Visual analysis/transcription with a supported current model | Text-only models cannot analyze images |
| Legacy Office, GIF, WebP, BMP, TIFF and other unsupported types | Original storage | Convert to a supported format for analysis; encrypted/macro-enabled documents are not analyzed |

For visual work, ask to analyze an image or explicitly select one to four PDF pages. The current model must support the requested capability; Fatcat never silently switches providers. Default DeepSeek and `qwen-plus` are text-only. See [provider capability rules](../ARCHITECTURE/PROVIDERS.md) for supported model names.

Visual analysis consumes the same request/usage budgets as other model calls. Transcription can create a reusable derived artifact with fixed provenance. Local parsing, source previews and cached derived reads do not themselves call a paid vision API. Real visual quality and account availability have not been established by the injected-provider checks. Exact parsing, budgets and provenance are documented in [document architecture](../ARCHITECTURE/DOCUMENTS.md).

## Remove materials

`/attachment remove <reference>` removes the current scope's association. It revokes access through old references in that scope, but retains the original and text already copied into history. Other scopes are unchanged.

`/attachment delete <reference>` previews permanent deletion; append `--confirm` only after reviewing it. External active associations or retained history/fork references can block deletion. Confirmation does not override those checks. Web UI exposes the same distinction between removal and permanent deletion. There is no automatic garbage collection. See [attachment lifecycle](../ARCHITECTURE/ATTACHMENTS.md).

## Remember facts across conversations

Use ordinary language, for example: “Remember that this project uses pnpm,” or “Update that preference to include Windows PowerShell.” The parent agent can save, revise or delete Memory based on an explicit fact or request in the current user message. Check the resulting operation; a model's promise alone does not establish a saved record.

Memory defaults to the current private-session or project scope. Saving globally requires an explicit user request. Project sessions share project Memory across separate histories. A private session joining a project shares its active Memory after confirmation; forking does not copy private Memory. Children and scheduled activations cannot mutate Memory.

Memory changes are managed conversation metadata and remain available in read-only/Plan mode; they do not grant file or command permissions. Model-initiated changes are bounded to eight evidence-validated attempts per user turn; local management commands do not require a model turn. Current records, source evidence and revisions are retained; changing or deleting a record does not erase historical disk content or text already in conversation history.

Use `/memory` to inspect entries and the [Memory command reference](../REFERENCE/COMMANDS.md#memory-commands) for explicit management. A scope supports 64 records including tombstones, with 1 KiB content per record and 32 revisions. A temporary session keeps its Memory state in memory. There is no automatic semantic extraction/merge or physical history cleanup. See [Memory architecture](../ARCHITECTURE/MEMORY.md) for scope, source evidence and validation limits.
