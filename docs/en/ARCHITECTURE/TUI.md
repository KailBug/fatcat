# TUI: terminal interaction and telemetry

English | [简体中文](../../zh-CN/ARCHITECTURE/TUI.md)

[Architecture](README.md) · [Operation and shortcuts](../GUIDES/INTERFACES.md#interactive-tui)

TUI is an optional entry sharing SessionManager, Agent, Tools and Permissions. It owns drafts, display state and terminal lifecycle, not another persistent history or execution policy.

## Modules and data flow

Private workspace package `@fatcat/tui` directly exports `runTui`. CLI lazily loads it after validation/input handoff. Importing does not acquire stdin, register signals or request models. It depends on runtime, commands and existing pi-tui, independently emitting JavaScript/declarations without a new framework/state owner.

Former root `tui/` paths are removed without forwarding. Offline tests remain in `packages/verification/tests/tui/`; tests/native checks use `@fatcat/tui/internal/*` for App/views/telemetry. Production uses package root only. See [Development](../DEVELOPMENT.md#workspace-package-boundaries).

| Source | Responsibility |
| --- | --- |
| `packages/tui/src/index.ts` | Configuration/core assembly and approval injection |
| `packages/tui/src/app.ts` | Input, run/approval state, AbortController, commands and terminal settlement |
| `packages/tui/src/presentation.ts` | Stateless event display and write/command/browser approval formatting |
| `packages/tui/src/view.ts`, `theme.ts` | Markdown, width, layout, colors and control characters |
| `packages/tui/src/telemetry.ts`, `metrics.ts` | Turn/process, parent/child, latest-request and cache observations |
| `packages/commands/src/commands.ts` | Local dispatch; core owns semantics |

Editor submit → Manager execution → events/reports → telemetry snapshot → view. Increase saved-turn counts only after durable confirmation. Tools wait for separate approval input; replies never enter model history. Tools still revalidate after authorization.

Use pi-tui editing, Markdown and width/rendering without another terminal runtime or copied Agent loop. Chat retains terminal.ts/readline input, never consuming concurrently with TUI.

## Turn and presentation boundaries

`TuiApp.beginOperation()` installs cancellation, busy/editor submission state and timing before Session calls. Normal input/automation then call `beginTurn()` to reset turn display deduplication/start telemetry. Ordinary local commands do not reset these observations; explicit `/compact` starts separate summary telemetry. Shared initialization does not alter drafts or move turn state to helpers.

`runLocalCommand()`/`runTurn()` retain separate settlement. Local commands restore sessions/update footers, summaries do not add conversation turns, and command errors do not set process failure. Normal/automatic turns count actual success/failure; different background targets restore foreground conversation counts. App retains approval, cancellation, final refresh, exit waiting and terminal restoration.

Telemetry observes events first; App decides visibility, then `eventPresentation()` returns activity/messages, appended/refreshed in existing order. Writes deduplicate by ID/full fingerprint but display changed records; commands deduplicate by ID. Parent/child events share App sets. Reports still show complete summaries/stale-evidence notices; hiding repeats does not change telemetry.

`presentation.ts` owns no Session, App, editor, journal or mutable cache and executes no tools/approvals or event changes. Approval formatting receives only request/current workspace. Fresh approval input, draft isolation and tool revalidation retain ownership; view still escapes terminal text. Follow [Development](../DEVELOPMENT.md) TUI boundaries.

## Input, display and cancellation

Users may edit the next draft while running, but it is neither queued nor auto-submitted; paste never implicitly sends. Approval saves/clears drafts and requires fresh operation input, then restores them. Earlier pending input cannot become approval. File previews are bounded with truncation; commands show full text/scope.

Cancellation reaches parent/child models/tools and returns to input after settlement. Exit has a separate lifecycle, stopping rendering/restoring modes/cursor. Local Terminal adaptation prioritizes cancel/scroll; Kitty release packets cannot double-trigger. TUI continuation after cancellation does not imply identical chat Ctrl+C semantics.

At least 110 columns enables a sidebar; narrow/short terminals degrade layout, with full values via /status. Remove ANSI/OSC/C0/C1 before Markdown; NO_COLOR disables theme colors. Terminal capabilities still affect width, IME and colors.

Switching reconstructs user/assistant display without inventing old telemetry. Idle automation preserves drafts, uses target sessions and keeps foreground selection. New/reset does not clear totals, journals, permissions or effects.

## Metric definitions

| Metric | Source/meaning |
| --- | --- |
| Configuration/directory/permissions | Current Config, canonical tool root and policy, not model claims |
| Turns | Current execution/successfully saved counts; failure display is not saved history |
| Requests | Parent/child attempts including local rejection, not HTTP/billing count |
| Tokens | Validated provider data with coverage, parent/child and turn/process totals |
| Latest input | Latest ordinary parent prompt tokens, excluding unsent draft/final answer |
| Request bytes | Latest complete JSON/local budget, separate from token windows |
| Cache | Weighted valid hits/covered input plus coverage, not KV capacity/cost |
| Execution | Actual tools/journals/reports without inferred task success |

Unknown/invalid/overflow remains unknown; valid zero differs from missing. Valid pre-failure usage remains. Telemetry uses raw events, never adds report totals again. [Providers](PROVIDERS.md) validates fields; [Execution reports](EXECUTION_REPORT.md) defines facts.

TUI does not guess token windows; byte progress cannot substitute for capacity. Every new parent request clears old observations. Summary/document requests add usage without posing as chat context. Automatic compact remains one turn.

## Verification and future requirements

Offline checks cover dimensions, missing/conflicting metrics, parent/child deduplication, write updates/cross-turn display, synchronous approval, local-command errors, approval-input isolation, cancel/reset and restoration.

`pnpm run verify:tui` launches injected fixtures in a real Windows terminal with ProcessTerminal/temporary workspace. Follow [Development](../DEVELOPMENT.md) to check real write approval, draft restoration, explicit summary, cancellation/continuation, scrolling and exit. On exit it asserts files, model input, history, statistics, raw mode and signal restoration and prints `passed: true`; inspect control sequences/display interactively. It loads no `.env`/model API and does not validate real-provider cache quality, full IME candidate windows or task quality.

Future interaction work keeps ownership and adds offline/native Windows acceptance for input, approval, cancellation and feedback, retaining ordinary CLI. No new layout/schedule is frozen.

No streaming answers, thinking-history display, provider hot switching, cost estimation or acceptance engine was added to TUI. Resume does not reconstruct process telemetry; rendering tests cannot replace real-terminal usability.
