# Web UI: local HTTP, interaction and previews

English | [简体中文](../../zh-CN/ARCHITECTURE/WEBUI.md)

[Architecture](README.md) · [Operating guide](../GUIDES/INTERFACES.md#local-web-ui)

Web UI is a local single-user entry. Browsers own drafts, menus and display snapshots; the shared core owns sessions, turns, tool facts and permissions. All tabs share one server's active session rather than running separate Agents.

## Module responsibilities

Private `@fatcat/webui` exports only `runWebUi`. CLI lazily loads it at the existing point. Importing the package does not listen, open browsers, register signals or request models. It depends on runtime/commands, not TUI/root application, preserving Controller/page ownership.

Server/browser modules and display types compile from src to package-local dist. HTML/CSS, icons/licenses and native directory helper copy during build. Root `images/logo/mini-logo.png` remains the shared logo source, copied into the package. User-provided walking.png, looking.png and sleeping.png belong to src/public and are served through explicit image URLs. Runtime lookup is module-relative, independent of repository root/cwd. HTTP URLs/whitelists remain; build checks prohibit Node/server imports in emitted clients. Type-only imports do not execute in browsers.

Former root webui/ and scripts/copy-webui.ts are removed without forwarding. Tests remain in `packages/verification/tests/webui/`, runners in `packages/verification/verify/`, using verification-only `@fatcat/webui/internal/*` when needed. See [Development](../DEVELOPMENT.md#workspace-package-boundaries).

| Source | Responsibility |
| --- | --- |
| `packages/webui/src/index.ts`, `open-browser.ts` | Core assembly, server exit and one-time system-browser opening |
| `packages/webui/src/server.ts` | Native Node HTTP, auth/origin, static whitelist and routes |
| `packages/webui/src/controller.ts` | Display transcript, revisions, submit/stop, approvals and host mutex |
| `packages/webui/src/types.ts` | Shared display protocol types without runtime behavior |
| `packages/webui/src/turns.ts` | Stateless history-to-turn and event-to-activity conversion |
| `packages/webui/src/client/app.ts` | Page assembly, snapshots, requests/polling, drafts and coordination |
| `packages/webui/src/client/transcript.ts`, `markdown.ts` | Turn DOM, caches, expansion and safe text rendering |
| `packages/webui/src/client/session-list.ts` | Session/project grouping, cache, collapse, menus and drag events |
| `packages/webui/src/client/composer-motion.ts` | Idle presentation timers, collapse/expand and wake-focus callback |
| `packages/webui/src/client/settings.ts` | Settings/focus, browser theme and existing session actions |
| `packages/webui/src/client/session-menu.ts`, `session-dialog.ts` | Target snapshots, menus/dialogs, keyboard and focus |
| `packages/webui/src/projects.ts`, `project-http.ts`, `project-management.ts` | Preview/confirmation entries, persistence delegated to Manager |
| `packages/webui/src/attachments.ts`, `attachment-http.ts`, `attachment-evidence.ts` | Upload, current scope and actual provenance display |
| `packages/webui/src/preview.ts`, `client/preview.ts` | Single-file snapshots and isolated previews |
| `packages/webui/src/folder-picker.ts`, `native-folder-dialog.ps1` | Bounded native directory selection, not a model tool |
| `packages/webui/src/client/model-controls.ts` | Temporary model/thinking forms and context ring/details from runtime |
| `packages/webui/src/client/cron.ts`, `permission-menu.ts`, `browser-evidence.ts` | Scheduling, mode and evidence operations on shared server |

## Browser page and view boundaries

app.ts owns the sole page snapshot, ETag, connection/submission state and coordinates drafts, approval/details, scroll following, preview resets and menus/dialogs. Views do not choose refresh/draft-clearing timing. Polling rejects old revisions; 304 updates connection only; disconnects retain drafts.

TranscriptView receives turns, Session ID/workspace and owns nodes/serialized signatures only. Unchanged turns reuse DOM; changed turns retain data-kind expansion; deleted turns clear caches. Markdown/source buttons capture render-time Session IDs rather than current selection at click. Existing components handle previews/evidence; app.ts retains scroll conditions/timing.

client/copy.ts accepts explicit text and calls Clipboard API for both code/answers. Code excludes fences/language; answers retain original Markdown without Activity, sources or reports. Show Copied only on success, otherwise retry/manual guidance. Copy does not request host, change history/draft/permissions. Toolbar is separate from horizontal code scrolling and code is keyboard-focusable. app.ts updates Back to bottom from distance/content/viewport and returns focus to input on intentional navigation, preserving polling follow conditions.

markdown.ts uses direct `marked@18.0.11` (pi-tui's existing version), building DOM explicitly from CommonMark/GFM tokens instead of hand parsing. Supports headings, paragraphs, soft/hard breaks, emphasis/strikethrough, nested/ordered lists, read-only tasks, nested quotes, tables, fenced/indented code, reference links/autolinks. Heading anchors have answer-local IDs. Source identity/copy semantics remain. Raw HTML is text; links allow http/https/mailto; images become labeled links without automatic loads; relative files never map to disk. No math, Mermaid or syntax coloring. Build copies pinned standalone ESM/MIT license and rewrites bare imports locally; whitelist registration is explicit, with no CDN/CSP expansion. See [Marked options](https://marked.js.org/using_advanced) and [tokens](https://marked.js.org/using_pro).

app.ts owns search text and passes it to SessionListView to filter existing summaries by NFKC/lowercase name, title, project and workspace, matching all terms. No history-body query, session switch or draft/persistence change occurs. Polling retains filters; empty results expose status/clear. Matching project groups expand temporarily without saving preferences, restored on clear. Escape clears before other actions; ArrowDown focuses first visible session.

client/preview-resize.ts owns only divider DOM, temporary drag state and origin-local fatcat-preview-width preference. Pointer capture drives desktop drags; arrows resize, Shift increases steps, Home/End reach limits, Enter/double-click resets, Escape/lost capture rolls back. Existing sidebar/conversation/preview minima determine bounds. Window shrink clamps layout without overwriting preferences. Overlay hides divider; desktop returns saved width, retained after close/refresh. Storage failure preserves page-local operation. FilePreview retains content/cancellation/focus without a React split library.

SessionListView owns list signatures/DOM, collapse state and formatters, receiving explicit snapshots. Collapse persists by project ID in origin localStorage through refresh/browser/server restarts. Click updates only that key; polling/rename cannot expand it; observed deletion removes state. Storage failure falls back to memory; new projects expand. Preferences are neither Session data nor authorization. displaySessions shares current-saved-session inclusion across menus/details/list, excluding drafts. Events carry targets; drag start/hover checks live availability through callbacks and drop resolves against current app snapshots before confirmation. Views call no APIs, store no second snapshot and own no business/persistence rules. Disabled states update even when matching signatures skip rendering.

New browser modules must join the server whitelist and be checked over real HTTP; never expose directory mappings. See [Development](../DEVELOPMENT.md).

## HTTP and local access

Bind only 127.0.0.1; see [Reference](../REFERENCE/COMMANDS.md). Startup generates a 32-byte random capability in URL fragment. Page removes fragment, keeps it in tab sessionStorage and sends Bearer headers. Provider keys never reach browsers.

Validate exact Host and, when present, actual local Origin. APIs require capability; no CORS. Static paths are explicit, not filesystem mappings. Chat CSP limits scripts/styles/connections to self; preview has separate paths/CSP. Set no-store, nosniff, no-referrer and forbid external framing.

JSON caps at 64 KiB, prompts at 32768 UTF-8 bytes; 32 connections, header/request deadlines 10 seconds and idle 15 seconds. Native picker responses temporarily allow 310 seconds. Upload streams use a separate bounded channel without expanding messages.

state supports ETag/304, polling about 700 ms foreground/three seconds background, not token streaming. Routes accept only allowed fields/types. Busy/approval states reject duplicate submit/management; stale approval/revision conflicts. Closing pages does not stop work; Stop/server exit cancels.

Capabilities are local credentials, not accounts/OS isolation. Link holders can operate the server. No remote hosting/external binding exists.

## Host state and material entries

Controller transcript is display state, not Session history. Unnamed chats may be drafts; [Session](SESSION.md#management-and-cross-module-relationships) defines saving beyond whether an answer exists. Restoring does not restore approvals, live journals, old activity reports or process telemetry. Runtime restores available session consumption and observations and recalculates current input estimates.

Import WebUiInfo/WebTurn/WebUiState from types.ts; approvals directly from permissions, without Controller re-exports. turns.ts only transforms explicit history/events, holding no Controller/Manager/mutable host. Restoration extracts actual attachment-read evidence from successful text turns and ignores incomplete turns.

Controller retains active/management operations, display lists, revisions, approval coordination and shutdown. startTurn validates limits/visibility/lifecycle; private executeTurn dispatches Memory, Context, Automation and ordinary prompts. Automated prompts bypass manual local-command recognition. Install active before execution; settlement rejects leftover approvals, refreshes lists, then clears active/running Session. Recursive events, reports, activity truncation and revisions stay in Controller; formatting cannot change ordering.

Management declares restore/preserve transcript intent. New/resume/fork and current-session change/deletion restore displays under existing semantics; noncurrent management/rename preserve them. Attachment revisions remain at their existing operation boundaries. Controller does not reset usage: runtime restores the selected session's saved consumption and observations, preserves them through model/workspace/project changes and compaction, and starts independent accounting for new sessions and forks. Current input estimates are refreshed after management. Failures independently refresh Session/Project metadata, retain original errors and neither replace transcripts for retry nor replay actions. Committed durable effects do not roll back. See [Development](../DEVELOPMENT.md).

At 100 displayed non-contextOperation turns, reject new manual ordinary submissions, including restored turns; background tasks use another path. Keep at most 20 context/Memory display operations and 100 activity entries per turn. These are UI limits, not history retention.

Menus target explicit IDs/revisions; inactive operations do not switch history arbitrarily. Conflicts refresh for new confirmation, never replay. [Projects](PROJECTS.md) owns organization/sharing/deletion, not frontend copies.

Initial/retry uploads bind initiating Session/project/generation and do not retarget on UI switches. Cancelled receives hold slots until stream cleanup. Sources derive from actual successful read/delegate_task evidence, labeled parent/child. Failed turns/children currently have no retained source panel.

Source HTTP permits local scoped reads only, rejects visual/transcribe/question and never requests a model on click. Reauthorize fixed original/parser versions under current scope, without raw disk navigation or attachment HTML execution. See [Documents](DOCUMENTS.md).

Core owns mode changes, automation and compact. Background work shows target identity without switching foreground; automatic summaries remain turn activity. Web has no separate usage observer: consumption, ordinary observations, estimates and capacity come from SessionManager.contextUsage. See [Context](CONTEXT.md).

## Model, thinking and context controls

Empty unstarted sessions show `Context Not started / capacity` and — percentage, without presenting prepared system/tools as a started conversation or zeroing runtime estimates. Started/restored/history-bearing forks use full current estimates. In addition to injected-counter lifecycles, verify:webui-models uses production estimates for Chinese punctuation/emoji, real local reads, empty home, consecutive turns and resume; generation transport remains injected.

The model button opens a compact dialog/custom rounded listbox with available runtime choices only, displaying names without regions/unconfigured connections while submitting full identity. Arrows, Home/End, Enter/Escape work with inset focus borders. Slider uses enabled thinkingOptions: DeepSeek low/medium/high/max/ultra; fixed on cannot drag, unsupported thinking hides it, mandatory models have no off. Runtime defaults prefer medium, then on for toggle models, otherwise supported catalog defaults. Existing choices are not rewritten. Opening an off session proposes enabled default but changes only on Apply. Tooltips retain effective alias mapping without extra prose.

app.ts submits sessionId, revision, previous and selection to `/api/model`. Controller validates target/previous before Manager.setModel; revision-zero drafts also check previous against cross-tab stale choices. Busy rejects, errors retain form/in-dialog feedback, success refreshes labels without clearing drafts. Runtime owns save/preparation/activation and never silently falls back on missing connections.

The ring draws only current ready estimates/current window, never cumulative or latest reported input. Clicking shows one `Context used / capacity percentage` row/bar with K/M formatting. Approximate values use ≈, unknown uses Unknown, pending Updating, unavailable percentage —, never false zero. Tooltips retain full values/method/reasons without long explanatory panels. Clamp only graphics to 0–100%; actual percentage may exceed 100%. Runtime still exposes cumulative/cache coverage, latest identity/time and both headrooms unchanged. Cache hits do not reduce occupancy; thinking is not added twice.

Controller runs read-only previewContext after startup/resume, turn settlement (tools/answers/compaction), management and switching. Execution immediately invalidates to pending. Permission changes also invalidate/refresh. Opening details sends empty `/api/context/refresh` to resample guidance; polling only reads snapshots, without counting/model requests, and drafts never enter this API. Refresh queues serially; runtime rejects stale instance/revision results. Preview never generates, executes, compacts or writes sessions. Bytes/token limits remain separate.

ModelControls owns DOM, signatures and opening-time form only; app.ts owns snapshots/requests/drafts. Both popovers support Escape/outside click/focus return. Model adds a close button; compact context has no extra heading/close button. Toolbar anchoring stays in viewport, lists scroll internally, scale/fade respects reduced motion. Model/ring match left-button corners/rounded hover/shadow; three left icons use aligned 16px boxes.

## Two page-viewing paths

User Preview reads one workspace HTML/HTM/SVG into a short-lived single-use sandbox iframe. Inline scripts/styles are allowed, same-origin/external network/relative assets are not. No dev server; Free cannot widen scope. Refresh rereads disk, failure clears old content, close removes frame. No models/history changes/execution reports.

Native dialog shows nonmodal beside chat on wide screens; showModal blocks background focus/interactions in overlays while browser chrome remains accessible. Mode changes retain iframe/path/usable panel focus. Escape in panel controls/close cancels reading, removes iframe and restores entry focus or conversation fallback. Isolated iframe owns key events; Tab/Shift+Tab back to controls before Escape. No iframe DOM reading, injected key bridge or sandbox expansion.

Preview uses strict UTF-8 1 MiB limits, four concurrent reads/eight snapshots. Snapshots expire in 60 seconds and consume once. Creation/consumption validate workspace; directory changes invalidate old snapshots.

[Browser](BROWSER.md) owns controlled execution/interaction/JSON/PNG. Web only authenticates fixed-ID evidence reads: JSON via textContent, PNG via authenticated fetch/Blob without URL tokens; close revokes/cancels. Preview works in Plan/read-only; browser follows command permissions.

## Native bridges and interaction constraints

Directory helper uses system PowerShell/.NET, STA IFileDialog, fixed execFile arguments, shell=false, environment paths and 32 KiB output. Five-minute deadline, disconnect/shutdown cancellation and hidden owner bound lifecycle; PerMonitorV2/TOOLWINDOW avoid extra taskbar windows. Manager still validates selection; no permissions are granted.

Opener uses a hidden helper/environment URL and five-second deadline. Failure leaves the private terminal link while server runs. Exit cancels pending helpers without closing user browsers.

Use system fonts, neutral colors, shared logo and local licensed Lucide sprite, no CDN. Markdown supports the current subset with HTML as text. IME composition cannot submit; see guide for Enter/Shift+Enter. Menus/dialogs are keyboard accessible; mobile drawers trap/restore focus and nested Escape prioritizes inner surfaces. Respect reduced motion. CSS owns dimensions, not pixel inventories here.

Sidebar holds project/chat navigation and connection state without placeholder accounts. Messages, approvals and composer share widths/margins. One bottom toolbar places attachments/permissions/workspace left and model/ring/Send/Stop right. Narrow controls use accessible icons/tooltips; model labels truncate with full tips. Ring click opens compact summary; hover/focus shows occupancy. Top bar has preview eye and narrow sidebar toggle; new chat sits beside brand, new project beside Projects. Settings sits left of green Local/red Disconnected. No Cloud/Remote host exists. Responsive rules use actual conversation width; split preview preserves its minimum, narrower layouts overlay. Long code scrolls internally; drafts/material notices stay bounded, retaining reading room in short windows.

SettingsPanel is a native modal outside sidebar/main, centered/shadowed and focus-contained. X, Escape or outside click restores Settings focus. Close only when both pointer-down/click are outside; internal clicks/drags do not dismiss. It is independent of drawer/resizes. It owns display/focus/browser theme (System/Light/Dark) saved per origin, observes system changes and still works without storage. Session details/join callbacks use existing flows, not duplicate host settings/authorization. Draft project joining remains in settings after removing top-bar project labels.

Home shows only logo/main title. Activity/reports use compact collapsed summaries. Session details have fixed headers/internal scrolling, inset scrollbar, shadow and keyboard access. Draft details use page current snapshot, not saved lists. Project labels match Session name: left-aligned, separate line and consistent spacing.

Idle animation requires an existing conversation, connection and no submitting/running/approval. Empty text, no internal focus and no hover for 1.2 seconds hide the input, retaining toolbar. Arrow/sleeping cat rotate/fade with spring sizing. ComposerMotion owns DOM/presentation/timer only; app.ts supplies eligibility and owns draft/send/stop/focus. Collapsed area is inert; cat is independent type=button that only expands/focuses. Nonempty drafts stay open. Home/execution immediately expands; reduced motion disables transitions.

app.ts ResizeObserver calls existing height updates only on width changes from windows/split previews, not every height notification, preserving draft/submission/poll/scroll ownership.

## Verification and unimplemented scope

Package checks cover unrelated-cwd entry/assets/native helper resolution and rejection of private package/HTTP paths.

Check real HTTP auth/origin/size/static routes, busy/stale confirmation, disconnect/cancel/drafts/cross-tabs/directory/material changes. Edge uses temporary data and injected models/pickers for desktop/narrow/theme/focus/approval/preview. Native picker tests real Win32 separately; neither substitutes for the other or proves vision/model quality.

View changes require DOM reuse/replacement, expansion, captured identity and live drag gating through served modules in verify:webui. Use verify:projects for grouping/cross-tab joining, verify:documents/verify:attachments for sources, proportionally. Static checks cannot replace DOM/focus tests.

Layout probes cover long drafts, short windows, drawer/preview breakpoint sides, light/dark, alignment, hit-testing, width-driven input height, local code scrolling and polling-preserved reading. Synthetic IME events check guards, not full physical IME; screenshots still need human visual review.

Native Windows helper has real selection/cancel/abort/timeout evidence including 192 DPI PerMonitorV2, hidden owner, no extra taskbar window and cleanup. Helper-driven real dialogs do not establish every Windows/DPI setup. Non-Windows, physical phones and other browsers remain unverified.

verify:webui-models uses real Edge/SDK assembly with injected transport/local counters for choices/aliases, unavailable models, error retry, drafts, busy rejection, three metric types, answer/tool/compact refresh, old observations, unknowns, reload/resume, light/dark, 1440/390/320px, short viewports, icons, focus/reduced motion. Offline HTTP adds auth/origin/strict fields/stale session/revision/choice rejection and credential-free snapshots. Injected counts do not prove provider token precision; no real requests run.

verify:documents delays final context refresh after answers become visible: sources remain readable while busy/send gates hold. Consecutive submissions wait for actual send availability, not merely answer nodes. Request counts, observed input and visual/transcription provenance assertions remain strict.

Future UI work follows actual tasks and shared ownership, checking target actions, keyboard, narrow layouts, errors/cancel. Accounts, multiuser, remote publishing, interface-language switching, streaming, full message search, math/chart Markdown extensions, high-fidelity Office viewing, file restoration and replay are unimplemented.
