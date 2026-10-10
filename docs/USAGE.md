# Fatcat usage guide

[Back to Fatcat](../README.md)

Run commands below from the repository root unless an example changes directories.

A TypeScript Agent Harness that runs natively on Windows.

The near-term goal is a local coding agent that reads projects, makes controlled changes, runs verification, and delivers reviewable results through the CLI, optional TUI, or local Web UI. Workspace reading, bounded literal text search, and controlled text-file creation and editing are available. Foreground Windows PowerShell execution is available with separate command authorization. Bounded delegation is available by default, with the model choosing whether to use it for the task. App and channel work is deferred. See the [architecture overview](ARCHITECTURE/README.md) and [roadmap](ROADMAP.md).

## Version and project badges

The repository version is **0.1.0**, an early development version. `package.json` is the single source of truth; the package remains private and is run from a checkout. This version does not imply an npm publication or a GitHub release.

```powershell
pnpm start --version
pnpm start -v
# After building, print only the version without pnpm/build output:
node dist/src/cli.js --version
```

Both flags work without provider credentials and do not create a session. The CLI reads Fatcat's manifest relative to its compiled module, even when launched in another workspace.

Use `0.x.y` while the project is under active development: increase the patch for fixes and the minor version for new capabilities or compatibility changes. Document compatibility changes before upgrading; `1.0.0` is reserved for a defined stable compatibility contract. The application version is independent of saved-session and automation schema versions.

The README's version, stars, and CI badges use live [Shields.io](https://shields.io/) data. Version and CI refer to **main**, not the local checkout or the current pull request; CI links to the existing Windows / Node 24 workflow. Runtime, package-manager, language, and platform badges describe repository requirements. Update the static Node.js and pnpm badges in both READMEs when changing those requirements. No package-download or license badge is displayed because this project has no published package or root license declaration.

## Current capabilities

Context commands are available in chat, TUI, and the Web UI composer:

- `/context` shows full-history and projected-conversation JSON bytes and message counts without a model request. These exclude dynamic guidance, execution journals, and tool definitions; they are not token measurements.
- `/compact [instructions]` summarizes older completed turns, keeping the latest completed turn and all original history. For example, `/compact Preserve the API constraints and remaining test failures`. The optional focus must fit within 2048 UTF-8 bytes.

Compaction uses the current provider with no tools, at most `min(HARNESS_MAX_ITERATIONS, 8)` summary requests, and the existing exact request-byte limit. Large older histories are summarized in chronological chunks; planning refuses workloads outside that bound before sending a summary request. A very small request budget, one oversized recent turn, or large execution journals may still prevent progress. There is no automatic compaction or hidden retry. Summaries are lossy; re-read current files and reload skill instructions when needed.

Successful summaries survive resume and fork. Original messages remain available and still count toward the 64 MiB session-file limit. Cancellation, invalid summaries, failed storage, or revision conflicts retain the previous projection; model usage already consumed is still reported. Use Escape/Ctrl+C in TUI, Stop in Web UI, or the chat cancellation signal. Compaction reports are process-local, and restored Web UI history displays the original question/answer turns. TUI process operation totals include compactions; completed conversation turns do not. The context-token display is cleared after compaction until a new ordinary model request supplies actual usage.

The CLI runs a single task or a persistent conversation through DeepSeek (default), Kimi, MiMo, or Qwen Chat Completions. Tasks, chat, TUI, and Web UI use the launch directory as the workspace unless `--workspace` selects another directory. The model can answer directly, call the pure `sum` tool, load local Skills, inspect workspace text files, propose a write, or run a command after approval in the active interface; the harness validates arguments, executes the tool, returns the associated result, and continues until a final answer or a bounded failure.

The implementation includes isolated persistent sessions with local listing, naming, resume and branching, continuous chat, an optional terminal interface with configuration and usage panels, a local browser interface, a shared asynchronous tool collection, paged workspace reading, guarded writing, and bounded command execution, multiple sequential tool calls, a per-turn iteration limit, request deadlines, cancellation, basic event logs, and deterministic per-turn execution reports. Oversized requests can omit older successful read payloads with explicit markers while preserving full saved history. The model can delegate focused tasks to bounded subagents with isolated history. It has no plugins, channels, long-term memory, file recovery checkpoints, or Graph engine.

The shared system prompt asks Fatcat to respond concisely in your language, inspect relevant code before edits, complete authorized implementation work, and report checks actually performed. It avoids unsolicited edits for review-only questions and keeps assumptions separate from observed facts. This is model guidance, not a guarantee of correctness or an additional permission mechanism. Restart the CLI after changing the prompt source and rebuilding.

## Local cron and file-change tasks

Use a normal chat, TUI or Web UI conversation. For example, ask: "Every five minutes, read notes.txt and summarize changes here" or "When src/cli.ts changes, review it and report here." The model submits a structured task through the automation tool; the harness validates and binds it to the current saved session. Each later run continues that conversation and saves its output there.

In chat/TUI, `/cron <description>` creates through the model. `/cron` or `/cron list` lists current bindings; `/cron pause <id>`, `/cron resume <id>` and `/cron delete <id>` manage them locally. The TUI footer and session list show `[clock]` for sessions with tasks.

In Web UI, open **Cron tasks** in the sidebar. Choose an existing session or **Create a new session**, enter the task instructions and select an interval, cron time, one-shot time or file change. The desktop dialog shows the task list beside a compact form; trigger/value and run/expiry limits share rows. On phones, switch between New task and Scheduled. Task cards use Previous/Next pagination and provide pause/resume/delete plus a link to the bound session, keeping creation controls visible without scrolling at standard viewport sizes. A clock appears at the far right of its sidebar title. Running another session's task does not switch the conversation you are viewing.

Keep chat/TUI/Web UI running. Saved task definitions, attempt counts and expiry survive restart, but offline occurrences are not replayed. Defaults are 20 attempts and a 24-hour lifetime per task; up to 1000 attempts and seven days can be requested. A one-shot must occur before expiry. Up to 32 bindings per session, 128 enabled tasks and 64 different watched files per workspace are supported. Forking a session does not copy its tasks; deleting it removes its bindings. Memory-only sessions cannot save tasks.

Automatic turns use current permissions and ordinary approvals; failed/cancelled turns count as attempts. Files are explicit relative text paths, not directories or globs, and must satisfy workspace guards even in Free to go. All changes during an automated turn, including simultaneous external edits, are ignored to prevent self-triggering. Unreadable watched files pause their task with an error. Restarted tasks left running after a crash require inspection and explicit recovery; there is no automatic replay.

### Advanced standalone JSON runner

