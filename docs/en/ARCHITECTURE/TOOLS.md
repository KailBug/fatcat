# Tools: general protocol and file execution facts

English | [简体中文](../../zh-CN/ARCHITECTURE/TOOLS.md)

[Architecture](README.md) · [Coding guide](../GUIDES/CODING.md)

Tools expose model-visible definitions, argument validation and asynchronous execution. They do not read terminal input themselves. [Permissions](PERMISSIONS.md) owns authorization and shared execution guards; entries supply approval callbacks.

Definitions use Fatcat's `ToolDefinition` with direct name, description, parameters and optional strict fields. Assembly/wrappers do not construct OpenAI's function envelope. Model API encoders add protocol fields, preserving definition content and execution contracts. Tools.execute still parses raw arguments JSON and returns validation failures under the original call ID; see [Model boundaries](PROVIDERS.md#internal-messages-and-api-boundaries).

## Assembly and specialized responsibilities

| Source | Responsibility |
| --- | --- |
| `packages/runtime/src/tools.ts`, `packages/runtime/src/tools/types.ts` | Collection assembly, common results, cancellation and forTurn wrappers |
| `packages/runtime/src/tools/read.ts`, `search.ts` | File/directory paging and literal queries |
| `packages/runtime/src/tools/write.ts` | Exact text creation/replacement, publication protocol and write journal |
| `packages/runtime/src/tools/shell.ts` | Command protocol, authorization, cwd rechecks and command journal |
| `packages/runtime/src/tools/shell/powershell.ts` | Windows PowerShell environment, process execution and cleanup |
| `packages/runtime/src/tools/shell/bash.ts` | Linux Bash environment, process-group execution and cleanup |
| `packages/runtime/src/tools/shell/types.ts` | Shared ProcessResult contract and combined output limit |
| `packages/runtime/src/tools/sum.ts` | Side-effect-free arithmetic |
| `packages/runtime/src/tools/web.ts`, `browser.ts` | [HTTP research](WEB.md) and [local browser](BROWSER.md) entries |

Programmatic createTools without a directory contains only sum. A directory adds read/write/shell, defaulting to read-only files and shell deny. Ordinary entries explicitly select directories/permissions and assemble web/browser. Skills, attachments and Memory wrap general read/write; their own topics define those protocols.

Results use `{ok:true,result}` or `{ok:false,error:{code,message}}`. Recoverable errors return to the model; cancellation throws CANCELLED and stops the turn. Session separately saves failed-turn messages as an attempt. Later request overflow does not roll back file/command effects.

## read and query

read accepts path, offset, limit and optional query. offset is zero-based; limit defaults to 100 and caps at 200. Displayed line numbers start at 1. Files return bounded complete lines; directories return filtered, sorted entries. nextOffset indicates continuation. Paging rereads current content without a workspace snapshot or version token.

query is a case-sensitive, single-line literal substring, not regex, glob or multiline matching. Results sort by path UTF-16 code units then line number; multiple matches on one line return it once. offset counts matches rather than source lines.

| Boundary | Current limit |
| --- | --- |
| Workspace text | 1 MiB per file, strict UTF-8; unsupported control characters rejected |
| File page | 16 KiB body, complete lines; an oversized line explicitly fails |
| Directory scan | 1000 raw entries; entry pages bounded by JSON bytes |
| Search input | query at most 512 UTF-16 code units |
| Recursive search | 1000 raw entries, 128 candidate files, 12 subdirectory levels |
| Search output | matches JSON at most 16 KiB, without truncating full lines |

Traversal overflow fails and asks for narrower scope. Recursive search may skip oversized/unsupported-encoding candidates, returning skippedFiles and complete=false. complete=true only means discovered candidates had no such skips, not full-disk coverage or an unchanged scan. Each page traverses again, without .gitignore parsing or index caching.

Workspace/text-file enforce ordinary naming, extension and link rules. Free to go broadens local access while retaining encoding, size and identity checks. `packages/runtime/src/permissions/text-file.ts` defines the exact extension set. Reads enter model input and plaintext history without implying redaction.

## write publication protocol

Ordinary file writes require exactly one form:

- `{path,content}` creates a new file whose parent exists; existing targets cannot be overwritten.
- `{path,oldText,newText}` replaces one exact fragment. oldText must be nonempty; zero, multiple and overlapping matches are rejected.

Preserve byte semantics outside the fragment, line endings and BOM. Final UTF-8 files remain limited to 1 MiB. After approval, reread identity and original content; reject conflicts without automatic retry.

On entering staging, create a started record and exclusively write/sync a temporary file in the same directory. Recheck directory, target and cancellation before publication. Creation installs the completed temporary file through a hard link; editing replaces via rename. Mark uncertain before publication and committed immediately after confirmation. Cleanup failure may return an error while retaining committed and must not be described as rollback. Inspect current files before retrying publication errors.

This avoids partial in-place writes; it is neither a multi-file transaction nor OS compare-and-swap. A race remains between recheck and publication. NTFS ACLs, alternate data streams and other metadata are not guaranteed to survive completely. There is no deletion, recursive directory creation or automatic recovery; crashes may leave temporary files. Creation requires filesystem hard-link support.

## shell execution boundaries

`tools/shell.ts` coordinates permission snapshots, approval, cwd validation, command records and cleanup-failure lockout. The platform executors in `tools/shell/` only receive the command, cwd, timeout and cancellation signal; they own process lifecycle and return `ProcessResult`. They do not read permission policy or request approval. Policy, approval coordination and command-risk classification remain in `permissions/`.

Input is command with optional cwd and timeoutMs. Commands allow 4000 UTF-16 code units; timeout defaults to 30 seconds and accepts 100–120000 ms. Approval shows the complete command, canonical directory and deadline; cwd is rechecked afterward. File-write authorization is not command authorization.

Each call launches a fresh hidden Windows PowerShell without profile or interactive stdin, using an argument array and EncodedCommand. Working directories do not persist across calls. Only allowlisted runtime environment variables are inherited, excluding model keys and NODE_OPTIONS. PATH/PSModulePath remain trusted host configuration; filtering cannot isolate disk credentials readable by the account.

The additional Linux evaluation path uses `/bin/bash --noprofile --norc -c` in a new process group, with no stdin and no persistent shell state. `tools/shell/bash.ts` retains the same ProcessResult contract and an explicit Linux environment allowlist; BASH_ENV, ENV, SHELLOPTS, loader hooks and provider credentials are not inherited. Tool descriptions and system guidance select the actual platform. Other platforms remain unsupported by shell. Linux does not use the PowerShell risk classifier: every Free to go Bash command requires approval. A headless task must select an explicit workspace-write/shell-allow policy or deny shell.

Combined stdout/stderr is limited to 16 KiB raw bytes. Overflow, timeout and cancellation trigger bounded process-tree cleanup. Cleanup does not target the old PID after parent exit; detached descendants may survive. Unconfirmed cleanup records unconfirmed and blocks further commands on the same Tools instance. There is no Job Object guarantee, background-service or interactive-command support.

Linux sends SIGKILL immediately to the owned process group, following the inspected pi executor, and waits up to five seconds for stream/process settlement. This deliberately replaces the earlier proposed TERM/grace escalation: a delayed signal after the leader exits can target a reused identifier or miss a TERM-ignoring child. A stopped zombie can still await init reaping. Processes that escape the group need container teardown; `tree-killed` confirms group termination/settlement, not isolation. Both native executors reject already-aborted launches before spawning.

Results reflect PowerShell errors and external exit codes. Chained native commands should check LASTEXITCODE individually. Tool ok is not command success; truncated output is not complete verification. cwd is only a launch location, not an OS sandbox.

## Journals and verification

Each Tools instance retains at most 100 staged write records and 20 command launches. Parents/children share them; workspace caching preserves them; accessors return defensive copies. Early argument/permission rejection cannot pretend execution occurred. Write records contain status, path, hash and size; command records contain exit/cleanup facts and bounded summaries. Temporary request guidance/events may use them without copying journals into successful history.

[Execution reports](EXECUTION_REPORT.md) deduplicate by ID and aggregate. Failure and new sessions do not clear facts; restarts do not restore journals. Test results are not strongly bound to all relevant file versions.

Key checks cover paging, size/encoding rejection, query completeness, post-approval conflicts, publication/cleanup failure, cancellation, shared children, real PowerShell nonzero exits and descendant cleanup. Fixed model read/edit/read or coding examples do not establish general correctness. Future Task acceptance, file snapshots and reliable process isolation need separate designs, not many specialized model tools.
