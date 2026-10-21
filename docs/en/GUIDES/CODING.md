# Coding tasks and execution evidence

English | [简体中文](../../zh-CN/GUIDES/CODING.md)

[Documentation](../README.md) · [Permissions](../REFERENCE/COMMANDS.md#permission-modes)

Start a task, chat, TUI or Web UI in the target workspace. A useful request states the intended change and a concrete way to check it:

```powershell
pnpm start --chat --workspace examples/workspace
# Then ask: Find the greeting implementation, change its wording, and run its focused test.
```

Fatcat can inspect text, search, create or edit files, run commands, research public information and delegate focused work. Review its execution evidence and resulting diff before treating the task as complete.

## Read and locate code

Ask for an entry-point overview, a named file or a literal symbol search. Reads are paged; large results may need follow-up reads. Text reads accept UTF-8 files up to 1 MiB, with bounded line ranges and response sizes. Search is literal, case-sensitive and single-line, with bounded file, directory and match counts. A partial result or skipped file does not prove absence.

Ordinary modes confine file tools to the workspace and exclude hidden paths, dependency directories and links. Free to go broadens local access while retaining text and resource limits. Read content may be sent to the configured model. Use [attachments](MATERIALS.md) for supported document formats instead of asking text tools to parse binary files.

## Make a controlled edit

Default mode asks before each write. The prompt shows the path and proposed content/change. The text tool creates a new file without overwriting an existing one, or replaces an exact fragment that must occur once. Parent directories must exist; edits retain strict text/size checks. It does not offer general directory creation or deletion.

If the file changed while approval was pending, Fatcat rejects a stale edit instead of silently replacing new content. Ask it to reread and revise the operation. A later model failure does not roll back writes already committed. Inspect the file and diff before retrying an interrupted task.

To allow controlled writes automatically while still reviewing commands:

```powershell
pnpm start --chat --permission-mode acceptEdits
```

See [tool contracts](../ARCHITECTURE/TOOLS.md) for exact read, search and write limits; [permissions](../ARCHITECTURE/PERMISSIONS.md) owns access rules.

## Run a check

Ask for a focused test or build command. Shell uses a fresh foreground Windows PowerShell process without a profile or interactive stdin. The approval shows the command, working directory and timeout. File-write approval does not authorize commands.

The default command timeout is 30 seconds, with a maximum of 120 seconds. Combined output is bounded at 16 KiB; hitting the limit terminates the command. A successful tool call alone does not mean a check passed: inspect exit code, timeout, cancellation and truncation. A command with multiple native programs must preserve their failure status.

Commands run with the Windows user's access, not in an OS sandbox. Process cleanup is best effort; detached processes can survive. An unconfirmed stop blocks further shell launches through that Tools instance; inspecting the process does not automatically clear the block. Each Tools instance retains bounded command/write journals shared by parent and delegated work. Ordinary interfaces cache that instance per workspace, so starting another chat in the same workspace does not reset it. Counts and lifecycle are defined in [Tools](../ARCHITECTURE/TOOLS.md#journals-and-verification).

## Delegate focused work

Delegation is available by default; no capability flag is required. Ask for independent, bounded subtasks when useful. The model decides whether to delegate.

Children have isolated conversation histories and inherit tool/permission boundaries. They share operation journals and cannot recursively delegate. Current defaults allow two children with at most three model requests each, capped by the configured iteration limit. They run sequentially. A child's final answer is evidence to review, not proof that its task succeeded. See [delegation architecture](../ARCHITECTURE/SUBAGENT.md).

## Research public information

Ask for a current source, a URL or weather with a location and date. Search and page retrieval are available by default; `--web-permission deny` disables this tool independently of file permissions. Read-only/Plan can still research when web access is allowed.

Search is best effort and recency is a hint. Page retrieval reads bounded static HTML, text, JSON or XML; it does not execute JavaScript, authenticate into sites or parse remote PDFs. Long pages may need another page read, which fetches the source again. Check source dates and citations before relying on an answer.

Ordinary modes permit public HTTP(S); Free to go also permits private addresses and custom ports. Redirect, DNS, size and timeout checks remain enforced. Web denial does not block network access from independently authorized shell commands. See [web architecture](../ARCHITECTURE/WEB.md) for sources and network limits.

## Local page checks

Ask Fatcat to inspect a workspace HTML/SVG page in the controlled browser, perform bounded interactions and report console errors, geometry or screenshots. This requires installed Microsoft Edge on Windows; Fatcat does not automatically download a browser.

Each call opens an isolated browser context. Workspace-local assets are supported; arbitrary script evaluation, external browsing and access outside the workspace are unavailable, including in Free to go. Manual/Accept edits ask for command approval; Plan, read-only and shell-deny reject execution. Screenshots and JSON records are user-facing evidence, not image input automatically sent to the model.

Evidence is saved under `fatcat-browser-evidence/<id>.json` and, when captured, `<id>.png`. Web UI offers report/screenshot buttons; CLI/TUI users can open the files directly. Files remain on disk and can contain page text or entered values. `completed` means the requested actions finished, not that the page has no errors. Rerun after source changes; one viewport capture does not verify a whole animation.

For a quick single-file view without executing a tool, use [Web UI preview](INTERFACES.md#preview-an-html-or-svg-file). Exact execution capabilities and evidence formats belong in [browser architecture](../ARCHITECTURE/BROWSER.md).

## Review results and recover from failures

Check the final answer against the diff and execution report:

- Reads and searches report their scope and omissions. They do not prove the whole repository was inspected.
- Writes distinguish committed, failed and uncertain operations. A failed turn can still have changed files.
- Shell evidence includes exit status, cancellation, timeout and bounded output. An exit code of zero does not prove a broader product goal.
- Provider usage distinguishes reported values from missing data. Context size, request bytes and cumulative tokens measure different things.
- `taskVerification: not_assessed` means task correctness has not been assessed; a final answer is not an acceptance certificate.

After cancellation, storage conflict or an interrupted session, inspect current files and processes before continuing. Resume restores conversation history without replaying tool operations or old approvals. Older saved sessions do not restore process-local execution reports. See [execution reports](../ARCHITECTURE/EXECUTION_REPORT.md) and [session recovery](SESSIONS.md#storage-and-recovery).
