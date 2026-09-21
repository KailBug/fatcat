# Fatcat

A minimal TypeScript Agent Harness that runs natively on Windows.

## Current capabilities

The CLI runs a single task or an in-memory conversation through DeepSeek Chat Completions. The model can answer directly, call the pure `sum` tool, or inspect text files in an explicitly selected workspace; the harness validates arguments, executes the tool, returns the associated result, and continues until a final answer or a bounded failure.

The implementation includes isolated in-memory sessions, continuous chat, a shared asynchronous tool collection, optional read-only workspace tools, multiple sequential tool calls, a per-turn iteration limit, request deadlines, cancellation, and basic event logs. An optional bounded subagent can handle isolated tasks. It has no persistent sessions, plugins, channels, long-term memory, recovery checkpoints, Graph engine, or UI.

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

If PowerShell blocks `pnpm.ps1`, use `pnpm.cmd` instead. The start and test scripts compile before execution.

## Configuration

Preserve any existing local configuration:

```powershell
if (-not (Test-Path -LiteralPath .env)) {
  Copy-Item -LiteralPath .env.example -Destination .env
}
```

Edit `.env` locally and set a real DeepSeek API key:

```dotenv
DEEPSEEK_API_KEY=replace-with-your-deepseek-api-key
DEEPSEEK_MODEL=deepseek-flash
HARNESS_MAX_ITERATIONS=8
HARNESS_REQUEST_TIMEOUT_MS=60000
```

Do not commit or share credentials. The example key above is a placeholder.

| Variable | Behavior |
| --- | --- |
| DEEPSEEK_API_KEY | Required; never included in logs |
| DEEPSEEK_MODEL | Defaults to deepseek-flash |
| HARNESS_MAX_ITERATIONS | Positive safe integer; defaults to 8 model requests per user turn |
| HARNESS_REQUEST_TIMEOUT_MS | Positive integer up to 2147483647; defaults to 60000 milliseconds per request |

Process environment variables take priority over `.env`. Optional variables use defaults only when absent; explicitly empty values are errors.

```powershell
pnpm start --checkConfig
```

This command checks local fields without contacting DeepSeek. It does not validate credentials or account access.

## Run a task

```powershell
pnpm start "Explain what an agent loop does in one sentence."
pnpm start --prompt "Use the sum tool to add 17 and 25, then report the total."
```

The CLI writes the final answer to stdout and JSON event logs to stderr. Logs include model iteration numbers, tool names and call IDs, tool success/failure, and termination reasons. They omit prompts, tool arguments, raw provider errors, and API keys. For use in a pipeline without package-manager output:

```powershell
pnpm run build
node --env-file-if-exists=.env dist/src/cli.js --prompt "Use the sum tool to add 17 and 25."
```

Press Ctrl+C to cancel. A single-task invocation starts fresh history. No arguments displays help; use `--chat` for a continuous conversation.

The `sum` tool accepts 2 to 32 finite numbers and returns a finite JavaScript-number sum. Invalid arguments, unknown tools, and arithmetic overflow return structured errors to the model so it can correct its next call. Filesystem tools require an explicit `--workspace` selection. No file-writing, shell, or network tools are exposed.

Each model request counts as one iteration; each new user turn receives a fresh iteration budget. If the last allowed request still asks for tools, the harness stops without executing those calls. Timeouts and transport failures stop the run; automatic SDK retries are disabled.

| Exit code | Meaning |
| --- | --- |
| 0 | Final answer, clean chat exit, help, or valid local configuration |
| 1 | Configuration, model, protocol, or iteration-limit failure; chat also returns 1 if any turn failed |
| 2 | Invalid CLI usage or empty prompt |
| 130 | User cancellation |

## Read a workspace

Select the directory whose text files you want the model to use:

```powershell
pnpm start --workspace examples/workspace --prompt "Read project-notes.txt and report its verification phrase."
pnpm start --chat --workspace examples/workspace
```

`--workspace` works with a single prompt or `--chat`; it cannot be used alone or with help/configuration checks. Without it, only `sum` is available. A path that cannot be resolved to an existing directory fails configuration before any model request. The chosen workspace stays fixed throughout a chat, including after `/reset`.

| Tool | Behavior |
| --- | --- |
| list_directory | List allowed text files and directories at a relative path; `.` means the workspace root. Non-recursive; at most 100 entries, with a `truncated` flag for partial listings. |
| read_file | Read a regular UTF-8 text file by relative path, up to 65536 bytes. Oversized or binary files return an error instead of partial content. |

