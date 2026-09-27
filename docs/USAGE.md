# Fatcat usage guide

[Back to Fatcat](../README.md)

Run all commands below from the repository root.

A TypeScript Agent Harness that runs natively on Windows.

The near-term goal is a local coding agent that reads projects, makes controlled changes, runs verification, and delivers reviewable results through the CLI. Workspace reading, bounded literal text search, and controlled text-file creation and editing are available. Foreground Windows PowerShell execution is available with separate command authorization. Bounded delegation is available by default, with the model choosing whether to use it for the task. TUI, Web UI, app, and channel work is deferred. See the [architecture overview](ARCHITECTURE/README.md) and [roadmap](ROADMAP.md).

## Current capabilities

The CLI runs a single task or an in-memory conversation through DeepSeek (default), Kimi, MiMo, or Qwen Chat Completions. The model can answer directly, call the pure `sum` tool, load local Skills, inspect text files in an explicitly selected workspace, propose a write, or run a command after terminal approval; the harness validates arguments, executes the tool, returns the associated result, and continues until a final answer or a bounded failure.

The implementation includes isolated in-memory sessions, continuous chat, a shared asynchronous tool collection, paged workspace reading, guarded writing, and bounded command execution, multiple sequential tool calls, a per-turn iteration limit, request deadlines, cancellation, basic event logs, and deterministic per-turn execution reports. Oversized requests can omit older successful read payloads with explicit markers while preserving full saved history. The model can delegate focused tasks to bounded subagents with isolated history. It has no persistent sessions, plugins, channels, long-term memory, recovery checkpoints, Graph engine, or UI.

The shared system prompt asks Fatcat to respond concisely in your language, inspect relevant code before edits, complete authorized implementation work, and report checks actually performed. It avoids unsolicited edits for review-only questions and keeps assumptions separate from observed facts. This is model guidance, not a guarantee of correctness or an additional permission mechanism. Restart the CLI after changing the prompt source and rebuilding.

## Windows setup