Use a reviewed JSON configuration inside the selected workspace. This is a separate CLI mode; keep its process running:

```powershell
pnpm start --automation automation.example.json --check-automation
pnpm start --automation automation.example.json --permission read-only
```

The first command validates configuration and watched files without credentials or model requests. The second uses the configured provider and creates a fresh saved session for each trigger. The [example](../automation.example.json) watches `src/cli.ts` and schedules an hourly review. Review and adjust its prompts and paths before running. Relative config and watch paths resolve against `--workspace` or the launch directory, not the config file's parent.

```json
{
  "version": 1,
  "maxRuns": 10,
  "maxRuntimeSeconds": 28800,
  "tasks": [
    {
      "id": "review-source",
      "prompt": "Read src/cli.ts and report issues supported by current evidence. Do not modify files.",
      "trigger": { "type": "file_changed", "paths": ["src/cli.ts"], "debounceMs": 2000 },
      "maxRuns": 5
    }
  ]
}
```

| Trigger | Configuration | Behavior |
| --- | --- | --- |
| Cron | `{"type":"cron","expression":"0 9 * * 1-5","timezone":"local"}` | Weekdays at 09:00 in the machine's timezone; `UTC` is also supported |
| Interval | `{"type":"interval","seconds":300}` | Every five minutes, first firing one interval after startup |
| One-shot | `{"type":"at","time":"2026-10-03T09:00:00+08:00"}` | Once during this process; replace the example with a future timestamp |
| File event | `{"type":"file_changed","paths":["src/cli.ts"],"debounceMs":2000}` | Content changes, creation or deletion after a two-second quiet period |

Cron supports five numeric fields, wildcards, lists, ranges and steps. No seconds, weekday/month names, or named IANA timezones. Day-of-month and weekday use OR when both are restricted. Local DST can skip a nonexistent time or fire twice at a repeated time. Tasks do not fire in the startup minute. While a task is busy, missed cron/interval firings coalesce to one latest activation per task.

Tasks run serially. Defaults are 20 attempts per process, 20 per task, and 24 hours total; failures count and are not retried. Limits are 1–1000 attempts and 1 second–7 days; intervals must be 60 seconds–7 days. Up to 32 tasks and 64 distinct watched text files are supported, with 1–32 files per trigger and 1–60 seconds of debounce. Each file is limited to 1 MiB. Parent directories must exist; directories, globs, hidden paths, links and paths outside the workspace are refused even in Free to go.

Files are polled about once a second while idle. All changes during an automated turn, including external edits, are ignored when the baseline is refreshed afterward. This prevents the task's own writes from triggering another run. A change that returns to identical contents between polls can be missed. Invalid or unreadable watched paths stop the runner explicitly.

Writes and commands retain normal launch permissions and per-operation approval; the config cannot grant permissions. Piped input cannot approve operations. `--permission read-only` is useful for review-only jobs; for authorized unattended writes use `--permission workspace-write`, and authorize commands separately with `--shell-permission allow` when needed. Existing request, delegation and cancellation budgets apply to every activation.

Results are JSON lines on stdout (`automation_finished`); lifecycle and execution reports go to stderr and include task/run identifiers. The returned session ID can be opened with `--resume` or the existing session UI. A completed turn is not a claim that its tests passed. Ctrl+C cancels the active operation and drops queued work; it does not roll back completed file changes. Expiry or exhausted budgets stop with exit code 0 even if individual attempts failed; inspect their result statuses. Ctrl+C returns 130, and configuration/storage/monitor failures return a nonzero status.

This standalone configuration is loaded once; restart to apply edits. Its queues, budgets and file baselines are process-local. Restarting skips overdue one-shots and offline cron occurrences, and restarts intervals and counters. This differs from the persistent counters and shared conversation history of session-bound tasks above. Neither mode installs a daemon or OS scheduler or supports webhooks. A shared workspace lock under the selected session store prevents duplicate schedulers using that store; after a crash, inspect its recorded PID and remove only the reported stale lock after verifying its owner has exited. See [automation architecture](ARCHITECTURE/AUTOMATION.md).

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

If PowerShell blocks `pnpm.ps1`, use `pnpm.cmd` instead. The start and test scripts build before execution. Building compiles TypeScript, validates the built-in Skill assets, and refreshes their copy under `dist/src/skill`. When `pnpm start` is invoked from a repository subdirectory, the build and `.env` loading still use the package root; the launcher then restores the directory where you invoked the command before starting Fatcat.

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
HARNESS_MAX_ITERATIONS=32
HARNESS_REQUEST_TIMEOUT_MS=60000
HARNESS_MAX_REQUEST_BYTES=262144
```

Do not commit or share credentials. The example key above is a placeholder.

| Variable | Behavior |
| --- | --- |
| HARNESS_PROVIDER | deepseek (default), kimi, mimo, or qwen |
| HARNESS_MAX_ITERATIONS | Positive safe integer; defaults to 32 model requests per user turn, including the final response |
| HARNESS_REQUEST_TIMEOUT_MS | Positive integer up to 2147483647; defaults to 60000 milliseconds per request |
| HARNESS_MAX_REQUEST_BYTES | Positive integer up to 16777216; defaults to 262144 bytes (256 KiB) per complete model JSON request body |

The loop tells the model its remaining request allowance and reserves the last request for a final response, with no further tool execution. The response must distinguish completed work from unfinished or unverified work; reaching the budget is not evidence that the task succeeded. A limit of 1 permits a text response only. If the model still requests tools on the final request, `MAX_ITERATIONS` remains a failure. Review files and completed operations before retrying; increase `HARNESS_MAX_ITERATIONS` and restart only when the task needs a larger allowance. Existing interrupted turns are not automatically replayed or repaired.

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

## Local Web UI

After configuring your provider, start the local browser interface:

```powershell
pnpm start --webui
pnpm start --webui --workspace examples/workspace
pnpm start --webui --port 3211 --permission read-only --web-permission deny
```

The default browser opens automatically after the server starts. The complete private link printed in the terminal, including its `#token=...` fragment, remains a fallback if opening fails. Set `FATCAT_WEBUI_OPEN_BROWSER=0` to skip opening during automation or headless runs. The server binds only to `127.0.0.1` on port 3210 by default. Keep the terminal running; Ctrl+C cancels the active turn and stops the server. The launch directory and `.env` loading follow the same rules as CLI chat. `--webui` is exclusive with task, chat, TUI, help, config check, and skill listing; `--port` is only valid with Web UI and accepts 1–65535. A port already in use produces a safe startup error.