Both `/` and Windows `\` path separators are supported. Absolute paths, parent traversal, Windows device/data-stream paths, dot-prefixed names (including `.env` and `.git`), `node_modules`, symbolic links, junctions, and file hard links are rejected. Listings omit unsupported files and stop after scanning at most 1000 entries; there is no pagination yet. Supported text extensions are listed in [Tools architecture](docs/ARCHITECTURE/TOOLS.md).

When the model reads a file, its contents enter the conversation and are sent to DeepSeek. Choose a directory appropriate for that use; path and extension checks do not redact secrets stored in ordinary text files. This is a read-only scope check, not an operating-system sandbox against another process changing files concurrently.

File errors return structured tool results that the model can correct or explain. Logs omit file contents and path arguments. Local files are treated as data and cannot change the enabled tools. File access does not write or execute workspace content.

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

Answers go to stdout. Terminal prompts, command feedback, and event logs go to stderr. Chat events include a user-turn number; reset does not rewind that number. Standard input can also supply lines through a pipe. At end-of-input the harness finishes queued lines and exits; `/exit` skips later queued lines. Press Ctrl+C to cancel the active turn and exit with code 130. On Windows, `/exit` is the simplest way to finish from the terminal.

Successful turns keep the full user, assistant, and tool messages in memory. Failed or cancelled turns do not enter the saved history. A model failure displays an error and lets you continue; the eventual chat exit code is 1 if any turn failed. This discards local messages only; API requests already made may still consume credits.

History is lost on exit and is not automatically trimmed or summarized. Long conversations can reach provider context limits; use `/reset` to start fresh. There is no session storage or recovery in this increment.

## Delegate a task

```powershell
pnpm start --subagent --prompt "Delegate adding 8 and 13 to a child using sum, then report its result."
pnpm start --chat --subagent --workspace examples/workspace
```

`--subagent` enables `delegate_task`; it does not force every request to use delegation. It works with a prompt or `--chat`, optionally with a workspace. It cannot be used alone or with help/configuration checks.

The parent supplies a self-contained `task` string of 1 to 4000 characters. A child starts with fresh history and the same DeepSeek configuration and basic tools, including the selected read-only workspace. It cannot see the parent conversation or delegate further. Its final answer returns as tool data; its internal messages stay out of the parent history. Answers longer than 12000 characters return an error rather than a successful partial answer.

Each user turn may start at most two child tasks, including failed attempts. Each child gets at most three model requests, further capped by HARNESS_MAX_ITERATIONS. The parent's own request limit is unchanged: with the default limit of 8, the total upper bound is 14 requests per user turn. Tasks run sequentially. A new user turn gets a fresh allowance.

Child failures become safe tool errors so the parent can continue or explain the limitation. Ctrl+C cancels both parent and child. Nested `subagent_event` logs include the parent tool-call ID; chat also supplies the user-turn number. Logs omit task text, answers, file contents, and credentials.

This is an in-process child loop, with no parallel scheduler, background task, persistence, or recovery. Delegation can add latency and API cost; this increment makes no claim of better task success or lower token usage.

## Verification

```powershell
pnpm run typecheck
pnpm test
```

Automated tests use fake credentials and injected transports; they do not load `.env` or call a model service.

With a real local key, explicitly run:

```powershell
pnpm run verify:live
```

This checks a direct answer, a sum-tool round trip, a contextual follow-up, and directory listing/file reading against `examples/workspace`. It also checks child delegation with a file-tool result returned to the parent. The first three scenarios each allow at most three model requests; the workspace scenario allows four; the delegation scenario allows three parent requests plus up to six child requests, for at most 22 total. These explicit live checks can consume API credits. They only read the committed sample directory, not arbitrary local files. The current Windows implementation has passed offline tests and live DeepSeek checks; detailed results and limitations are in [PROGRESS.md](docs/PROGRESS.md).

The provider protocol follows the [DeepSeek API documentation](https://api-docs.deepseek.com/) using openai 7.18.0 as a compatibility client. Thinking and streaming are explicitly disabled for this first loop. SDK client usage was checked against [official OpenAI documentation](https://developers.openai.com/api/docs/libraries) and the installed SDK.

## Project documents

- [Project goals and boundaries](docs/PROJECT.md)
- [Roadmap](docs/ROADMAP.md)
- [Progress and verification](docs/PROGRESS.md)
- [Architecture overview](docs/ARCHITECTURE/README.md)
- [Agent Loop architecture](docs/ARCHITECTURE/AGENT_LOOP.md)
- [Session architecture](docs/ARCHITECTURE/SESSION.md)
- [Tools architecture](docs/ARCHITECTURE/TOOLS.md)
- [Subagent architecture](docs/ARCHITECTURE/SUBAGENT.md)
- [Development guidelines](AGENTS.md)

All repository text outside docs/ must be English. Chinese is allowed only under docs/. Runtime user input and model output may use any language.
