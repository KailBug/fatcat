# Tools: general protocol and file execution facts

English | [简体中文](../../zh-CN/ARCHITECTURE/TOOLS.md)

[Architecture](README.md) · [Coding guide](../GUIDES/CODING.md)

Tools expose model-visible definitions, argument validation and asynchronous execution. They do not read terminal input themselves. [Permissions](PERMISSIONS.md) owns authorization and shared execution guards; entries supply approval callbacks.

Definitions use Fatcat's `ToolDefinition` with direct name, description, parameters and optional strict fields. Assembly/wrappers do not construct OpenAI's function envelope. Model API encoders add protocol fields, preserving definition content and execution contracts. Tools.execute still parses raw arguments JSON and returns validation failures under the original call ID; see [Model boundaries](PROVIDERS.md#internal-messages-and-api-boundaries).

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
| `packages/runtime/src/tools/shell/types.ts` | Shared ProcessResult contract and combined output limit |
| `packages/runtime/src/tools/shell-output.ts` | Bounded immutable command logs, previews and output_read |
| `packages/runtime/src/tools/web.ts`, `browser.ts` | [HTTP research](WEB.md) and [local browser](BROWSER.md) entries |

Programmatic createTools without a directory has no local tools. A directory adds read/glob/grep/write/edit/shell/output_read, defaulting to read-only files and shell deny. sum has been removed; model requests omit the tools envelope when the collection is empty. Ordinary entries explicitly select directories/permissions and assemble web/browser. Skills, attachments and Memory wrap general read/write; their own topics define those protocols.

Results use `{ok:true,result}` or `{ok:false,error:{code,message}}`. Recoverable errors return to the model; cancellation throws CANCELLED and stops the turn. Session separately saves failed-turn messages as an attempt. Later request overflow does not roll back file/command effects.

<a id="read-and-query"></a>

## read, glob and grep

read accepts path, offset and limit for known workspace paths. Workspace query belongs to grep. Attachment, Memory and Skill virtual-resource wrappers retain their documented read query protocols. offset is zero-based; limit defaults to 100 and caps at 200. Displayed line numbers start at 1. Files return bounded complete lines; directories return filtered, sorted entries. nextOffset indicates continuation. Paging rereads current content without a workspace snapshot or version token.

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

`tools/shell.ts` coordinates permission snapshots, approval, cwd validation, command records and cleanup-failure lockout. The platform executors in `tools/shell/` only receive the command, cwd, timeout and cancellation signal; they own process lifecycle and return `ProcessResult`. They do not read permission policy or request approval. Policy, approval coordination and command-risk classification remain in `permissions/`.

Input is command with optional cwd and timeoutMs. Commands allow 4000 UTF-16 code units; timeout defaults to 30 seconds and accepts 100–120000 ms. Approval shows the complete command, canonical directory and deadline; cwd is rechecked afterward. File-write authorization is not command authorization.

Each call launches a fresh hidden Windows PowerShell without profile or interactive stdin, using an argument array and EncodedCommand. Working directories do not persist across calls. Only allowlisted runtime environment variables are inherited, excluding model keys and NODE_OPTIONS. PATH/PSModulePath remain trusted host configuration; filtering cannot isolate disk credentials readable by the account.

The additional Linux evaluation path uses `/bin/bash --noprofile --norc -c` in a new process group, with no stdin and no persistent shell state. `tools/shell/bash.ts` retains the same ProcessResult contract and an explicit Linux environment allowlist; BASH_ENV, ENV, SHELLOPTS, loader hooks and provider credentials are not inherited. Tool descriptions and system guidance select the actual platform. Other platforms remain unsupported by shell. Linux does not use the PowerShell risk classifier: every Free to go Bash command requires approval. A headless task must select an explicit workspace-write/shell-allow policy or deny shell.

Combined stdout/stderr capture is limited to 1 MiB raw bytes, independently of the model preview. Overflow, timeout and cancellation trigger bounded process-tree cleanup. Cleanup does not target the old PID after parent exit; detached descendants may survive. Unconfirmed cleanup records unconfirmed and blocks further commands on the same Tools instance. There is no Job Object guarantee, background-service or interactive-command support.

Linux sends SIGKILL immediately to the owned process group, following the inspected pi executor, and waits up to five seconds for stream/process settlement. This deliberately replaces the earlier proposed TERM/grace escalation: a delayed signal after the leader exits can target a reused identifier or miss a TERM-ignoring child. A stopped zombie can still await init reaping. Processes that escape the group need container teardown; `tree-killed` confirms group termination/settlement, not isolation. Both native executors reject already-aborted launches before spawning.

Results reflect PowerShell errors and external exit codes. Chained native commands should check LASTEXITCODE individually. Tool ok is not command success; truncated output is not complete verification. cwd is only a launch location, not an OS sandbox.

## output_read and captured output

Each shell result includes outputId (the command record ID), preview stdout/stderr, outputTruncated and the original status/exitCode/cleanup/truncated fields. Each stream preview allows 8000 JSON-escaped content bytes. outputTruncated only means the preview is shortened; truncated means capture overflow. success requires completed, exit code zero, no capture truncation and confirmed cleanup.

output_read takes outputId, never a filesystem path. action=read (default) pages stdout (default) or stderr by Unicode code-point offset, default limit 4000 and maximum 12000; tail=true reads the suffix and excludes offset. action=search accepts a case-sensitive literal query up to 512 UTF-16 code units, with offset counting matching lines and limit default 100/max 200. Read content and search-match JSON have separate 12000-byte page budgets. Long search lines use bounded previews plus textTruncated and characterOffset for expansion. Follow nextOffset with identical options. captureTruncated describes the stored capture, independently of page truncated.

Logs are immutable in-memory captures owned by the workspace Tools instance, at most 20 commands, each captured at most 1 MiB raw bytes. Parent/child tools share them, including failed-command captures; a mode downgrade denies reads from unrestricted launches. New unrelated Tools instances and restarted processes cannot resolve old IDs. Session history persists only returned previews/pages, not the entire capture. No persistent log directory or cleanup job is introduced.

## Journals and verification

Each Tools instance retains at most 100 staged write records and 20 command launches. Parents/children share them; workspace caching preserves them; accessors return defensive copies. Early argument/permission rejection cannot pretend execution occurred. Write records contain status, path, hash and size; command records contain exit/cleanup facts and bounded summaries. Temporary request guidance/events may use them without copying journals into successful history.

[Execution reports](EXECUTION_REPORT.md) deduplicate by ID and aggregate. Failure and new sessions do not clear facts; restarts do not restore journals. Test results are not strongly bound to all relevant file versions.

Key checks cover paging, size/encoding rejection, query completeness, post-approval conflicts, publication/cleanup failure, cancellation, shared children, real PowerShell nonzero exits and descendant cleanup. Fixed model read/edit/read or coding examples do not establish general correctness. Future Task acceptance, file snapshots and reliable process isolation need separate designs, not many specialized model tools.