The page includes a workspace sidebar, starter prompts, a conversation view, a multiline composer, session details, recent activity, and expandable execution reports. Interface labels and session dates use English; language switching is planned. User text, session names, and model responses retain their original language. Enter sends; Shift+Enter inserts a line break; IME composition does not submit a message. Stop cancels the active turn and leaves the conversation usable. Basic Markdown headings, lists, bold text, code blocks, and HTTP(S) links are supported. HTML is displayed as text. Layout adapts to narrow screens and the system color theme.

Writes and commands use the existing independent permission policies. With the default `ask`, the browser shows the exact file change or PowerShell command and requires **Allow once** or **Deny**. Approval is tied to the pending operation; a stale response cannot authorize another action. `--permission workspace-write` preauthorizes file writes only; `--shell-permission allow` separately preauthorizes commands. Shell runs with current-user access, not an OS sandbox. `--web-permission deny` disables public research independently of the local UI server.

All tabs using this server link share one active session. The sidebar lists all sessions in the same session store, regardless of launch directory. Selecting a session changes the active workspace to its saved directory. Starting Web UI without a session selection, clicking New chat, or deleting the active session opens an unsaved welcome screen; these actions do not add empty sessions to the sidebar or disk. The first submitted message saves the session before model or tool execution, including failed or interrupted attempts. New chat retains the previous conversation. Explicit naming (`--name` or the session API) and forking still save a session immediately; `--continue` and `--resume` still select saved history. Existing empty saved sessions remain available until explicitly deleted.

Right-click a session to open **Session details**, **Rename session**, **Fork session**, or **Delete session**. Keyboard users can focus a session and press Shift+F10 or the context-menu key, then use arrow keys and Enter; Escape or clicking outside closes the menu. Each action targets the selected row, including an inactive session. Renaming or deleting an inactive session leaves the active conversation unchanged; forking opens the new branch. Deleting requires confirmation and permanently removes that session's saved conversation. Session changes do not undo files or commands, or clear process-local journals; management actions are disabled during a turn or approval.

Rename, Fork, and Delete use centered in-page dialogs with English buttons. Rename accepts a new name; Fork optionally accepts a branch name. Cancel or Escape sends no request. Delete focuses Cancel initially and requires explicit confirmation. Validation or server errors remain visible inside the dialog; submissions cannot be duplicated while pending.

The composer has one bottom toolbar: the permission selector and outlined workspace path form the left group; the unbordered context ring/percentage, model and Send form the right group. Both groups share a row on desktop and wrap together on narrow screens. Long paths and model names are truncated; hover for complete values, or inspect Session details. Session rows show only their names; hover to see the turn count and update date, also available to assistive technology. The welcome screen centers the heading and composer, with no starter cards. The sidebar, welcome screen, assistant messages and favicon use the supplied cat logo. Once a conversation begins, the composer stays at the bottom. Neutral black/white/gray surfaces, system sans-serif fonts, rounded cards and pill buttons adapt to light and dark themes. Brief entry and hover transitions respect the system's reduced-motion setting. Lucide icons and their ISC/MIT notices ship locally; the page does not download fonts or icons from a CDN. Each session has an ellipsis action button (always visible on touch screens), opening the same menu as right-click. On phones, opening the sidebar moves focus into it and contains Tab navigation. Its close button, backdrop or Escape dismisses it and restores focus to the toggle; nested menus and dialogs handle Escape first.

Run `pnpm run verify:webui` for a local interface check in installed Edge at 1440, 1024, 390 and 320px, with both themes, mobile keyboard navigation, dialogs, message submission, approval, cancellation and file preview. It also checks all four Cron trigger forms without scrolling at the tested viewport sizes, task pagination and management. It uses temporary sessions, injected model decisions and folder selections without API credentials or model requests. To retain screenshots, set `$env:FATCAT_VERIFY_SCREENSHOTS = 'D:\tmp\fatcat-webui-review'` before running it. Ordinary `pnpm test` remains browser-free.

The composer permission menu lists **Plan**, **Manual**, **Accept edits**, then **Free to go**. Manual asks before every file change and command; Accept edits automatically permits the controlled workspace-write tool while commands still ask; Plan allows reading and public research but denies all writes and commands. Free to go allows local files beyond the workspace, including hidden files, dependency directories and links, and HTTP(S) addresses beyond the public-network boundary, including local/LAN services and custom ports. Ordinary recognized commands run automatically; clearly dangerous commands and opaque forms still ask for approval.

The selector is disabled during a turn, approval, session change, submission, or disconnection. All tabs share the current mode. Switching keeps the draft, conversation and execution journals; it does not undo completed operations or save permissions into session history. Explicit launch `--permission read-only`, `--shell-permission deny`, or `--web-permission deny` limits the available choices; web deny disables Free to go. Other legacy combinations display **Custom permissions**, with the original workspace/public-network scope.

The same modes can be selected at startup for any execution interface:

```powershell
pnpm start --webui --permission-mode plan
pnpm start --webui --permission-mode freeToGo
pnpm start --chat --permission-mode acceptEdits
pnpm start --tui --permission-mode default
pnpm start --permission-mode plan --prompt "Inspect the workspace and propose a small change."
```

Use `--permission-mode` instead of `--permission` and `--shell-permission`; combining them is a usage error. Starting in Plan with `--permission-mode plan` allows a later idle Web UI switch. Legacy flags remain supported and never implicitly select Free to go. Combining `--permission-mode freeToGo` with `--web-permission deny` is a usage error. See [Permission architecture](ARCHITECTURE/PERMISSIONS.md).

Free to go requires a fresh user decision for known deletion/storage/security changes, destructive Git commands, nested interpreters, downloaded-content execution and unknown or dynamic shell forms. The approval shows the complete command, working directory, timeout and reason. An unattended task refuses a command that needs approval and explains how to review it interactively. This is a conservative heuristic, not a sandbox or proof that allowed build scripts, tests, hooks or executable tools are safe. Local access remains subject to Windows account permissions; text tools retain UTF-8, 1 MiB and precise-edit rules, and network tools retain HTTP(S) GET, decoding, size, timeout and cancellation limits.

The context indicator compares the latest parent request's provider-reported input tokens with the selected model's documented context capacity. Hover to see exact counts and the capacity. It does not sum requests or subagents, and excludes unsent draft text and the latest reply. New, restored, or switched sessions have unavailable usage until a request reports it; a new parent request clears the previous observation. Unknown model overrides show their reported input count without an invented capacity or percentage. The local `HARNESS_MAX_REQUEST_BYTES` limit remains a separate byte budget.

