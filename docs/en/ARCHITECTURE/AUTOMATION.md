# Automation: session binding and bounded scheduling

English | [简体中文](../../zh-CN/ARCHITECTURE/AUTOMATION.md)

[Architecture](README.md) · [Scheduling guide](../GUIDES/AUTOMATION.md)

Automation reuses Session/Loop/Tools without separate history or permissions. Session-bound tasks continue target history; the advanced JSON runner creates a new Session per activation. Their persistent-counter semantics differ.

## Module responsibilities

| Source | Responsibility |
| --- | --- |
| `packages/runtime/src/automation/config.ts`, `cron.ts` | Triggers/budgets and five-field time matching |
| `tasks.ts`, `tool.ts` | Bound task structures and parent model tool |
| `scheduler.ts`, `files.ts` | Bounded queues, rotation, debounce and text snapshots |
| `conversations.ts` | Workspace discovery, baselines, leases and host lifecycle |
| `lock.ts`, `runner.ts` | Store/workspace exclusivity and standalone JSON mode |
| `packages/runtime/src/session/automations.ts` | Stateless projections, activation eligibility/deadline signals and mutation validation |
| `packages/runtime/src/session/agent-session.ts` | Task commits, durable claims/counters and turn commits |
| `packages/runtime/src/session/manager.ts` | Background target resolution and host mutex while retaining foreground selection |
| `packages/commands/src/automation/commands.ts` | Local Cron management/help and natural-language scheduling conversion |
| `packages/commands/src/commands.ts`, `packages/webui/src/client/cron.ts` | Shared command dispatch and Web UI forms |

User description/form → validate/save binding → idle discovery/activation → persist attempt increment/claim first → existing execution chain → save target history/state → refresh baselines. Trigger metadata enters request guidance only; read still obtains file bodies.

Import `automationCommandPrompt` directly from `packages/commands/src/automation/commands.ts`. Natural-language `/cron <description>` only becomes a model request. `/cron`, list/pause/resume/delete call existing SessionManager operations without models or history writes. Lists show only current-session tasks. Commands do not own counters, permissions or background selection.

## Identity, persistence and switching

Tasks belong to Sessions and store prompt, trigger, enabled, creation/expiry, maxRuns/runs, lastStatus and lastScheduledAt. Before execution, claim atomically with the attempt; the same scheduled time cannot be claimed twice. Failure/cancellation consume attempts. Crashes do not auto-replay models/tools.

Definitions/counters persist; pending queues, cron watermarks and file baselines are process-local. No offline catch-up; expired at triggers skip, intervals recover from creation phase. Forks do not copy tasks; deleting Sessions removes bindings; nonpersistent mode creates no bindings.

Discovery covers the current workspace, not the global Session list or selected Project. Activations bind actual sessionId/locationRevision/workspace and revalidate before execution. Joining/changing project directories atomically pauses tasks and invalidates old activations. Reenabling resets neither count nor expiry. Directory changes replace leases; returning does not replay missed events.

Automated turns do not switch foreground history. Children inherit the actual background identity. Children/automated turns cannot use current model tools to create/change schedules or mutate Memory.

## Session integration boundaries

`session/automations.ts` receives snapshots/explicit arguments, not Manager, active sessions or scheduler caches. sessionAutomations creates deep-copied projections from loaded records. prepareAutomationRun validates workspace, optional locationRevision, task existence/enabled/expiry/count, running state and scheduled time, then combines caller cancellation with expiry. prepareSessionAutomation prepares management changes; AgentSession commits them.

Manager listAutomations first excludes other-workspace, invalid-project and taskless summaries, then loads/rechecks workspace and projects. Current targets reload durable records before execution, check owner/directory/generation and activate new revisions when needed. Background targets open independent Managers through resolution, reuse workspace Agent assembly and preserve foreground selection. Background management retains target routing/operation locks.

Only after eligibility checks does the current target release the outer busy flag and enter its own run mutex. Foreground Manager remains busy during background execution. All exits preserve finally release order. Preparation neither increments runs nor saves records. AgentSession claims/increments atomically on actual start; pre-entry cancellation does not claim, while failure/cancellation after claiming counts and settles. Expiry still aborts the current turn. Scheduler retains leases, queues and baselines rather than moving them into Session integration.

## Scheduling and file semantics

Limits are 32 tasks per Session, 128 enabled tasks and 64 distinct watched files per workspace. Defaults are 20 attempts/24 hours, with 1–1000 attempts and one second to seven days allowed. Execution is serial with at most one pending activation per task, busy-time coalescing, fair rotation and foreground priority. Expiry cancels active turns.

See [Configuration](../REFERENCE/CONFIGURATION.md#automation-json) for trigger fields/ranges. Session-bound at must be future at creation and before expiry. Standalone JSON may load past at but skips it. Cron supports only Node local time/UTC; DST gaps skip, backward shifts may match twice, and the startup minute is not replayed.

File triggers accept explicit workspace text paths, 1–32 per task, 1 MiB each, with 1–60-second debounce. Recursive/glob, hidden/dependency/link/outside paths are rejected even in Free to go. Roughly one-second content snapshots detect creation, modification, deletion and atomic replacement; changes reverting to identical bytes between polls can be missed.

Polling pauses during automated turns. All tasks rebuild baselines afterward, including failure. Self-writes do not trigger other tasks; concurrent external changes are also ignored. Invalid/unreadable paths pause corresponding bound tasks; standalone runners fail explicitly.

## Permissions and standalone runner

Task fields cannot grant tool permissions or change provider. Manual still requires approval; Plan/read-only/shell-deny remain. Noninteractive input cannot approve. Exclusive locks coordinate schedulers only within the same store/workspace and do not prevent editors/other sessions modifying files.

JSON runner loads once, uses whole-process budgets and fresh Sessions, and resets counters/baselines on restart. See [Configuration](../REFERENCE/CONFIGURATION.md#automation-json) for schema and [Guide](../GUIDES/AUTOMATION.md#standalone-json-runner) for launch/results. Individual turn or Session-storage failure does not guarantee nonzero exit when the runner exhausts its budget.

## Verification and unimplemented scope

Check injected clocks, durable claims, failed-attempt counts, duplicate activations, invalid identity, lease switching, self-trigger suppression and parent/child cancellation. Real temporary-file and Edge-form checks use injected models, not natural-language scheduling-quality evidence.

The process must remain running. OS services, Windows Task Scheduler integration, offline catch-up, webhooks, arbitrary hooks, event chains and DAGs are absent. There is no exactly-once guarantee across arbitrary store roots. After forced termination, inspect lock ownership before cleanup.
