# CLI, chat, TUI and Web UI

[Documentation](../README.md) · [Command reference](../REFERENCE/COMMANDS.md)

Configure a provider first using the [quick start](../QUICK_START.md). All examples run from the repository root. Ordinary task, chat and TUI launches create saved sessions by default; a new unnamed Web UI chat starts as a draft. See [sessions and projects](SESSIONS.md) for persistence and continuation.

## Single task and terminal chat

```powershell
pnpm start --prompt "Inspect this workspace and summarize its entry points."
pnpm start --chat --workspace examples/workspace
```

Single-task output goes to stdout; diagnostics, approvals and execution events use stderr. For scripts that need to avoid pnpm/build output, build once and invoke `node --env-file-if-exists=.env dist/src/cli.js --prompt "Your task"` from the repository root. Direct Node invocation uses its own working directory and does not restore `INIT_CWD`.

Chat accepts one prompt per line. Empty lines are ignored. Local slash commands must occupy their own line; unknown commands report a local error instead of becoming model prompts. `/help` lists available commands and `/exit` ends the conversation. Approval replies apply only to the pending operation. Resetting or switching a session does not undo completed writes or commands.

Use `/context` to inspect history size and `/compact [focus]` to summarize older turns. Automatic compaction can also run when a request exceeds the local byte budget; see [context management](SESSIONS.md#context-management).

## Interactive TUI

```powershell
pnpm start --tui --workspace examples/workspace
```

TUI shares chat's session commands and tools, with an editor, activity display, approval prompts and configuration/usage panels. It requires a terminal; redirected input/output is rejected. Enter sends, Alt+Enter inserts a newline, and Page Up/Page Down scroll. `/status` shows full configuration and metric definitions. Escape or Ctrl+C cancels active work while retaining the conversation. Ctrl+C while idle exits; Ctrl+D cancels and exits.

Provider usage is reported only when supplied by the provider. Missing token or cache fields are unknown, not zero. Process totals can include delegated and compaction requests; they are not the size of the current context. Terminal rendering, shortcuts and implementation limits are described in [TUI architecture](../ARCHITECTURE/TUI.md).

## Local Web UI

```powershell
pnpm start --webui
pnpm start --webui --workspace examples/workspace --port 3211
```

The server binds to `127.0.0.1:3210` by default and opens the default browser. If opening fails, copy the complete terminal link, including `#token=...`. Treat it as private: it grants access to this server's sessions and active conversation. Set `FATCAT_WEBUI_OPEN_BROWSER=0` to disable automatic opening. Ctrl+C in the server terminal stops the server and cancels active work.

Enter sends a message; Shift+Enter inserts a line break. IME composition does not submit. **Stop** cancels the active turn and leaves the conversation usable. Messages are limited to 32768 UTF-8 bytes. Model responses appear when the non-streaming request completes; activity updates remain visible while it runs.

The browser displays proposed writes and commands with **Allow once** and **Deny**. The permission selector can change modes while idle; explicit launch restrictions remain ceilings. See [permissions](../REFERENCE/COMMANDS.md#permission-modes).

All tabs connected to one server share an active session and permission mode. Refreshing reconnects to server state, including pending approval. Closing a tab does not cancel work. **New chat** retains the previous session; draft persistence follows the [session rules](SESSIONS.md#web-ui-drafts).

After 100 ordinary turns in the displayed conversation, the Web UI asks you to start a new chat before sending another ordinary message. Restored turns count too; compaction retains the history and does not reset this UI limit. Context/Memory commands remain available, and background tasks have a separate path.

Use the sidebar's session menu (ellipsis, right-click or Shift+F10) to inspect details, rename, change workspace, move to a project, fork or delete. Deletion asks for confirmation and removes saved conversation data. If another process changes the target, refresh its details and review again. Management is disabled during active work or approval. See [project and session operations](SESSIONS.md) and [materials](MATERIALS.md) for sharing and deletion effects.

The context indicator uses the latest parent request's reported input tokens and a known model capacity. It excludes unsent drafts and the latest reply. Unknown model capacities do not produce a guessed percentage. Restored sessions show unavailable usage until a new request reports it. The separate request-byte budget still applies.

There is no account system, remote hosting or runtime provider switching. Credentials remain on the server. Saved history restores conversation text, not old approvals, live execution journals or process usage. See [Web UI architecture](../ARCHITECTURE/WEBUI.md) for interaction and accessibility details.

## Preview an HTML or SVG file

In Web UI, click **Preview**, enter a workspace-relative `.html`, `.htm` or `.svg` path, then **Open**. Current-turn reports also offer preview buttons for committed HTML/SVG writes. For shell-created files or restored history, enter the path yourself.

**Refresh** rereads the saved file and restarts the preview. Closing it stops its frame. A failed read clears the old preview. This is a single-file, isolated preview for inline content; it does not load a site's relative assets or run a development server. It works in read-only/Plan mode without model requests, permissions changes or history mutation.

For pages with local assets, scripted interaction, diagnostics or screenshots, ask Fatcat to use the controlled browser described in [local page checks](CODING.md#local-page-checks). That tool executes code and follows command permissions.