If another process changes a session before deletion, the operation is rejected and the saved session list is refreshed. Reopen its menu, review the updated details, and confirm deletion again if intended. The failed operation keeps the active conversation and draft; it does not automatically restore externally changed history.

Refreshing the same tab reconnects to server state, including pending approval; closing the tab does not cancel an active turn. Failed and cancelled turns remain visible with an explicit history warning. Messages are limited to 32768 UTF-8 bytes, and the display shows the latest 100 activity events per turn.

Successful conversation history is saved locally by default and can be resumed after restart; old activity reports, approvals, process usage and live tool journals are not restored. Start with `--continue` or `--resume <id-or-name>`, or choose a saved session in the sidebar. Responses appear when the existing non-streaming provider call completes; status updates are polled locally. There is no account system, remote hosting, or runtime provider switching. API credentials stay on the server. Treat the startup link as private: its random capability permits access to this local server's session list and active conversation. Reports distinguish valid provider token usage from missing usage and do not certify task correctness. See [Web UI architecture](ARCHITECTURE/WEBUI.md).

### Preview workspace HTML and SVG

Click **Preview** in the top bar, enter a workspace-relative `.html`, `.htm` or `.svg` path (for example `animations/bicycle.html`), and click **Open**. Current-turn execution reports also offer **Preview <path>** buttons for committed HTML/SVG writes inside the workspace. These buttons come from write records, not claims in model responses; files created by shell commands or restored sessions without reports can be opened using the path field.

The preview appears beside the chat on wide screens and over the chat on narrower screens. **Refresh** rereads the displayed file from disk and restarts its preview; unsaved editor changes are not included. Closing the panel removes the frame and stops its page. A failed read clears the old preview and shows an error. Previewing does not send a model request, change session history, grant an approval or write a file.

This first increment supports self-contained UTF-8 files up to 1 MiB: inline HTML styles and scripts, inline SVG, and standalone SVG animations. Embedded data images are supported. Relative scripts/styles/images, CDN libraries, remote resources, network requests, forms, popups, browser storage and access to the chat page are blocked. Use a single-file artifact for this preview; a multi-file application or development server is outside this increment. Hidden paths, dependency directories, links, absolute paths and paths outside the workspace remain unavailable even in Free to go mode. Preview remains available in read-only/Plan mode and with public web research disabled.

Rendering in the Preview panel is for your review and does not send observations to Fatcat. Automated runtime checks use the separate browser tool below. Model visual feedback remains a later increment.

### Let Fatcat run a local page

The `browser` tool is available in ordinary tasks, chat, TUI and Web UI. Ask, for example: "Open animations/bicycle.html with the browser tool, check runtime errors and the geometry of the pedal and foot, fix any observed problem, rerun the check and provide the report and screenshot paths." Fatcat chooses when to use it; there is no per-task capability flag.

Windows uses installed Microsoft Edge in headless mode, with a new browser and context for every call. Install project dependencies using `pnpm install --frozen-lockfile`; no browser is downloaded automatically. If Edge cannot start, the tool reports `BROWSER_UNAVAILABLE`. On other platforms, install the matching Chromium separately with `pnpm exec playwright install chromium` (the current verified platform is Windows).

Manual and Accept edits ask **Allow this browser check?** for each operation. Approval covers running the page and writing its generated JSON/PNG evidence. Plan, explicit read-only and shell-deny prohibit browser execution. Explicit shell allow and Free to go allow it without individual approval. The browser always stays inside the workspace, even in Free to go; public `web` research permission is separate.

Each call accepts a relative HTML/HTM/SVG path, up to 12 steps and 12 CSS selectors, an optional viewport and `screenshot` (default true). For example:

```json
{
  "path": "demo/index.html",
  "steps": [
    { "action": "fill", "selector": "#name", "value": "Ada" },
    { "action": "click", "selector": "#greet" },
    { "action": "wait", "milliseconds": 200 }
  ],
  "selectors": ["#greeting", "svg circle"],
  "viewport": { "width": 1000, "height": 700 }
}
```

Other actions are `select` (option value) and `press` (Enter, Tab, Escape, Space, arrow keys, Home or End). Each action selector must match one element. Replay all required interactions on the next check: cookies, storage and page state do not persist across calls. Relative local scripts, CSS, JSON, images and fonts can load. External sites, CDN resources, local servers, frames, workers, popups, downloads, network writes and arbitrary JavaScript evaluation are unavailable. Text assets must be UTF-8. Hidden paths, dependencies, links and paths outside the workspace remain blocked.

Reports include completed steps, page/console/request diagnostics, bounded DOM text, viewport rectangles, SVG local bounds and screen transforms, and hashes of loaded source bytes. Each check saves `fatcat-browser-evidence/<id>.json` and, when captured, `<id>.png`. Web UI execution reports expose **View browser report** and **View screenshot**. CLI/TUI users can open the saved files directly. Report buttons are not restored after restarting or switching sessions; evidence files remain on disk. They are not automatically deleted and may include page text and entered values, so treat them as local task data.

`completed` means the requested browser actions finished; page errors may still be present. Fatcat receives text observations and file paths, not screenshot pixels. A single DOM capture or PNG does not verify an entire animation cycle. After source changes, rerun the browser scenario; the current report flags older captures after a later recorded write attempt but cannot detect all edits from shell or other processes. Browser contexts, routing and CSP do not provide an OS sandbox or a hard CPU/memory limit.

Checks are bounded to a 30-second execution deadline, at most 40 checks per Tools process, 100 asset requests, 64 distinct loaded assets, 2 MiB per asset and 8 MiB total assets. A wait is at most 2 seconds, with 5 seconds total per call. PNGs capture the viewport (320–1600 by 240–1200), not a full-page or timed animation sequence. See [Browser architecture](ARCHITECTURE/BROWSER.md).

Run `pnpm run verify:browser` for the fixed temporary-page scenario: real browser interactions, an injected-model repair loop, geometry, evidence, network boundaries and cancellation. It uses no model API or credentials. Ordinary `pnpm test` uses injected browser runners and does not launch or install a browser.

## Run a task

```powershell
pnpm start "Explain what an agent loop does in one sentence."
pnpm start --prompt "Use the sum tool to add 17 and 25, then report the total."
```

The CLI writes the final answer to stdout and JSON event logs to stderr. Logs include model iteration numbers, tool names and call IDs, tool success/failure, and termination reasons. Write records also include canonical paths (workspace-relative normally, absolute in Free to go), content hashes, byte counts, outcome status, and any residual temporary-file path. They omit prompts, tool arguments, raw provider errors, and API keys. For use in a pipeline without package-manager output:

