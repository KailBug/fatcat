# CLI, chat, TUI and Web UI

English | [简体中文](../../zh-CN/GUIDES/INTERFACES.md)

[Documentation](../README.md) · [Command reference](../REFERENCE/COMMANDS.md)

Configure a provider first using the [quick start](../QUICK_START.md). All examples run from the repository root. Ordinary task, chat and TUI launches create saved sessions by default; a new unnamed Web UI chat starts as a draft. See [sessions and projects](SESSIONS.md) for persistence and continuation.

## Single task and terminal chat

```powershell
pnpm start --prompt "Inspect this workspace and summarize its entry points."
pnpm start --chat --workspace examples/workspace
```

Single-task output goes to stdout; diagnostics, approvals and execution events use stderr. For scripts that need to avoid pnpm/build output, build once and invoke `node --env-file-if-exists=.env packages/cli/dist/cli.js --prompt "Your task"` from the repository root. Direct Node invocation uses its own working directory and does not restore `INIT_CWD`.

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

Use **Copy code** for a code block without its fence or language label, or **Copy answer** for the original Markdown answer without activity and execution reports. The control shows **Copied** only after clipboard access succeeds; if the browser blocks copying, retry or select the text and copy manually. Code blocks support keyboard focus and horizontal scrolling. When reading earlier messages, **Back to bottom** returns to the latest content and focuses the message box without changing your draft.

Answers support CommonMark/GFM formatting, including nested lists and quotes, tables, read-only task lists, reference links, heading anchors and fenced or indented code. Tables scroll within their own region on narrow screens. Raw HTML appears as text; images appear as labeled links rather than loading automatically. External links allow HTTP, HTTPS and email; relative file links do not open local files. Math, Mermaid and syntax highlighting are not included.

Use **Search chats** to filter existing chat names, titles, project names and folders. Matching ignores case and requires every space-separated term; it does not search message bodies. Search preserves your draft and current chat. Matching project groups temporarily expand and return to their previous collapse state when cleared. Escape clears the query; ArrowDown focuses the first visible result. The result count and empty state update as you type and remain consistent with polling.

