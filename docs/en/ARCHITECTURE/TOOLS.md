# Tools: general protocol and file execution facts

English | [简体中文](../../zh-CN/ARCHITECTURE/TOOLS.md)

[Architecture](README.md) · [Coding guide](../GUIDES/CODING.md)

Tools expose model-visible definitions, argument validation and asynchronous execution. They do not read terminal input themselves. [Permissions](PERMISSIONS.md) owns authorization and shared execution guards; entries supply approval callbacks.

Definitions use Fatcat's `ToolDefinition` with direct name, description, parameters and optional strict fields. Assembly/wrappers do not construct OpenAI's function envelope. Model API encoders add protocol fields, preserving definition content and execution contracts. Tools.execute still parses raw arguments JSON and returns validation failures under the original call ID; see [Model boundaries](PROVIDERS.md#internal-messages-and-api-boundaries).

<a id="tool-contract-audit"></a>

## Tool contract audit

The P2 audit retains sixteen definitions when all corresponding host capabilities are available. Availability still depends on assembly, session and permission context; this is not a promise that every request exposes all sixteen. No new tool or permission is introduced.

| Tool | Responsibility and contract reviewed |
| --- | --- |
| read | Known file/directory paging; offset/limit and complete-line bounds; virtual wrappers retain their own protocols |
| glob | Path discovery without reading bodies; pattern/exclude, pagination and traversal limits |
| grep | Literal or regex content search; glob filters paths, query searches text; skipped files remain explicit |
| write | Create a new text file; existing targets fail; approval and publication journal |
| edit | Unique, non-overlapping replacements validated together; conflict never means partial success |
| shell | Foreground process, independent permission, timeout and cleanup; command success differs from capture completeness |
| output_read | Read/search captured streams by outputId; no command rerun; page and capture truncation are separate |
| web | Mutually exclusive search/fetch inputs; network authorization and bounded output |
| browser | Bounded local browser inspection; explicit steps/selectors/viewport types and execution evidence |
| image_read | Local image identity/decoding and optional budgeted visual request; no inline image in saved history |
| memory_search | List/search currently accessible memories; bounded result metadata |
| memory_read | Read an exact memory reference/revision; stale references fail explicitly |
| memory_write | Parent-only mutation with user evidence, scope checks and revision validation |
| ask_user | Parent clarification through the host; answered/skipped are distinct; background requests fail |
| delegate_task | Bounded child execution and parent cancellation; separate child history, at most 32 model requests per child |
| automation | Session-bound scheduling through existing authorization and budgets; no implicit heartbeat |

Targeted audit fixes align schemas and runtime validation: output_read rejects explicit null limits and any tail field in search mode; its schema distinguishes read/search and tail/offset. web advertises mutually exclusive action fields and enforces its 2048-character URL limit. Browser defaults apply only to omitted fields, not null collections/viewport. Discovery rejects malformed Unicode patterns. Missing-path and tool-I/O errors suggest discovery or inspecting existing effects before retrying; they never imply rollback.

An empty successful search means no matches within the declared scope. skippedFiles/complete=false, nextOffset, page truncation and incomplete command capture retain their distinct meanings. Invalid arguments, denied access and unavailable artifacts remain errors. Existing domain tests plus `verification/tests/tools/p2-contracts.test.ts` cover these boundaries; the [injected tool baseline](EVAL.md#injected-tool-baseline) exercises task outcomes. Schema validation is not delegated to the model or provider.

## Assembly and specialized responsibilities

| Source | Responsibility |
| --- | --- |
| `packages/runtime/src/tools.ts`, `packages/runtime/src/tools/types.ts` | Collection assembly, common results, cancellation and forTurn wrappers |
| `packages/runtime/src/tools/read.ts` | Known file/directory paging |
| `packages/runtime/src/tools/glob.ts`, `grep.ts`, `discovery.ts`, `search.ts`, `search-worker.ts` | Path discovery, text search, bounded traversal and isolated regex evaluation |
| `packages/runtime/src/tools/write.ts` | Exact text creation/replacement, publication protocol and write journal |
| `packages/runtime/src/tools/shell.ts` | Command protocol, authorization, cwd rechecks and command journal |
| `packages/runtime/src/tools/shell/powershell.ts` | Windows PowerShell environment, process execution and cleanup |
| `packages/runtime/src/tools/shell/bash.ts` | Linux Bash environment, process-group execution and cleanup |
| `packages/runtime/src/tools/shell/types.ts` | Shared process result and streaming sink contracts |
| `packages/runtime/src/tools/shell-output.ts` | Workspace-owned output IDs, capture metadata and output_read |
| `packages/runtime/src/tools/shell/capture.ts`, `output-files.ts`, `output-pages.ts` | Bounded preview, streamed temporary logs and file paging/search |
| `packages/runtime/src/tools/ask-user.ts`, `image-read.ts` | Parent clarification and budgeted local image inspection |
| `packages/runtime/src/tools/web.ts`, `browser.ts` | [HTTP research](WEB.md) and [local browser](BROWSER.md) entries |

Programmatic createTools without a directory has no local tools. A directory adds read/glob/grep/write/edit/shell/output_read, defaulting to read-only files and shell deny. sum has been removed; model requests omit the tools envelope when the collection is empty. Ordinary entries explicitly select directories/permissions and assemble web/browser. Skills and attachments wrap read. Memory uses memory_search, memory_read and parent-only memory_write. Agent assembly adds image_read and, when a host callback exists, parent-only ask_user; their contracts are below.

Results use `{ok:true,result}` or `{ok:false,error:{code,message}}`. Recoverable errors return to the model; cancellation throws CANCELLED and stops the turn. Session separately saves failed-turn messages as an attempt. Later request overflow does not roll back file/command effects.

<a id="read-and-query"></a>

## read, glob and grep

read accepts path, offset and limit for known workspace paths. Workspace query belongs to grep. Attachment and Skill virtual-resource wrappers retain their documented read query protocols. offset is zero-based; limit defaults to 100 and caps at 200. Displayed line numbers start at 1. Files return bounded complete lines; directories return filtered, sorted entries. nextOffset indicates continuation. Paging rereads current content without a workspace snapshot or version token.

glob accepts pattern and an optional directory path, returning sorted paths without opening file contents. grep accepts query and an optional file/directory path; literal, case-sensitive matching is the default. regex=true enables JavaScript Unicode regular expressions in a worker with a three-second per-file deadline; ignoreCase and 0–5 context lines are optional. Regex cancellation terminates the worker. Results sort by path UTF-16 code units then line number; multiple matches on one line return it once. offset counts paths for glob or matching lines for grep. Both default to 100 results, at most 200.

Patterns use Node glob syntax with `/` separators relative to the searched directory; patterns without `/` match basenames. grep uses glob as its optional path filter. Both accept exclude, defaulting to **/.git/** and **/node_modules/**. An explicit empty array removes those filters without expanding permission scope. Neither parses .gitignore.

| Boundary | Current limit |
| --- | --- |
| Workspace text | 1 MiB per file, strict UTF-8; unsupported control characters rejected |
| File page | 16 KiB body, complete lines; an oversized line explicitly fails |
| Directory scan | 1000 raw entries; entry pages bounded by JSON bytes |
| Search input | query at most 512 UTF-16 code units |
| glob/grep discovery | 10000 raw entries, 2048 matching files, 32 subdirectory levels |
| Discovery/search output | paths/matches JSON at most 16 KiB, without truncating full lines |

Traversal overflow fails and asks for narrower scope. Recursive search may skip oversized/unsupported-encoding candidates, returning skippedFiles and complete=false. complete=true only means discovered candidates had no such skips, not full-disk coverage or an unchanged scan. Each page traverses again, without .gitignore parsing or index caching.

Workspace/text-file enforce ordinary naming, extension and link rules. CSV and TSV use the same bounded UTF-8 text access for read, search and write. Free to go broadens local access while retaining encoding, size and identity checks. `packages/runtime/src/permissions/text-file.ts` defines the exact extension set. Reads enter model input and plaintext history without implying redaction.

## write publication protocol

Ordinary file writes use distinct tools sharing one publication protocol:

- `write({path,content})` creates a new file whose parent exists; existing targets cannot be overwritten.
- `edit({path,edits:[{oldText,newText},...]})` applies 1–32 replacements against the original file. Each oldText is nonempty, matches exactly once and differs from newText. Regions must not overlap. Replacements cannot depend on earlier replacement output. Combined old/new text is capped at 2 MiB.

Validate every replacement before one approval, one staged publication and one journal entry. Multiple edits show the complete before/after text for approval. Any matching conflict rejects the entire edit.

Preserve byte semantics outside the fragment, line endings and BOM. Final UTF-8 files remain limited to 1 MiB. After approval, reread identity and original content; reject conflicts without automatic retry.

On entering staging, create a started record and exclusively write/sync a temporary file in the same directory. Recheck directory, target and cancellation before publication. Creation installs the completed temporary file through a hard link; editing replaces via rename. Mark uncertain before publication and committed immediately after confirmation. Cleanup failure may return an error while retaining committed and must not be described as rollback. Inspect current files before retrying publication errors.

This avoids partial in-place writes; it is neither a multi-file transaction nor OS compare-and-swap. A race remains between recheck and publication. NTFS ACLs, alternate data streams and other metadata are not guaranteed to survive completely. There is no deletion, recursive directory creation or automatic recovery; crashes may leave temporary files. Creation requires filesystem hard-link support.

## shell execution boundaries

`tools/shell.ts` coordinates permission snapshots, approval, cwd validation, command records and cleanup-failure lockout. The platform executors in `tools/shell/` only receive the command, cwd, timeout, cancellation signal and optional output sink; they own process lifecycle and return `ProcessResult`. They do not read permission policy or request approval. Policy, approval coordination and command-risk classification remain in `permissions/`.

Input is command with optional cwd and timeoutMs. Commands allow 4000 UTF-16 code units; timeout defaults to 30 seconds and accepts 100–120000 ms. Approval shows the complete command, canonical directory and deadline; cwd is rechecked afterward. File-write authorization is not command authorization.

Each call launches a fresh hidden Windows PowerShell without profile or interactive stdin, using an argument array and EncodedCommand. Working directories do not persist across calls. Only allowlisted runtime environment variables are inherited, excluding model keys and NODE_OPTIONS. PATH/PSModulePath remain trusted host configuration; filtering cannot isolate disk credentials readable by the account.

The additional Linux evaluation path uses `/bin/bash --noprofile --norc -c` in a new process group, with no stdin and no persistent shell state. `tools/shell/bash.ts` retains the same ProcessResult contract and an explicit Linux environment allowlist; BASH_ENV, ENV, SHELLOPTS, loader hooks and provider credentials are not inherited. Tool descriptions and system guidance select the actual platform. Other platforms remain unsupported by shell. Linux does not use the PowerShell risk classifier: every Free to go Bash command requires approval. A headless task must select an explicit workspace-write/shell-allow policy or deny shell.

stdout/stderr stream to temporary files with backpressure and a 16 KiB raw preview per stream. The log quota is 64 MiB per command and 256 MiB across the process. Quota exhaustion or storage failure stops further capture while the process continues; captureStatus reports command_quota, process_quota or storage_error. Only timeout/cancellation trigger bounded process-tree cleanup. Cleanup does not target the old PID after parent exit; detached descendants may survive. Unconfirmed cleanup blocks further commands on the same Tools instance. There is no Job Object guarantee, background-service or interactive-command support.

Linux sends SIGKILL immediately to the owned process group, following the inspected pi executor, and waits up to five seconds for stream/process settlement. This deliberately replaces the earlier proposed TERM/grace escalation: a delayed signal after the leader exits can target a reused identifier or miss a TERM-ignoring child. A stopped zombie can still await init reaping. Processes that escape the group need container teardown; `tree-killed` confirms group termination/settlement, not isolation. Both native executors reject already-aborted launches before spawning.

Results reflect PowerShell errors and external exit codes. Chained native commands should check LASTEXITCODE individually. Tool ok is not command success; truncated output is not complete verification. cwd is only a launch location, not an OS sandbox.

## output_read and captured output

Each shell result includes outputId (the command record ID), preview stdout/stderr, outputTruncated and the original status/exitCode/cleanup/truncated fields. Each stream preview allows 8000 JSON-escaped content bytes. outputTruncated only means the preview is shortened; truncated means incomplete capture. success requires completed, exit code zero and confirmed cleanup, independently of capture completeness. storedBytes/receivedBytes and captureStatus distinguish command execution from logging. A successful process with missing logs is not proof of complete verification.

output_read takes outputId, never a filesystem path. action=read (default) pages stdout (default) or stderr by Unicode code-point offset, default limit 4000 and maximum 12000; tail=true reads the suffix and excludes offset. action=search accepts a case-sensitive literal query up to 512 UTF-16 code units, with offset counting matching lines and limit default 100/max 200. Read content and search-match JSON have separate 12000-byte page budgets. Long search lines use bounded previews plus textTruncated and characterOffset for expansion. Follow nextOffset with identical options. captureTruncated describes the stored capture, independently of page truncated.

Logs are private temporary artifacts indexed by the workspace Tools instance, with the existing 20-command journal bound. Parent/child tools share them, including failed commands; a mode downgrade denies unrestricted captures. Reads reject changed/replaced files and scan bounded chunks, never loading the entire log. New Tools instances and restarted processes cannot resolve old IDs. History saves only returned previews/pages. Normal process exit removes its owned log directory. On first capture, best-effort cleanup removes marked directories older than 24 hours whose owner process is dead; unrelated directories and live/unknown owners are skipped. Logs have no restart recovery, encryption or secure-erasure guarantee. A process-wide quota is not released before exit.

<a id="clarification-and-image-tools"></a>

## Clarification, images and memory tools

ask_user accepts one question (2000 UTF-16 units), optionally 2–6 distinct choices (200 units each), and returns answered with free text up to 4000 units or skipped. At most four questions per turn. Runtime validates inputs and coordinates one fresh, single-use pending ID; CLI/TUI/Web UI own presentation and fresh input. Answers do not grant operation approval. Cancellation clears the pending question; TUI restores the prior draft. Child tools omit ask_user; automated Session turns reject it even when the host has an interactive callback. No answer/approval is restored from saved history. Noninteractive CLI use returns QUESTION_UNAVAILABLE without consuming stdin.

image_read({path,question}) inspects one local PNG/JPEG, including browser screenshots, using current workspace read permissions. It reuses the attachment import boundary (16 MiB), bounded decoder worker and 2048px/4M-pixel render limit. The source is read again after decoding to revalidate permissions and its SHA-256 before transmission. It uses the selected model's vision capability, one auxiliary request from the executing parent/child budget, and preserves the final response reservation. It returns a fallible model description, source digest and rendered dimensions; inline image bytes do not enter history. It does not create an immutable attachment citation, fetch URLs or guarantee exact OCR. File changes after the final recheck remain possible. See [Documents](DOCUMENTS.md) for decoder and vision limits.

memory_search({query?,offset?,limit?}) lists visible current references; memory_read({path}) reads an exact revision; memory_write({path,content,memoryEvidence}) performs parent-only changes. File read/write/edit do not route memory addresses. Scope validation, evidence, revisions, eight-attempt mutation allowance and persistent formats remain owned by [Memory](MEMORY.md).

## Journals and verification

Each Tools instance retains at most 100 staged write records and 20 command launches. Parents/children share them; workspace caching preserves them; accessors return defensive copies. Early argument/permission rejection cannot pretend execution occurred. Write records contain status, path, hash and size; command records contain exit/cleanup facts and bounded summaries. Temporary request guidance/events may use them without copying journals into successful history.

[Execution reports](EXECUTION_REPORT.md) deduplicate by ID and aggregate. Failure and new sessions do not clear facts; restarts do not restore journals. Test results are not strongly bound to all relevant file versions.

Key checks cover paging, size/encoding rejection, query completeness, post-approval conflicts, publication/cleanup failure, cancellation, shared children, real PowerShell nonzero exits and descendant cleanup. Fixed model read/edit/read or coding examples do not establish general correctness. Future Task acceptance, file snapshots and reliable process isolation need separate designs, not many specialized model tools.