```powershell
pnpm run build
node --env-file-if-exists=.env dist/src/cli.js --prompt "Use the sum tool to add 17 and 25."
```

Press Ctrl+C to cancel. A single-task invocation starts a new saved session unless `--continue` or `--resume` selects existing history. No arguments displays help; use `--chat` for a continuous conversation or `--tui` for the interactive terminal interface.

The `sum` tool accepts 2 to 32 finite numbers and returns a finite JavaScript-number sum. Invalid arguments, unknown tools, and arithmetic overflow return structured errors to the model so it can correct its next call. `read`, `write`, and `shell` are available as peer workspace tools by default; discovered Skills also have a separate, read-only `skill://` scope. Each write and command asks for yes/no in an interactive terminal by default. The `web` tool provides public search and page reading with separate network permission.

Each model request counts as one iteration; each new user turn receives a fresh iteration budget. If the last allowed request still asks for tools, the harness stops without executing those calls. Timeouts and transport failures stop the run; automatic SDK retries are disabled.

| Exit code | Meaning |
| --- | --- |
| 0 | Final answer, clean chat exit, help, or valid local configuration |
| 1 | Configuration, model, protocol, or iteration-limit failure; chat also returns 1 if any turn failed |
| 2 | Invalid CLI usage or empty prompt |
| 130 | User cancellation |

## Public web research and weather

Ordinary tasks, `--chat`, and `--tui` expose `web` by default. Use normal language; no search API key or capability flag is needed. The configured model key is still needed to run the agent.

```powershell
pnpm start "查询北京今天和未来三天的天气，注明时间、单位和来源。"
pnpm start "查找 Node.js 官方资料，解释当前 LTS 发布规则并附来源。"
pnpm start "查询最近一周的人工智能新闻，核对日期并附原文链接。"
pnpm start --chat
pnpm start --tui
pnpm start --chat --web-permission deny
```

Search defaults to Bing RSS, with DuckDuckGo HTML available as an alternative. Both are public, best-effort services; they can time out, change format, or challenge requests. Bing RSS is intended for personal, non-commercial use. `recency` is only a service hint; the model must verify dates in the source. Page reading supports static HTML, text, JSON and XML, with source links, retrieval time and bounded pagination. It does not execute JavaScript, log in, or read PDFs. Direct connections are used; environment proxy settings are not consumed by this tool.

Built-in `$web-research` covers source selection, linked-page reading, news dates and citations. `$weather-lookup` uses public geocoding and forecast data, checks place/timezone/units and distinguishes current estimates from forecasts. It uses Open-Meteo's free non-commercial endpoints; commercial use is subject to the [service terms](https://open-meteo.com/en/terms). Both Skills are loaded on demand through `read` and appear in `/skills` in chat or TUI.

`--web-permission allow` is the CLI default, including with `--permission read-only`. `deny` rejects web calls before DNS/HTTP, and children inherit the same policy. This setting is not a firewall for separately authorized shell commands. Search terms go to the selected search service; fetched URLs go to their hosts, and retrieved content enters the selected model's context. Do not include private project content or credentials in queries or URLs. Remote page instructions are untrusted data.

Each call has a 15-second deadline, at most three redirects and a 1 MiB response limit before and after decompression. Only public HTTP(S) addresses on standard ports are allowed, with DNS pinning and redirect revalidation. Fetch text pages are limited to 12000 UTF-8 bytes; continue using `nextOffset`. Every page refetches, and the full model request budget still applies. See [Web architecture](ARCHITECTURE/WEB.md) for errors and limits.

```powershell
pnpm run verify:web
```

This explicit network check makes up to five fixed tool calls for research/news search, a public Node.js page, Berlin geocoding and a three-day forecast. It needs no model key, does not load `.env`, and makes zero model requests. `pnpm test` remains offline. Passing this command confirms those sources were reachable at that time, not that every model-driven research task is correct.

## Review execution evidence

Each started single-task or `--chat` CLI task emits one `execution_report` JSON event to stderr when the managed turn answers or stops. The root outcome waits for session persistence: a failed checkpoint or final save reports stopped, even if the model produced an answer; a failed pre-work session write reports zero model requests. Chat reports include the user-turn number. Stdout remains the model answer. TUI observes the same report for display instead of interleaving JSON with the screen. Help, configuration checks, local chat commands, and failures before starting a managed turn do not produce a report. Low-level `runAgent`/Session callers can opt into the same observer with `createTurnReporter`; their return values and original event timing are unchanged.

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

A request that is still oversized stops with MODEL_CONTEXT_LIMIT before transport. In chat, the previous successful history remains. Use a smaller task or `/new` to start fresh history while retaining the old session. Already committed edits and commands remain; their records survive session changes and still count toward the next request. If those records alone exceed the limit, inspect them before starting a new process or explicitly raising the configured limit. A new process loses live journals and process telemetry; saved conversation history remains available through resume.

The context_reduction event records beforeBytes, afterBytes and omittedReadResults only when a projection changes the body; it contains no paths or contents. The model_input event contains the final bytes, limitBytes and accepted, plus the iteration; accepted means it passed the local size check, not that the server accepted it. The model_usage event reports valid provider token counts or null. Missing, malformed or inconsistent counters stay unknown and do not invalidate an otherwise valid answer. Received counts are retained even if the answer is truncated or fails protocol validation; transport errors or early cancellation may have no usage report.

The execution report aggregates parent and child observations separately. It never estimates missing usage, cache prices or currency cost. Known zero counts differ from unknown totals; an aggregate exceeding safe integer precision also becomes null. No usage data is inserted into the model conversation. Request size is checked after constructing the body, so this does not bound process memory. Large user instructions, copied assistant text, execution records or current-turn reads may still exceed the budget. Fresh single-task and child histories have no eligible older turns. The provider may also reject a request within the local byte budget. See [Context architecture](ARCHITECTURE/CONTEXT.md) for the exact boundary.

Provider cache counters are validated separately from the base token totals. Supported response fields are `prompt_tokens_details.cached_tokens` and DeepSeek's `prompt_cache_hit_tokens`; a supplied DeepSeek miss counter must agree with the hit count and prompt total. Missing, malformed, conflicting, or oversized cache counters remain unknown without discarding valid base usage. The TUI cache percentage uses total cached input tokens divided by total prompt tokens for the same cache-reporting requests, with coverage shown. It is not an average of request percentages or a measure of server KV memory. No field means unknown, not a zero cache hit rate.

## Use local Skills