The browser displays proposed writes and commands with **Allow once** and **Deny**. The permission selector can change modes while idle; explicit launch restrictions remain ceilings. See [permissions](../REFERENCE/COMMANDS.md#permission-modes).

All tabs connected to one server share an active session and permission mode. Refreshing reconnects to server state, including pending approval. Closing a tab does not cancel work. **New chat** retains the previous session; draft persistence follows the [session rules](SESSIONS.md#web-ui-drafts). Clicking the sidebar cat logo or **fatcat** text returns to the home screen through the same new-chat flow. This action is unavailable while disconnected or while a request or turn is running.

After 100 ordinary turns in the displayed conversation, the Web UI asks you to start a new chat before sending another ordinary message. Restored turns count too; compaction retains the history and does not reset this UI limit. Context/Memory commands remain available, and background tasks have a separate path.

Use the sidebar's session menu (ellipsis, right-click or Shift+F10) to inspect details, rename, change workspace, move to a project, fork or delete. Deletion asks for confirmation and removes saved conversation data. If another process changes the target, refresh its details and review again. Management is disabled during active work or approval. See [project and session operations](SESSIONS.md) and [materials](MATERIALS.md) for sharing and deletion effects.

Click the model name to choose an available model and an enabled thinking level for this session, then **Apply**. The compact rounded list hides unconfigured models and region labels. Models supporting medium default to medium; toggle models use on, and fixed-level models disable the slider. Mandatory reasoning never offers off. Existing saved choices remain unchanged until Apply; opening an off session's picker proposes the model's enabled default. Switching is disabled during active work, preserves the unsent draft and saves the choice with a persisted session; another tab's stale choice is rejected. Connections and credentials must already be configured on the host.

The context ring uses a fresh runtime estimate of the current effective request input, including the latest answer and tool results, and the current model's window capacity. It excludes unsent drafts. Click it for a compact **Context used / capacity percentage** row and progress bar. Cumulative usage, cache coverage and the most recent main request's reported input remain separate runtime data; they never supply the ring. Compaction recalculates occupancy without reducing cumulative usage, and switching models recalculates using the new model while retaining the old observation's identity.

A new empty chat shows **Not started**, with no occupancy percentage. System instructions and tool definitions already contribute to its prepared request baseline; this is not billed usage and is not forced to zero. Once a conversation starts, approximate counts show **≈**, with the method in a tooltip; unavailable counts/capacities show **Unknown**, and active work shows **Updating**. DeepSeek uses a rough ASCII/Han text approximation plus a conservative Unicode fallback for punctuation, emoji and other text; it is not an exact tokenizer. Other models or multimodal content need an applicable local counter or remain unknown. Opening the panel refreshes local preview without model requests, tools, compaction or session writes. The separate request-byte budget still applies. See [context accounting](../ARCHITECTURE/CONTEXT.md) for estimation limits, remaining-window versus input-headroom semantics and cache coverage.

Inside a conversation, an empty message box folds into its bottom toolbar after 1.2 seconds without focus or a hovering pointer. The send arrow rotates and fades into a sleeping cat; click the cat or activate it with the keyboard to expand and focus the input. A nonempty draft, active task, approval or the welcome page keeps the input open. The animation respects the system reduced-motion setting.

The message box uses a single bottom toolbar: Attachments, permission mode and workspace on the left; model name, context ring and Send/Stop on the right. On narrow screens, permission and workspace controls use labeled icons with tooltips. Hover or focus the ring for usage details. The paperclip at the bottom left opens **Attachments**; the eye at the top right opens **Preview**. Use the icon beside the Fatcat logo for a new independent chat, the plus beside **Projects** to create a project, and each project name/chevron to collapse or expand its chats. The bottom-left **Settings** icon opens a centered modal with appearance options (System, Light, Dark), current session information and the existing move-to-project flow. Close it with the X, Escape, or a click outside the dialog; focus returns to Settings. Theme and per-project collapse preferences are saved in browser local storage for the current origin. Reopening the same browser profile and Web UI address (including port) restores them after a restart; clearing browser data resets them. When storage is unavailable, collapse controls still work for the current page. Connection status appears at the sidebar’s bottom right: green **Local** or red **Disconnected**. Long code lines scroll within their code block. Preview shares the page on wide windows and overlays it on smaller windows; closing it returns focus to its entry point.

There is no account system or remote hosting. Credentials remain on the server. Saved history restores conversation text, the model selection and available session usage observations, not old approvals or live execution journals. Current occupancy is recalculated; responses without reported usage leave incomplete totals. See [Web UI architecture](../ARCHITECTURE/WEBUI.md) for interaction and accessibility details.

## Preview an HTML or SVG file

In Web UI, click **Preview**, enter a workspace-relative `.html`, `.htm` or `.svg` path, then **Open**. Current-turn reports also offer preview buttons for committed HTML/SVG writes. For shell-created files or restored history, enter the path yourself.

On narrow windows, Preview is modal: background controls cannot receive keyboard focus or clicks until it closes. Use Escape from the preview controls or the close button to return to the entry point. The embedded page receives its own key events; use Tab or Shift+Tab to return from its content to the preview controls before pressing Escape. Wide windows retain the nonmodal side-by-side layout. Resizing between these modes preserves the loaded preview and your unsent draft.

On wide windows, drag the divider or focus it and use Left/Right to resize Preview. Shift uses larger steps; Home/End select the minimum/maximum width. Escape cancels an active drag. Enter or double-click restores the default width. The width is saved for the current browser origin, including its port, and survives closing Preview or refreshing the page. Narrow-window overlays do not overwrite this preference. If browser storage is unavailable, resizing still works for the current page.

**Refresh** rereads the saved file and restarts the preview. Closing it stops its frame. A failed read clears the old preview. This is a single-file, isolated preview for inline content; it does not load a site's relative assets or run a development server. It works in read-only/Plan mode without model requests, permissions changes or history mutation.

For pages with local assets, scripted interaction, diagnostics or screenshots, ask Fatcat to use the controlled browser described in [local page checks](CODING.md#local-page-checks). That tool executes code and follows command permissions.