Use Node.js 24.x and pnpm 11.21.0. No WSL, Docker, Bun, or global TypeScript installation is required. Get Node.js from the [official download page](https://nodejs.org/en/download).

If pnpm is missing, install it with `npm install --global pnpm@11.21.0`. Existing pnpm/Corepack installations can use the version pinned in package.json.

Run in the project root using PowerShell:

```powershell
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm start --help
```

If PowerShell blocks `pnpm.ps1`, use `pnpm.cmd` instead. The start and test scripts build before execution. Building compiles TypeScript, validates the built-in Skill assets, and refreshes their copy under `dist/src/skill`.

## Configuration

Preserve any existing local configuration:

```powershell
if (-not (Test-Path -LiteralPath .env)) {
  Copy-Item -LiteralPath .env.example -Destination .env
}
```

Edit `.env` locally and set the selected provider's API key. DeepSeek remains the default:

```dotenv
HARNESS_PROVIDER=deepseek
DEEPSEEK_API_KEY=replace-with-your-deepseek-api-key
DEEPSEEK_MODEL=deepseek-flash
HARNESS_MAX_ITERATIONS=8
HARNESS_REQUEST_TIMEOUT_MS=60000
HARNESS_MAX_REQUEST_BYTES=262144
```

Do not commit or share credentials. The example key above is a placeholder.

| Variable | Behavior |
| --- | --- |
| HARNESS_PROVIDER | deepseek (default), kimi, mimo, or qwen |
| HARNESS_MAX_ITERATIONS | Positive safe integer; defaults to 8 model requests per user turn |
| HARNESS_REQUEST_TIMEOUT_MS | Positive integer up to 2147483647; defaults to 60000 milliseconds per request |
| HARNESS_MAX_REQUEST_BYTES | Positive integer up to 16777216; defaults to 262144 bytes (256 KiB) per complete model JSON request body |

Each provider has separate credentials and model settings. Only the selected provider's settings are read:

| Provider | Required key | Model variable and default | Optional region |
| --- | --- | --- | --- |
| deepseek | DEEPSEEK_API_KEY | DEEPSEEK_MODEL=deepseek-flash | Fixed DeepSeek endpoint |
| kimi | MOONSHOT_API_KEY | KIMI_MODEL=kimi-k2.6 | KIMI_REGION=cn (default) or global |
| mimo | MIMO_API_KEY | MIMO_MODEL=mimo-v2.6-flash | Fixed MiMo endpoint |
| qwen | DASHSCOPE_API_KEY | QWEN_MODEL=qwen-plus | QWEN_REGION=cn (default) or intl |

For example, choose Kimi by setting `HARNESS_PROVIDER=kimi`, `MOONSHOT_API_KEY`, and the region matching that account. MiMo uses `HARNESS_PROVIDER=mimo` and `MIMO_API_KEY`; Qwen uses `HARNESS_PROVIDER=qwen`, `DASHSCOPE_API_KEY`, and the matching region. There is no fallback to another provider's key or OPENAI_API_KEY. See [Provider architecture and development rules](ARCHITECTURE/PROVIDERS.md) for exact endpoints and request fields.

Process environment variables take priority over `.env`. Optional variables use defaults only when absent; explicitly empty selected settings are errors. A chat fixes its provider, model, and region at startup; restart to change them. All profiles use non-streaming, non-thinking, tool-capable Chat Completions. Model overrides must support those capabilities; thinking-only models and reasoning-history protocols are not supported.

```powershell
pnpm start --checkConfig
```

This command checks local fields without contacting a provider. It does not validate credentials or account access. Kimi, MiMo, and Qwen were added using official protocol documentation and offline SDK contract tests; no API online validation is required or performed for those additions in this increment.

## Run a task

```powershell
pnpm start "Explain what an agent loop does in one sentence."
pnpm start --prompt "Use the sum tool to add 17 and 25, then report the total."
```

The CLI writes the final answer to stdout and JSON event logs to stderr. Logs include model iteration numbers, tool names and call IDs, tool success/failure, and termination reasons. Write records also include relative paths, content hashes, byte counts, outcome status, and any residual temporary-file path. They omit prompts, tool arguments, raw provider errors, and API keys. For use in a pipeline without package-manager output:

```powershell
pnpm run build
node --env-file-if-exists=.env dist/src/cli.js --prompt "Use the sum tool to add 17 and 25."
```

Press Ctrl+C to cancel. A single-task invocation starts fresh history. No arguments displays help; use `--chat` for a continuous conversation.

The `sum` tool accepts 2 to 32 finite numbers and returns a finite JavaScript-number sum. Invalid arguments, unknown tools, and arithmetic overflow return structured errors to the model so it can correct its next call. Workspace files require an explicit `--workspace` selection; discovered Skills have a separate, read-only `skill://` scope. Writing asks for yes/no in an interactive terminal by default; shell uses separate authorization; there is no dedicated network tool.

Each model request counts as one iteration; each new user turn receives a fresh iteration budget. If the last allowed request still asks for tools, the harness stops without executing those calls. Timeouts and transport failures stop the run; automatic SDK retries are disabled.

| Exit code | Meaning |
| --- | --- |
| 0 | Final answer, clean chat exit, help, or valid local configuration |
| 1 | Configuration, model, protocol, or iteration-limit failure; chat also returns 1 if any turn failed |
| 2 | Invalid CLI usage or empty prompt |
| 130 | User cancellation |

## Review execution evidence

Each started CLI task emits one `execution_report` JSON event to stderr when the root loop answers or stops. Chat reports include the user-turn number. Stdout remains the model answer. Help, configuration checks, local chat commands, and failures before the loop starts do not produce a report. Low-level `runAgent`/Session callers can opt into the same observer with `createTurnReporter`; their return values are unchanged.

The report is computed from observed events, including child events, independently of the model's final wording:

| Field | Meaning |
| --- | --- |
| outcome / stopCode | `answered` means the model returned an answer; `stopped` includes the stop reason. Neither certifies task success. |
| taskVerification | Always `not_assessed`: the harness has not evaluated task acceptance criteria. |
| modelRequests | Parent and child model-call attempts, including locally rejected requests; not confirmed HTTP calls or billing. |
| requestBytes | Separate parent/children counts: checked, rejected by the local budget, and maxBytes after any context reduction (including rejected bodies). No observation means maxBytes is null. |
| contextReduction | Separate parent/children requests, omittedReadResults, and bytesSaved. Counts each request projection, including attempts still rejected afterward; repeated omission of the same result counts again. Byte differences are not token or billing savings. |
| tokenUsage | Separate parent/children reportedRequests and totals (promptTokens, completionTokens, totalTokens). Totals sum only valid provider reports; null means no known total. Fewer reports than attempts means incomplete usage coverage. |
| toolResults | Counts of returned `ok` and `errors`, including children and delegation calls. A shell `ok` does not imply a zero exit code. Cancelled tools may leave records without returning a tool result. |
| writes | Current-turn write records with paths, hashes, byte counts, and actual statuses. Shared parent/child records appear once per record ID. |
| commands | Current-turn command IDs, cwd, status, exit code, truncation and cleanup metadata. No command text or output bodies. |
| commands[].succeeded | Completed with exit code 0, no output truncation, and no unconfirmed cleanup; says nothing about the command's relevance or coverage. |
| commands[].laterWriteAttempt | A new or changed write-tool record was observed after this command. Even a failed or uncertain staged attempt conservatively sets this flag. |

A report with `commands: []` has no command execution evidence for that turn, even if the answer says tests passed. A command with `laterWriteAttempt: true` predates a later write attempt; review whether checks need rerunning. A false value is not a freshness guarantee: commands themselves and other processes can change files without write-tool records. Journal summary truncation (`outputSummaryTruncated`) differs from process-output truncation (`truncated`); the former does not change the recorded exit outcome.

Every user turn gets a new report; earlier records survive in the shared journals but are not presented as newly executed after a follow-up or `/reset`. Reports preserve effects observed before failure or cancellation, but do not rewrite the model's answer, change existing exit codes, persist to disk, or provide crash recovery. Full claim validation, file-version binding, and task acceptance gates remain unimplemented.

## Model request size and usage

Before sending to the selected provider, Fatcat measures the complete JSON body in UTF-8, including JSON escaping, system and parent guidance, Skill metadata, tool definitions, conversation history, tool results, execution records and provider-specific generation settings. HTTP headers and the API key are excluded. At most HARNESS_MAX_REQUEST_BYTES is allowed; an exact match is accepted. This is a local byte limit, not a token estimate, provider context window, or spending limit.

If the complete body is too large, Fatcat first replaces eligible older successful read results with explicit `context_omitted` markers, oldest first, stopping as soon as the request fits. Files, directories and search results are eligible only before the most recent completed user turn. The current and most recent completed turns remain intact, as do all user/system/assistant messages, tool-call arguments and IDs, errors, loaded SKILL.md instructions, other tool results, and independent write/command records. Skill reference pages are ordinary file/directory/search results and can be omitted when eligible. This happens automatically without another model call or a capability flag.

Each marker retains the result kind and path and states that the content is unavailable in this request. The model can repeat the original or a narrower read when needed; that reads the current file under the same permissions, not an archived snapshot. Full Session history is unchanged. Every request is prepared again from that history, so a shorter later request may include previously omitted contents. There is no model-generated summary or persisted reduction.

A request that is still oversized stops with MODEL_CONTEXT_LIMIT before transport. In chat, the previous successful history remains. Use a smaller task or `/reset` to clear conversation history. Already committed edits and commands remain; their records survive reset and still count toward the next request. If those records alone exceed the limit, inspect them before starting a new process or explicitly raising the configured limit. A new process loses its in-memory history and journals.

The context_reduction event records beforeBytes, afterBytes and omittedReadResults only when a projection changes the body; it contains no paths or contents. The model_input event contains the final bytes, limitBytes and accepted, plus the iteration; accepted means it passed the local size check, not that the server accepted it. The model_usage event reports valid provider token counts or null. Missing, malformed or inconsistent counters stay unknown and do not invalidate an otherwise valid answer. Received counts are retained even if the answer is truncated or fails protocol validation; transport errors or early cancellation may have no usage report.

The execution report aggregates parent and child observations separately. It never estimates missing usage, cache prices or currency cost. Known zero counts differ from unknown totals; an aggregate exceeding safe integer precision also becomes null. No usage data is inserted into the model conversation. Request size is checked after constructing the body, so this does not bound process memory. Large user instructions, copied assistant text, execution records or current-turn reads may still exceed the budget. Fresh single-task and child histories have no eligible older turns. The provider may also reject a request within the local byte budget. See [Context architecture](ARCHITECTURE/CONTEXT.md) for the exact boundary.

## Use local Skills

Fatcat discovers local and built-in Skills automatically at startup. A Skill is a directory containing a UTF-8 `SKILL.md` with YAML metadata and task instructions. Only metadata, including name, description, source scope and a read URI, is initially shown to the model; the full document is loaded when needed through the existing `read` tool.

Four built-in Skills are available without installing anything:

| Skill | Subsystem | Use |
| --- | --- | --- |
| workspace-editing | tools | Inspect current code, make focused edits, and check the result within existing permissions. |
| focused-delegation | subagent | Give bounded independent investigations or reviews to children with self-contained context. |
| context-recovery | context | Reread current evidence after omitted reads, external changes, failure, or reset. |
| verification-handoff | execution-report | Assess actual check results and hand back the work with accurate limitations. |

These are instructions for Fatcat to work on your coding tasks. They follow the target project's conventions and do not impose Fatcat's own source layout or package manager. The model chooses whether to read them; bundling them does not automatically load their full text or grant permissions.

The search order is:

1. `<workspace>/.fatcat/skills/<name>/SKILL.md`, when `--workspace` is supplied.
2. `<workspace>/.agents/skills/<name>/SKILL.md`.
3. `<user-home>/.fatcat/skills/<name>/SKILL.md`.
4. `<user-home>/.agents/skills/<name>/SKILL.md`.
5. Built-in assets beside the running module, at `dist/src/skill/<subsystem>/<name>/SKILL.md` in this repository's build.

The first valid occurrence of a name wins, so workspace or user Skills can override a built-in with the same name. Local roots contain one level of Skill directories; built-ins add a subsystem grouping level. Fatcat does not search ancestor repositories, download Skills, or install them. Without `--workspace`, it still discovers user and built-in Skills. Built-in paths are relative to the running module rather than the launch directory, so starting the compiled CLI from another directory retains them. Ordinary workspace read still rejects hidden paths.

To list discovered metadata and diagnostics locally, without a provider key or network request:

```powershell
pnpm start --listSkills
pnpm start --listSkills --workspace examples/workspace
```

Built-in entries have `scope: "builtin"` and a `subsystem` field. All sources share the same URI format, for example `skill://workspace-editing/SKILL.md`; the subsystem is not part of the URI. You can use a built-in immediately:

```powershell
pnpm start --workspace examples/workspace --prompt 'Use $workspace-editing to inspect the project and make the requested change.'
```

Replace the generic task text with the change you want. Asking by purpose also lets the model select a relevant Skill without a name mention.

For example, create `.fatcat/skills/code-review/SKILL.md` under your chosen workspace:

```markdown
---
name: code-review
description: Review a local code change for correctness and missing verification.
---
Inspect the changed code and relevant callers. Report actionable issues with
file locations. Use references/checklist.md if it is present. Describe checks
actually performed and separate assumptions from observed facts.
```

The name must match its directory and contain 1–64 lowercase ASCII letters, digits or hyphens, with no leading, trailing or consecutive hyphens. Description must be nonblank and at most 1024 characters. SKILL.md is limited to 32 KiB; invalid YAML, duplicate keys, aliases and custom tags are rejected. Optional fields such as `allowed-tools` do not grant permissions. Discovery accepts at most 64 Skills across all sources; a scanned directory with over 128 raw entries is skipped with a diagnostic. The built-in root and each subsystem directory have that same entry limit.

Ask for the task by purpose, or mention the name:

```powershell
pnpm start --workspace examples/workspace --prompt 'Use $code-review to review the project.'
```

Use PowerShell single quotes to preserve the literal `$`. Mentions are model guidance, not a local slash command or deterministic instruction injection. The model reads `skill://code-review/SKILL.md` to receive the entire document; partial reads and queries of that file are rejected. References resolve inside the same Skill, such as `skill://code-review/references/checklist.md`, and retain normal text, paging and search limits. Traversal, links, hidden resource paths and unsupported files are rejected.

Skill metadata and loaded contents can be sent to your selected model provider. Skills guide the task but do not grant write or shell access. Bundled scripts are not automatically executed; any proposed shell command uses the same separate authorization. Successful turns preserve loaded instructions in the Session and protect them from old-read omission. Failure discards new loads, and `/reset` clears the instruction history while retaining the startup catalog and execution records. Restart after adding Skills or changing their metadata; there is no catalog hot reload.

Built-in source files live under `src/skill/<subsystem>/<name>/SKILL.md`; run `pnpm run build` after changing them. Keep `dist/src/skill` with the compiled application when copying build outputs. A missing built-in installation produces a diagnostic; rebuilding restores the assets. Build refresh affects that generated directory only, not your workspace or user Skills. Normal CLI use needs no capability flag. The four built-in workflows have offline loading and integration coverage; their effect on real model task performance has not been validated online. See [Skills architecture](ARCHITECTURE/SKILLS.md) for exact boundaries.

## Read a workspace

Select the directory whose text files you want the model to use:

```powershell
pnpm start --workspace examples/workspace --prompt "Read project-notes.txt and report its verification phrase."
pnpm start --chat --workspace examples/workspace
```

`--workspace` works with a single prompt, `--chat`, or the local `--listSkills` command; it cannot be used alone or with help/configuration checks. Without it, the parent has `sum` and `delegate_task`; children have `sum`, and both have `read` for discovered user or built-in Skills. This does not grant access to ordinary workspace paths. A path that cannot be resolved to an existing directory fails configuration before any model request. The chosen workspace stays fixed throughout a chat, including after `/reset`.

The workspace exposes general-purpose `read`, `write`, and `shell` tools, with each write requiring approval by default. The `read` tool accepts files or directories. It replaces `list_directory` and `read_file`; the old names are no longer accepted.

| Input | Behavior |
| --- | --- |
| path | Required relative file or directory path; `.` lists the root. |
| query | Optional case-sensitive literal substring; searches one file or a directory recursively. No regex. |
| offset | Optional zero-based line, sorted-entry, or matching-line offset; defaults to 0. |
| limit | Optional integer from 1 to 200; defaults to 100 lines, entries, or matches. |

Without query, file results include content, totalLines, and one-based startLine/endLine. Directory results include filtered entries and totalEntries. Both include truncated and nextOffset: continue with the same path and nextOffset until it is null. Empty or past-end pages have no continuation. For example, asking to read lines 21 through 40 should use offset 20 and limit 20.

```powershell
pnpm start --workspace examples/workspace --prompt "Read project-notes.txt one line at a time using read with limit 1. Follow nextOffset until the end and report the verification phrase."
```

Files must be supported UTF-8 text, at most 1 MiB. Each content page has a 16 KiB UTF-8 budget and preserves whole lines and original line endings; a line exceeding the budget returns OUTPUT_LIMIT. This budget excludes metadata and JSON escaping. Listings are non-recursive and sorted before pagination; more than 1000 raw directory entries returns DIRECTORY_TOO_LARGE. A known child path can still be read directly. Directory entry payloads also have a 16 KiB budget.

Each page is a fresh read, not a snapshot; changes between calls can shift offsets. Streaming access to larger files is not implemented. Both `/` and Windows `\` separators are supported. Absolute paths, parent traversal, Windows device/data-stream paths, dot-prefixed names (including `.env` and `.git`), `node_modules`, symbolic links, junctions, and file hard links are rejected. Listings omit unsupported files. Supported text extensions are listed in [Tools architecture](ARCHITECTURE/TOOLS.md).

When the model reads a file, its contents enter the conversation and are sent to the selected provider. Choose a directory appropriate for that use; path and extension checks do not redact secrets stored in ordinary text files. These are application-level scope checks, not an operating-system sandbox against another process changing files concurrently.

File errors return structured tool results that the model can correct or explain. Read logs omit file contents and path arguments. Local files are treated as data and cannot change tool permissions. Reading does not write or execute workspace content.

## Locate code with text search

Ask the agent to locate relevant code before inspecting or editing it, for example:

```powershell
pnpm start --workspace src --permission read-only --prompt "Use read with query createAgent to locate its definition and callers, then explain them."
```

The model can call `read({"path":".","query":"createAgent","limit":20})`. With a directory path, it searches the allowed subtree; with a file path, it searches just that file. Query is a non-blank, valid single-line literal of at most 512 UTF-16 code units. Matching is case-sensitive. There are no regex, glob, or multiline modes.

Results have kind `search`, `totalMatches`, and `matches` containing workspace-relative path, one-based line number, and text without its line ending. A line is returned once even if the query occurs twice. Matches are sorted by path and then line. Follow `nextOffset` with the same path and query; here offset counts matching lines. The JSON-encoded matches array, including escaping and separators, has a 16 KiB budget. A whole match that cannot fit returns OUTPUT_LIMIT.

Each search is limited to 1000 raw directory entries across the subtree, 128 candidate text files and 12 directory levels below the selected path. SEARCH_LIMIT means choose a narrower path; it never returns a partial traversal as exhaustive. Each candidate retains the 1 MiB file limit. The same path/extension restrictions apply as ordinary read; there is no Git ignore support.

`scannedFiles` counts successfully decoded files. During a directory search, oversized or invalid text candidates are skipped and counted in `skippedFiles`, with `complete=false`. Directly searching such a file returns its normal file error. Other access or file-change errors fail the search. `nextOffset=null` only ends pagination: with incomplete coverage, zero matches does not establish absence. Filtered hidden names, dependencies, links and unsupported extensions are outside the search scope, even when complete=true.

Every page rescans current files; there is no index, snapshot, or guarantee against concurrent edits. Matching text enters the model conversation, while event logs omit queries and content. Search requires no write or shell authorization and is available to children through the same read tool.

## Write a workspace

Start normally and ask the agent to make the change:

```powershell
pnpm start --chat --workspace examples/workspace
```

When the model proposes a valid write, the terminal shows its relative path, operation, resulting byte count, and a bounded preview of the new content or replacement fragment. It then asks:

```text
Allow this write? [yes/no]
```

Enter `yes` to approve that specific write or `no` to refuse it. Invalid answers prompt again; closing input refuses the write and Ctrl+C cancels the run. Approval answers are consumed locally and never become chat messages. Each write asks separately, including writes requested by subagents. The file and parent are checked again after approval, so a change made while you were reviewing causes a conflict rather than applying an outdated edit.

The default CLI policy is `ask`; there is no need to restart with an additional permission flag for ordinary interactive editing. Optional policies remain available:

| Option | Behavior |
| --- | --- |
| --permission ask | Request terminal approval for each valid write; the default. |
| --permission read-only | Refuse every write without asking. |
| --permission workspace-write | Preauthorize writes for this invocation, including unattended scripts. |

`--permission` requires a workspace plus a task or chat. Non-interactive input cannot approve writes: a piped `yes` is not authorization, and writes fail promptly unless explicitly preauthorized. Programmatic createTools callers still default to read-only; ask mode requires an approval callback. Single-task invocations support the same terminal confirmation.

Use a disposable workspace when experimenting. Approval previews go to the terminal's stderr and may contain file text; JSON event records still omit file bodies. Preview text is escaped to prevent terminal controls and each preview is capped at 1200 characters with an explicit truncation marker. This is not a full-file diff viewer.

The `write` tool accepts exactly one of these forms:

| Input | Behavior |
| --- | --- |
| path, content | Create a new text file; never overwrite an existing path. Parent directories must already exist. |
| path, oldText, newText | Replace exactly one matching fragment in an existing file. Read first and include exact whitespace and line endings; missing or ambiguous matches return WRITE_CONFLICT. |

The same path and extension restrictions as `read` apply. Files must be valid UTF-8 text within 1 MiB. Edits preserve unrelated content, existing line endings, and the UTF-8 BOM. Writes stage the complete content in the same directory and recheck the target before publishing. This detects changes during staging, but is not a cross-process lock or an operating-system sandbox; another writer can still race the final check. File replacement does not guarantee preservation of all NTFS metadata, ACLs, or alternate data streams. Creation requires filesystem hard-link support.

Each staged attempt has a process-local record with a relative path, before/after SHA-256 hashes, byte count, and status. `committed` records a completed publication; `failed` records an attempt stopped before publication; `uncertain` requires inspecting the current file before retrying. Cleanup errors can accompany a committed change and include the residual temporary path. Records contain no file bodies, and historical hashes do not prove current contents. The journal holds at most 100 attempts; reaching that limit rejects further writes without dropping older records.

Records survive failed turns and `/reset`, and are supplied to subsequent model requests. Already committed changes are not rolled back by cancellation or a later model failure. There is no persistent journal or crash recovery. The write tool does not delete files or create directories recursively; separately authorized shell commands can perform broader operations.

## Run verification commands

Continue using the same interactive CLI; the model can select `shell` as needed:

```powershell
pnpm start --chat --workspace examples/workspace
```

Each command displays its full escaped text, relative working directory, and timeout, then asks `yes/no`. The approval states that the command runs with your user permissions, including access outside the workspace and to the network. Selecting a workspace constrains the initial working directory; it is **not an operating-system sandbox**. The file tools' extension and hidden-path restrictions do not constrain shell commands. Approve only commands appropriate for the task.

| Setting | Behavior |
| --- | --- |
| --shell-permission ask | Default in CLI; each command needs fresh terminal approval. Pipes cannot approve commands. |
| --shell-permission deny | Reject all commands while retaining read/write behavior. |
| --shell-permission allow | Explicitly preauthorize commands for this invocation, including unattended use. |
| --permission read-only | Reject writes and commands; incompatible with shell ask/allow. |
| --permission workspace-write | Preauthorize file writes only; commands still ask unless separately authorized. |

The model input is `{ command, cwd?, timeoutMs? }`. Commands use Windows PowerShell, not Bash. `cwd` defaults to `.` and must resolve to an existing allowed workspace directory. `timeoutMs` defaults to 30000 and accepts integers from 100 to 120000. Commands are limited to 4000 characters. Every call starts a fresh process without a profile, stdin, or persistent variables/directory changes. Use `pnpm.cmd` if Windows PowerShell prevents running pnpm.ps1. Programs requiring a terminal and background services are unsupported.

The result includes `success`, `status`, `exitCode`, `stdout`, `stderr`, `truncated`, `durationMs`, `cleanup`, and `recordId`. Tool `ok: true` means an outcome was returned; **only success: true means the command completed with exit code 0 and no output truncation**. PowerShell terminating errors and native nonzero exit codes fail verification. For multiple native commands, explicitly check each exit code; a later command can replace `$LASTEXITCODE`.

Captured stdout and stderr share a 16 KiB raw-byte limit. Excess output stops the process tree and returns output_limit with truncated=true. Text is decoded as UTF-8; incompatible program encodings may display replacement characters. Timeouts and cancellation request termination of the launched process tree and allow up to five additional seconds for cleanup. Termination is best effort, not a Windows Job Object guarantee: a detached descendant can outlive a normally exited parent. Unconfirmed termination is recorded, and further shell calls using those tools are blocked. Completed file/network effects are never rolled back.

Commands inherit an allowlist of OS/runtime environment variables, excluding the harness API key, arbitrary secrets, and NODE_OPTIONS. They still run under your account and can read files or credentials accessible to it. Command text and output go to the model; do not include secrets in commands or intentionally print them. JSON event logs contain outcome metadata, not command text or output; terminal approval displays the requested command locally.

Command records survive failed turns and `/reset`, and are shared with children. Each keeps the command, cwd, outcome, and at most 1000 Unicode code points per output stream with an explicit summary-truncation flag. After 20 launch attempts, further commands are rejected without dropping old facts. Records disappear on process exit and describe historical runs, not proof that current files still pass verification.

## Continuous chat

```powershell
pnpm start --chat
```

Enter one task per line. For example, ask `Use the sum tool to add 17 and 25.`, then `Add 8 to the previous total using the sum tool.` The second turn includes the previous conversation and tool result.

| Command | Behavior |
| --- | --- |
| /help | Show local chat commands |
| /reset | Clear the completed conversation history |
| /exit | End the chat |

Blank lines are ignored. Lines beginning with `/` are reserved for local commands; unknown commands print a hint without calling the model. Commands must occupy their own line. The `--chat` flag cannot be combined with a prompt, help, or configuration check.

Answers go to stdout. Terminal prompts, approval previews, command feedback, and event logs go to stderr. `You>` is bright green in an interactive terminal; `NO_COLOR`, TERM=dumb, or redirected input/output disables that color. Input and stderr must both be terminals for approval. Earlier queued chat lines cannot approve a later request. Chat events include a user-turn number; reset does not rewind that number. Standard input can also supply lines through a pipe. At end-of-input the harness finishes queued lines and exits; `/exit` skips later queued lines. Press Ctrl+C to cancel the active turn and exit with code 130. On Windows, `/exit` is the simplest way to finish from the terminal.

Successful turns keep the full user, assistant, and tool messages in memory. Failed or cancelled turns do not enter the saved history. A model failure displays an error and lets you continue; the eventual chat exit code is 1 if any turn failed. This discards conversation messages only; file changes and process-local write records remain, and API requests already made may still consume credits.

Saved history is lost on exit and is not automatically trimmed or summarized. Only outgoing requests may omit eligible older read contents as described above. Long conversations can still hit the local request-body budget or provider context limits; use `/reset` to clear conversation history while retaining execution records. There is no session storage or recovery in this increment.

## Delegate a task

```powershell
pnpm start --chat --workspace examples/workspace
```

`delegate_task` is available in ordinary single-task and chat commands. The model chooses when to delegate; no capability flag is required. The old `--subagent` option has been removed and now returns usage exit code 2; remove it from existing scripts.

Parent-only guidance favors direct work for simple questions, arithmetic, and single file operations, and focused delegation for independent investigations or reviews. Children receive concrete context supplied by the parent. Short reviews can still be handled directly; this is model judgment, not a fixed classifier or a guarantee of optimal task splitting. No child requests are made unless the model invokes the tool. Read-only mode still permits delegation while denying writes and commands.

The parent supplies a self-contained `task` string of 1 to 4000 characters. A child starts with fresh history and the same provider configuration and basic tools, including the selected workspace, its permission, and the Skill catalog. A child must load relevant Skill instructions for its own task; it does not inherit the parent's loaded documents. Parent and child share the same write and command journals and approval callbacks; a child cannot elevate access, and its committed writes remain visible even if its turn fails. It cannot see the parent conversation or delegate further. Its final answer returns as tool data; its internal messages stay out of the parent history. Answers longer than 12000 characters return an error rather than a successful partial answer.

Each user turn may start at most two child tasks, including failed attempts. Each child gets at most three model requests, further capped by HARNESS_MAX_ITERATIONS. The parent's own request limit is unchanged: with the default limit of 8, the total upper bound is 14 requests per user turn. Tasks run sequentially. A new user turn gets a fresh allowance.

Child failures become safe tool errors so the parent can continue or explain the limitation. Ctrl+C cancels both parent and child. Nested `subagent_event` logs include the parent tool-call ID; chat also supplies the user-turn number. Logs omit task text, answers, file contents, and credentials.

This is an in-process child loop, with no parallel scheduler, background task, persistence, or recovery. Delegation can add latency and API cost; this increment makes no claim of better task success or lower token usage.

## Verification

```powershell
pnpm run typecheck
pnpm test
```

Automated tests use fake credentials and injected transports; they do not load `.env` or call a model service. They include local Skill loading and SDK request contracts for all four providers. The Kimi, MiMo and Qwen additions use this offline verification only in the current increment; no online API calls are needed for their acceptance. Offline passing tests do not establish real credentials, connectivity or model task behavior.

With a real local key, explicitly run:

```powershell
pnpm run verify:live
```

This checks a direct answer, a sum-tool round trip, a contextual follow-up, paginated reading against `examples/workspace`, child delegation, and a create/read/edit/read round trip. The write scenario uses a fresh temporary directory, verifies exact final bytes and committed records independently, and removes that directory afterwards. The first three scenarios allow three requests each, workspace reading five, delegation up to nine, and writing six: at most 29 total. These explicit checks consume API credits. Reads use synthetic samples and writes are confined to the generated temporary directory. This existing check does not cover command execution; use the separate coding check below. The current Windows implementation has passed offline tests and live DeepSeek checks; detailed results and limitations are in [PROGRESS.md](PROGRESS.md).

For the local coding workflow, run this separate explicit live check:

```powershell
pnpm run verify:coding
```

It creates a temporary nested source module, a caller and a fixed test, verifies the initial failure, then asks DeepSeek to locate the implementation through a read query, inspect and edit it, and run `node --test check.test.mjs`. Only that command and the designated source file are authorized. The script checks that search returned the implementation path and that the caller and test were unchanged, independently reruns the test, and cleans up the fixture. It now uses the same default agent assembly and report observer as the CLI, checks report IDs against the command journal, requires a successful command with no later write attempt, and verifies request-size observations and valid provider token usage for every actual model call. It permits at most eight parent requests plus two children of at most three requests (14 total), and consumes API credits. It does not use or modify `examples/workspace`.

For a two-turn coding task with multiple edited modules, run:

```powershell
pnpm run verify:workflow
```

This separate check creates a temporary synthetic pricing project and reuses one Session for both turns. The first turn must locate and inspect the relevant files, repair two source modules, and run the fixed `node --test check.test.mjs` command. The follow-up adds a discount requirement, new checks, and a user note; it requires fresh reads of both modules, preservation of the note, and an edit to receipt only. Both prompts ask the model to reproduce a failure before editing and rerun the checks afterwards. Only designated source edits and the fixed command are authorized; tests, unrelated source files, and the follow-up's subtotal module must remain unchanged.

For each turn, the script checks new write/command journal IDs against its execution report, requires a failed check and final successful verification after the last write, checks request sizes and valid provider token usage, independently reruns the fixed test, and verifies protected file bytes. It does not separately assert that the failure preceded the first edit. A previous turn's successful command cannot satisfy the follow-up. Offline tests inject a simulated Model and synthetic request/usage observations while using real temporary files and PowerShell; these tests check acceptance conditions without contacting DeepSeek. These are fixture-specific assertions; ordinary CLI reports still use `taskVerification: not_assessed`.

The check allows at most eight parent requests plus two children of three requests per turn: at most 28 real requests across both turns. It consumes API credits, reports failed expectations without automatic retries, and removes its temporary directory afterwards. It does not use `examples/workspace`, require delegation, or replace `verify:coding` or `verify:context`. See PROGRESS.md for actual validation status; this small task does not establish general coding success rates or cost improvements.

To verify default task selection with isolated temporary read-only fixtures:

```powershell
pnpm run verify:delegation
```

This checks arithmetic without child requests, then a task requiring independent second-opinion reviews with separate context. It uses the same agent assembly as the CLI, checks bounded delegation and child reading, checks both filenames in the final answer, and verifies unchanged fixtures and empty write/command journals. The script does not mechanically prove every claim in the review. Each scenario allows at most four parent requests plus two children of at most three requests: at most 20 requests in total, consuming API credits. Model selection can vary; a failed check is reported rather than retried automatically. See PROGRESS.md for observed results and earlier failed checks.

To verify older-read omission and rereading changed content:

```powershell
pnpm run verify:context
```

This separate live check uses three turns in a temporary read-only workspace. The script creates a synthetic file, asks the model to read it, records a follow-up formatting requirement, changes the fixture itself, and adds synthetic request pressure before asking for a fresh first-line read. It requires a reduction event, the updated marker in the final answer, the retained answer prefix, request sizes within the limit, unchanged final fixture bytes, and empty write/command journals. It then removes the temporary directory; it does not use `examples/workspace`.

The check deliberately overrides the local request budget to 26000 bytes and caps each parent turn at three requests; default bounded delegation remains available. With up to two children of three requests per turn, the total upper bound is 27 real requests. It consumes API credits and reports failed expectations without automatic retries. This is a small behavioral check, not a task-success or token-cost benchmark.

Provider protocols use openai 7.18.0 as a compatibility client, with thinking and streaming disabled. Exact endpoints, provider-specific fields, official sources, and the rules for developing a provider are documented in [PROVIDERS.md](ARCHITECTURE/PROVIDERS.md). Existing live verification scripts retain their explicit DeepSeek scope; do not treat their past results as validation of the three new providers or Skills.

## Project documents

- [Project goals and boundaries](PROJECT.md)
- [Roadmap](ROADMAP.md)
- [Progress and verification](PROGRESS.md)
- [Architecture overview](ARCHITECTURE/README.md)
- [Agent Loop architecture](ARCHITECTURE/AGENT_LOOP.md)
- [Session architecture](ARCHITECTURE/SESSION.md)
- [Tools architecture](ARCHITECTURE/TOOLS.md)
- [Subagent architecture](ARCHITECTURE/SUBAGENT.md)
- [Execution reports](ARCHITECTURE/EXECUTION_REPORT.md)
- [Context architecture](ARCHITECTURE/CONTEXT.md)
- [Skills architecture](ARCHITECTURE/SKILLS.md)
- [Provider architecture and development rules](ARCHITECTURE/PROVIDERS.md)
- [Development guidelines](../AGENTS.md)

All repository text outside docs/ must be English. Chinese is allowed only under docs/. Runtime user input and model output may use any language.