Fatcat discovers local and built-in Skills automatically at startup. A Skill is a directory containing a UTF-8 `SKILL.md` with YAML metadata and task instructions. Only metadata, including name, description, source scope and a read URI, is initially shown to the model; the full document is loaded when needed through the existing `read` tool.

Six built-in Skills are available without installing anything:

| Skill | Subsystem | Use |
| --- | --- | --- |
| workspace-editing | tools | Inspect current code, make focused edits, and check the result within existing permissions. |
| focused-delegation | subagent | Give bounded independent investigations or reviews to children with self-contained context. |
| context-recovery | context | Reread current evidence after omitted reads, external changes, failure, or reset. |
| verification-handoff | execution-report | Assess actual check results and hand back the work with accurate limitations. |
| web-research | web | Search public sources, read pages, verify news dates and cite supporting URLs. |
| weather-lookup | web | Resolve places and read weather data with explicit timezone, dates and units. |

These are instructions for Fatcat to work on your coding and public research tasks. They follow the target project's conventions and do not impose Fatcat's own source layout or package manager. The model chooses whether to read them; bundling them does not automatically load their full text or grant permissions.

The search order is:

1. `<workspace>/.fatcat/skills/<name>/SKILL.md`, using the launch directory unless `--workspace` overrides it.
2. `<workspace>/.agents/skills/<name>/SKILL.md`.
3. `<user-home>/.fatcat/skills/<name>/SKILL.md`.
4. `<user-home>/.agents/skills/<name>/SKILL.md`.
5. Built-in assets beside the running module, at `dist/src/skill/<subsystem>/<name>/SKILL.md` in this repository's build.

The first valid occurrence of a name wins, so workspace or user Skills can override a built-in with the same name. Local roots contain one level of Skill directories; built-ins add a subsystem grouping level. Fatcat does not search ancestor repositories, download Skills, or install them. Tasks, chat and TUI discover workspace Skills from the launch directory by default, as well as user and built-in Skills. Built-in paths are relative to the running module rather than the launch directory, so starting the compiled CLI from another directory retains them. Ordinary workspace read still rejects hidden paths.

To inspect discovered metadata locally, start chat or TUI and enter `/skills`:

```powershell
pnpm start --chat
pnpm start --chat --workspace examples/workspace
```

The local `/skills` command lists the catalog discovered at startup; it makes no model request, loads no instruction body, and leaves conversation history unchanged. Starting chat/TUI still requires configured provider credentials. Rows show the name, scope, description, and read URI. Built-in Skills appear with `[builtin]`. All sources share the same URI format, for example `skill://workspace-editing/SKILL.md`; the subsystem is not part of the URI. You can use a built-in immediately:

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

Skill metadata and loaded contents can be sent to your selected model provider. Skills guide the task but do not grant write or shell access. Bundled scripts are not automatically executed; any proposed shell command uses the same separate authorization. Successful turns preserve loaded instructions in the saved Session and protect them from old-read omission. Failure keeps newly loaded text only in the latest partial attempt. `/reset` starts a new session without loaded instruction history and retains the old conversation, startup catalog and execution records. Restart after adding Skills or changing their metadata; there is no catalog hot reload.

Built-in source files live under `src/skill/<subsystem>/<name>/SKILL.md`; run `pnpm run build` after changing them. Keep `dist/src/skill` with the compiled application when copying build outputs. A missing built-in installation produces a diagnostic; rebuilding restores the assets. Build refresh affects that generated directory only, not your workspace or user Skills. Normal CLI use needs no capability flag. The four built-in workflows have offline loading and integration coverage; their effect on real model task performance has not been validated online. See [Skills architecture](ARCHITECTURE/SKILLS.md) for exact boundaries.

## Read a workspace

The launch directory is the default workspace. Use `--workspace` to select another directory:

```powershell
pnpm start --workspace examples/workspace --prompt "Read project-notes.txt and report its verification phrase."
pnpm start --chat --workspace examples/workspace
```

`--workspace` works with a single prompt, `--chat`, `--tui` or `--webui`; it cannot be used alone or with help/configuration checks. Without it, Fatcat uses the directory where you invoked `pnpm start`, even though pnpm runs package scripts from the package root. An explicit absolute workspace overrides that directory; a relative workspace resolves from it. For example, from `D:\fatcat\examples`, `pnpm start --chat` uses `D:\fatcat\examples`, and `pnpm start --chat --workspace workspace` uses `D:\fatcat\examples\workspace`.

The parent has `sum`, `read`, `write`, `shell`, and `delegate_task`; children share the same workspace tools and permissions without recursive delegation. A path that cannot be resolved to an existing directory fails configuration before any model request. New sessions and `/reset` inherit the current workspace. Use `/workspace <path>` to change it; resuming a session selects its saved workspace. Directly running the compiled `dist/src/cli.js` uses that Node process's current directory and ignores inherited `INIT_CWD`; only the package start launcher restores pnpm's invocation directory.

The canonical workspace root is included in parent and child model request guidance, so the model can answer which directory it is using without executing a command or inferring the path from a listing. Tool paths still use workspace-relative paths. The TUI displays the same canonical root. Help and configuration checks do not create a workspace or accept workspace/permission options.

The workspace exposes general-purpose `read`, `write`, and `shell` tools, with each write and command requiring approval by default. The `read` tool accepts files or directories. It replaces `list_directory` and `read_file`; the old names are no longer accepted.

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

`--permission` and `--shell-permission` work with a task, chat, or TUI using either the default or an explicit workspace; neither requires `--workspace`. For example, `pnpm start --chat --permission read-only` inspects the launch directory while refusing writes and commands. Non-interactive input cannot approve writes: a piped `yes` is not authorization, and writes fail promptly unless explicitly preauthorized. Programmatic `createTools()` remains sum-only with no workspace access; callers selecting a workspace still default to read-only with shell denied, and ask mode requires an approval callback. Single-task invocations support the same terminal confirmation.

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

## Saved sessions

Tasks, chat, TUI and Web UI save sessions by default. Starting without a selection creates a new session; earlier conversations remain available. Sessions store their canonical workspace but are listed globally across all workspace directories in the same session store. Resume from any launch directory to select a session and its saved workspace.

```powershell
pnpm start --chat --name auth-refactor
pnpm start --continue
pnpm start --resume auth-refactor
pnpm start --tui --continue
pnpm start --webui --resume auth-refactor
pnpm start --resume auth-refactor --prompt "Review the previous changes."
pnpm start --continue --fork-session --name alternative-approach
pnpm start --resume
pnpm start --chat --workspace D:\your-project
pnpm start --chat --no-session-persistence
```

| Option | Behavior |
| --- | --- |
| `--continue`, `-c` | Resume the most recently updated session across all workspaces. No prior session is an error. |
| `--resume <id-or-name>`, `-r <id-or-name>` | Resume an exact session ID, explicit name or local title. Ambiguous matches require an ID. |
| `--resume`, `-r` | List sessions and ask for an ID or name in an interactive terminal. With redirected input or stderr, print the list and exit without model credentials. |
| `--name <name>`, `-n <name>` | Name a new session, rename a resumed one, or name the new branch with `--fork-session`. |
| `--fork-session` | Combine with continue or resume to copy history into a new session and preserve the source. |
| `--no-session-persistence` | Keep new sessions only in this process. Startup resume, continue and fork selection cannot be combined with it. |

Continue, resume or name without another mode opens ordinary chat. Selection also works with an explicit prompt, `--chat`, `--tui` or `--webui`; continue and resume are mutually exclusive. Use `/sessions` inside chat/TUI for local listing. The former skill/session listing startup flags have been removed; bare `--resume` retains its credential-free picker or pipe listing path. Names are trimmed, non-empty, limited to 120 characters and cannot contain control characters; duplicate explicit names in a storage bucket are rejected. Names in different buckets can match; use the session ID to resolve an ambiguous global selection. Unnamed sessions use a title taken locally from the first prompt, without a model title request. Titles can repeat; the UUID always identifies one session.

The default location is `<user-home>/.fatcat/sessions/<workspace-hash>/<session-id>.json`. Set a different storage root in the launching PowerShell session if needed:

```powershell
$env:FATCAT_SESSION_DIR = 'D:\fatcat-session-data'
pnpm start --chat
```

The root retains separate SHA-256 storage buckets for compatibility. Editing a workspace keeps the original bucket (recorded as storageWorkspace) and changes only the execution workspace. No session or project files are moved. Files are versioned atomic JSON snapshots, limited to 64 MiB each. History includes prompts, answers, tool calls/results, read file and web content, and loaded Skill instructions. Data is local plaintext and has no automatic retention cleanup. The harness does not serialize provider credentials, permission policies or approval answers; user or tool content can still contain sensitive data. `--no-session-persistence` disables disk saving for the current run and allows in-process new/list/resume/rename/fork.

Resuming restores full completed model history using the session's saved workspace and refreshed Skills catalog, with the current launch's provider and permissions. It does not restore old authorization grants, file contents, pending approvals, tool processes, live journals, activity reports or process token totals. The latest failed, cancelled or abandoned turn retains partial messages separately and displays an interrupted warning; the next model request receives a bounded recovery notice to inspect current state before repeating operations. Nothing runs automatically on resume, and the warning clears after the next successful turn. This is not a permanent failure audit log or a file rollback feature.

Session updates check revisions before work, preventing a stale process from overwriting newer history. A running session cannot be resumed by another process; busy, changed or damaged sessions produce explicit errors. Use `/sessions` and resume again after the other process finishes. A fork has independent history and an origin ID; it does not create a Git branch or copy workspace files. See [Session architecture](ARCHITECTURE/SESSION.md) for storage and failure boundaries. The functionality draws on [Claude Code's public session definitions](https://code.claude.com/docs/en/sessions); Fatcat does not import its transcript format or implement all of its recovery features.

A crashed transaction owner can be recovered after its PID is confirmed gone. An incomplete lock or a crashed lock-recovery operation is conservatively blocked; the error explains which lock may need manual removal after confirming no session store operation is running. A disk failure after model work is reported as stopped rather than as saved success, and it cannot undo completed tool effects.

## Continuous chat

```powershell
pnpm start --chat
```

Enter one task per line. For example, ask `Use the sum tool to add 17 and 25.`, then `Add 8 to the previous total using the sum tool.` The second turn includes the previous conversation and tool result.

| Command | Behavior |
| --- | --- |
| /help | Show local chat commands |
| /skills | List discovered Skill metadata locally, without loading instructions or calling the model |
| /new [name] | Create a new session, retaining the old one |
| /clear, /reset | Start a new unnamed session |
| /sessions, /resume | List all workspace sessions |
| /resume <id-or-name> | Switch to a saved session |
| /rename <name> | Rename the active session |
| /fork [name] | Copy completed history into a new session |
| /exit | End the chat |

Blank lines are ignored. Lines beginning with `/` are reserved for local commands; unknown commands print a hint without calling the model. Commands must occupy their own line. The `--chat` flag cannot be combined with a prompt, help, or configuration check.

Answers go to stdout. Terminal prompts, approval previews, command feedback, and event logs go to stderr. `You>` is bright green in an interactive terminal; `NO_COLOR`, TERM=dumb, or redirected input/output disables that color. Input and stderr must both be terminals for approval. Earlier queued chat lines cannot approve a later request. Chat events include a user-turn number; reset does not rewind that number. Standard input can also supply lines through a pipe. At end-of-input the harness finishes queued lines and exits; `/exit` skips later queued lines. Press Ctrl+C to cancel the active turn and exit with code 130. On Windows, `/exit` is the simplest way to finish from the terminal.

Successful turns save the full user, assistant, and tool messages locally. Failed or cancelled turns do not replace completed history; the latest partial attempt is recorded separately for recovery. A model failure displays an error and lets you continue; the eventual chat exit code is 1 if any turn failed. File changes and process-local write records remain, and API requests already made may still consume credits.

Saved history remains after exit and is not automatically trimmed or summarized. Only outgoing requests may omit eligible older read contents as described above. Long conversations can still hit the local request-body budget or provider context limits; use `/new` or `/reset` to start fresh history while retaining the old session and process execution records. With `--no-session-persistence`, conversations are lost when the process exits.

## Interactive TUI

Run in an interactive Windows terminal:

```powershell
pnpm start --tui
pnpm start --tui --workspace D:\your-project
pnpm start --tui --workspace D:\your-project --permission read-only
```

Replace `D:\your-project` with the project you want Fatcat to access, or run `pnpm start --tui` to use the launch directory. The TUI uses the same provider settings, Skills, tools, delegation limits, and workspace permissions as the CLI and displays the canonical workspace root used by the tools. `--permission workspace-write` preauthorizes file edits only; commands still ask unless `--shell-permission allow` is supplied.

The cyan and purple interface combines Markdown conversation output, a status area, a metrics panel, and a Unicode input editor. At 110 columns or wider, conversation and metrics appear side by side; narrower terminals use a stacked layout. `/status` shows full values when the screen cannot fit them. `NO_COLOR` disables theme colors. `--tui` is an exclusive interactive mode; do not combine it with `--chat`, a prompt, `--help` or `--checkConfig`. Redirected input/output and `TERM=dumb` are rejected with usage exit code 2; use the existing CLI modes for pipes.

Enter sends the prompt; Alt+Enter inserts a newline. Up/Down recalls prompts, and PageUp/PageDown scrolls. You can draft the next prompt during a running turn, but it is not submitted or queued automatically. Pasted text also requires explicit submission.

| Command | Behavior |
| --- | --- |
| /help | Show local commands and editor shortcuts. |
| /status | Show effective configuration and current telemetry. |
| /skills | List discovered Skill metadata without a model request or history change. |
| /new [name], /clear, /reset | Start a new session; retain the old history, consumed usage and execution records. |
| /sessions, /resume | List all workspace sessions. |
| /resume <id-or-name> | Switch to an existing session. |
| /rename <name> | Rename the active session. |
| /fork [name] | Branch the completed conversation into a new session. |
| /exit | Restore the terminal and exit. |

Blank input is ignored, and unknown slash commands stay local. Write and shell approvals open a separate yes/no input with the current operation's preview. Only a fresh answer to that approval can authorize it; ordinary task text is not approval. The shell preview retains the warning that commands run with your user permissions, including file and network access beyond the selected directory.

Escape or Ctrl+C cancels a running TUI turn, propagates to the parent, children, and tools, then returns to the input editor so you can continue. Ctrl+C at idle exits; Ctrl+D cancels and exits. Failed or cancelled turns do not enter the saved Session history; earlier successful history, completed edits, command effects, and already received usage remain. `/reset` also keeps those effects and process usage. It does not change provider, workspace, permissions, or Skill discovery. The TUI exits with 1 if any turn failed or was cancelled, otherwise 0. The original `--chat` mode retains its behavior: Ctrl+C cancels and exits with 130.

| Display | What it measures |
| --- | --- |
| Provider / model / region | The actual startup configuration, fixed for the Session. |
| Workspace / write / shell | The explicitly authorized directory and independent permission policies. |
| Skills / iteration / timeout | Discovered catalog size and configured per-turn / per-request limits. |
| Turn / process usage | Valid provider input, output, and total tokens, including children, with reporting coverage; process totals survive reset. |
| Parent / child requests | Loop request attempts, including local budget rejections; not confirmed billing or HTTP counts. |
| Latest prompt tokens | The most recent parent response's reported input size; cleared at the next parent request or reset, then unavailable until reported. |
| Request bytes | The latest complete parent JSON request against the local byte budget, after any older-read projection. |
| Model context window | Unknown: the configuration does not provide a trusted token capacity for arbitrary model names. |
| KV / prompt cache | Valid provider cached input counters; the weighted hit rate covers only requests that reported them. |
| Context reduction | Actual omitted read-result counts and JSON bytes saved, not token savings. |
| Execution state | Current model/tool activity and observed report outcomes; an answer does not certify task acceptance. |

The model APIs remain non-streaming: activity and elapsed time can update while waiting, but complete answers and usage arrive with the response. The local request-byte gauge is not a token-context percentage. Missing usage and cache data remain unknown; partial coverage is shown explicitly. The interface does not estimate fees, service cache capacity, or unreported tokens. Session history persists by default; old display activity and statistics are process-local and lost on exit. Restored user/assistant messages do not fabricate old telemetry. Implementation details and terminal verification limits are recorded in [TUI architecture](ARCHITECTURE/TUI.md) and [PROGRESS.md](PROGRESS.md).

## Delegate a task

```powershell
pnpm start --chat --workspace examples/workspace
```

`delegate_task` is available in ordinary single-task and chat commands. The model chooses when to delegate; no capability flag is required. The old `--subagent` option has been removed and now returns usage exit code 2; remove it from existing scripts.

Parent-only guidance favors direct work for simple questions, arithmetic, and single file operations, and focused delegation for independent investigations or reviews. Children receive concrete context supplied by the parent. Short reviews can still be handled directly; this is model judgment, not a fixed classifier or a guarantee of optimal task splitting. No child requests are made unless the model invokes the tool. Read-only mode still permits delegation while denying writes and commands.

The parent supplies a self-contained `task` string of 1 to 4000 characters. A child starts with fresh history and the same provider configuration and basic tools, including the selected workspace, its permission, and the Skill catalog. A child must load relevant Skill instructions for its own task; it does not inherit the parent's loaded documents. Parent and child share the same write and command journals and approval callbacks; a child cannot elevate access, and its committed writes remain visible even if its turn fails. It cannot see the parent conversation or delegate further. Its final answer returns as tool data; its internal messages stay out of the parent history. Answers longer than 12000 characters return an error rather than a successful partial answer.

Each user turn may start at most two child tasks, including failed attempts. Each child gets at most three model requests, further capped by HARNESS_MAX_ITERATIONS. The parent's own request limit is unchanged: with the default limit of 32, the total upper bound is 38 requests per user turn. Tasks run sequentially. A new user turn gets a fresh allowance.

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
- [TUI architecture and telemetry](ARCHITECTURE/TUI.md)
- [Development guidelines](../AGENTS.md)

All repository text outside docs/ must be English. Chinese is allowed only under docs/. Runtime user input and model output may use any language.

## Changing a session workspace

Use `/workspace` to show the current directory, or `/workspace D:\my-project` in chat/TUI to change it. Relative paths resolve from the current workspace; paths with spaces may be wrapped in double quotes. Use `/new` before changing the directory to start a separate conversation; changing an existing session retains its ID and history.

In Web UI, click the workspace path to open the native Windows folder picker. Browse with Explorer's navigation or enter a directory in its address bar, then choose **Select folder**. Cancel keeps the current directory and conversation unchanged. The session menu also has **Change workspace**, including for inactive sessions or sessions whose old directory no longer exists. New chat starts in the current workspace; changing its directory keeps it an unsaved draft until the first message. Session changes and new turns wait until the picker closes. The picker runs on the Windows machine hosting Fatcat and closes after five minutes or when the requesting page disconnects; it requires an interactive Windows desktop.

Directory changes are unavailable while a turn or approval is running. Reads, writes, shell cwd, browser checks, preview and Skills follow the selected workspace under current launch permissions. Returning to a previously visited workspace retains its process tool journals. Automation discovery remains limited to the active workspace and rebuilds its file baselines on workspace changes; listing all sessions does not start jobs in other projects.

Run `pnpm run verify:sessions` for the explicit real Edge workflow check with temporary workspaces and injected model decisions and folder selections. No model credentials or model requests are used. This checks session bindings; manually selecting and cancelling the native Windows dialog is a separate desktop check.
