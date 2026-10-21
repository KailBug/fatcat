# Session: history, execution claims and persistence

English | [简体中文](../../zh-CN/ARCHITECTURE/SESSION.md)

[Architecture](README.md) · [Session guide](../GUIDES/SESSIONS.md)

The Session system separates successful conversations, current persistent records, host selection and storage. Workspace files and tool effects are outside session transactions.

Memory and disk history directly use Fatcat messages: assistant calls are `toolCalls`, results associate through `callId`. `session/history.ts` validates successful history and incomplete attempt.messages without Chat Completions history conversion. It checks complete turns, tool associations and prefixes; providerReplay must pass format, canonical-field separation and call-ID association checks. These are current correctness constraints. Current runtime supplies system guidance. Reading, forking and resuming never execute historical calls or restore approvals. See [Model boundaries](PROVIDERS.md#internal-messages-and-api-boundaries).

## State owners

| Source | Responsibility |
| --- | --- |
| `packages/runtime/src/session/session.ts` | Successful in-memory history, projection and serial execution; replace history only on success |
| `packages/runtime/src/session/agent-session.ts` | Sole owner of one active record; claims, checkpoints, commit/failure settlement and recovery guidance |
| `packages/runtime/src/session/manager.ts` | Selection, host mutex, workspace preparation, project coordination and background routing |
| `packages/runtime/src/session/models.ts` | Stateless restoration adapters; unavailable selections remain readable but fail execution |
| `packages/runtime/src/session/attachments.ts` | Stateless transfer/cleanup, list/download/remove/delete, document authorization and identity binding |
| `packages/runtime/src/session/projects.ts` | Stateless full join previews and project draft projection using Project rules |
| `packages/runtime/src/session/memory.ts` | Scope, mutations, request conversion and migration statistics inside Manager identity/owner validation |
| `packages/runtime/src/session/store.ts` | Queries, project projection, bucket locks, revisions/owners and cross-file coordination |
| `packages/runtime/src/session/snapshots.ts` | Stateless bucket paths/discovery, bounded reads, publication and deletion; no project projection/transaction locks |
| `packages/runtime/src/session/record.ts`, `history.ts` | Decoding, constraints, complete turns and tool associations |
| `packages/runtime/src/session/execution.ts` | Capture Session, Project, ownership generation and effective workspace |
| `packages/runtime/src/session/automations.ts` | Task projections, eligibility/deadline signals, mutation validation and candidate records, without duplicate active state |
| `packages/commands/src/session/commands.ts`, `labels.ts` | Local commands and confirmation invalidation after successful switches; labels/list formatting |

Programmatic Session retains an in-memory entry; ordinary clients use SessionManager.open/run. Manager reads defensive AgentSession snapshots without another mutable record. Cross-directory switching prepares the target Agent first and preserves current state on failure. workspaceAgentFactory in `packages/runtime/src/agent.ts` caches directory Tools/journals; execution targets rebind identity/material access. See [Agent Loop](AGENT_LOOP.md).

## Host command boundaries

`packages/commands/src/commands.ts` provides `runInteractiveCommand`/`interactiveCommandHelp`, directly composing Memory, Context, Cron, Skills, Project, Attachment and session handlers. Only explicit compact requests summaries during command handling. Entries first convert natural-language `/cron` into ordinary model requests; conversion itself does not schedule.

Capability owners implement commands: `packages/commands/src/project/commands.ts` owns parsing/listing/join previews/confirmation; `packages/commands/src/attachments/commands.ts` owns listing/import/removal/deletion confirmation; `packages/commands/src/automation/commands.ts` owns local Cron/prompt conversion. Context/Memory retain their modules. `packages/commands/src/utils/command.ts` only parses argument text/escapes output statelessly. `packages/commands/src/session/labels.ts` supplies labels/lists without reverse runtime dependencies on dispatch.

`runSessionCommand`/`sessionCommandHelp` cover session commands only; `packages/commands/src/commands.ts` composes the full entry/help. Outside the package, import dispatch from `@fatcat/commands`, `Conversation`/session commands from `/session`, `sessionLabel`, `sessionScopeLabel` and `formatSessionList` from `/session/labels`, and `automationCommandPrompt` from `/automation`. Internal relative imports share one Project confirmation WeakMap and runtime SessionManager class identity. Moves retain no historical re-exports. Unmatched commands still return undefined; syntax, validation order, errors, output and switched semantics remain.

Project tokens live in a Manager-keyed WeakMap, not history/records. Matching confirmation consumes before checking the active session/calling joinProject; failure cannot reuse it. Cancel, successful project use and successful new/clear/reset/resume/fork clear it. Lists, bare resume, workspace and failed selection do not. Session entries explicitly notify Project after switching; state does not move into Manager or alter programmatic behavior.

Handlers call existing SessionManager APIs. Original modules retain business state, permissions, mutexes and persistence. Web UI retains management APIs without the full terminal set. See [Development](../DEVELOPMENT.md) and [Commands](../REFERENCE/COMMANDS.md).

## Current persistent format

See [Configuration](../REFERENCE/CONFIGURATION.md) for storage roots. Sessions are UUID JSON files in canonical-workspace hash buckets. storageWorkspace fixes the original bucket; effective-directory changes never move history. Project directories are separate. Session location is an independent directory or project ID, never an overrideable project-directory copy.

Records contain version, identity, name/times, revision, complete successful history, latest incomplete attempt, compaction, tasks, ownership generation/pending notices and optional activeOperation. Credentials, approvals, permissions and process telemetry do not persist. Prompts, tool arguments/results, web/file bodies and loaded Skills are plaintext history.

- Read/write only v4, without selecting versions by model/thinking data. modelSelection remains optional for injected Sessions without identity.
- No v1–v3 read/migration/writeback compatibility. Direct old-version reads report SESSION_CORRUPT; ordinary lists skip unsupported records. Existing files are never automatically rewritten/deleted.
- Versions explicitly reject unsupported formats. Establish post-launch compatibility under [Project principles](../PROJECT.md). Mixed-version concurrent writers are unsupported.
- Snapshots cap at 64 MiB. Validate identity, revision, messages and tool associations. Successful history contains complete turns, never incomplete attempts.
- Missing/corrupt/unavailable Project directories permit history viewing but reject execution without launch-directory/independent-scope fallback.

## Snapshot file and storage coordination boundaries

`snapshots.ts` receives explicit roots, buckets, records or IDs and owns only file mechanics. Reads check size, UTF-8, JSON and physical bucket before record.ts decoding. After closing handles, SessionStore reads current Project state through projectProjection. Durable project IDs stay separate from runtime directory/name/revision/projectError; do not cache resolution or rewrite on read.

Publication retains fixed storageWorkspace, 64 MiB limits and temporary write → sync → close → rename → cleanup. Deletion targets specified files, treating missing as deleted. Helpers neither validate business revisions nor lock and cannot replace Store save/delete. Attachment transactions retain Store-injected publish/delete callbacks, existing commit/recovery and journal formats, without another transaction layer.

SessionStore retains filtering, ordering, name/ID matching, duplicate detection and operation-specific errors. Ordinary lists skip corruption; direct reads diagnose it; project-management scans reject corruption that might hide members. Do not replace strict discovery with permissive listing. Bucket locks, owners/revisions, draft preparation, Memory gates and project orchestration remain in coordination.

See [Development](../DEVELOPMENT.md#session-snapshot-and-storage-boundaries). File helpers own no active session, cache or duplicate record; original domains retain formats and recovery.

## Execution, commits and interruptions

Persist attempt/ownerPid before models/tools; checkpoints update it. Success commits full history and clears unfinished state. Failure/cancellation preserves successful history and separately saves stop reason/messages. Only the latest incomplete turn remains, not a permanent failure audit.

Manual compact persists activeOperation with unique ID/PID before external requests; automatic compact reuses the turn attempt. Live claims block other processes joining/deleting/overwriting. Revalidate revisions under lock, not UI idleness.

Settlement-write failure retains pendingSettlement. Later execution/switching/management first retries the same settlement. After forced exit, recover only once the owner is confirmed gone, without restoring calls/approvals. PID reuse, incomplete locks and recovery-lock residue may report busy conservatively; this is not OS process-birth identity assurance.

Recovery adds bounded interruption guidance to request copies, requesting file/process inspection, without splicing orphan tool messages into valid conversations. Directory/ownership notices project into the next request and are acknowledged only on successful commit, surviving failure.

AgentSession delays root completed; Manager releases its lock before notifying observers. Final-save failure after an answer reports SESSION_STORAGE/stopped while retaining usage/effects. Ordinary programmatic Loop/Session do not provide durable ordering. Callback errors/crashes cannot guarantee final reports.

## Management and cross-module relationships

New sessions retain old ones. Fork copies complete history to a new ID without tasks. [Attachments](ATTACHMENTS.md)/[Memory](MEMORY.md) define association/pin/memory branching.

Unnamed Web UI chats may be revision 0 drafts. Ordinary turn startup, successful attachment publication, explicit naming/forking and task creation save them. Host Memory changes save their source first; later failure does not undo saving. Browsing, Memory/context queries, draft-model changes or empty-draft directory/project changes do not save. Nonpersistent mode remains in memory.

Manager permits one active operation; execution blocks switching/clearing/naming/management. Background scheduling resolves bound Sessions rather than UI selection. Directory caches reuse tools/journals only; materials bind actual identity.

SessionManager supplies attachment host operations; import AttachmentUploadTarget directly from `session/attachments.ts`. Manager resolves snapshots, captures upload identity, owns draft scope tokens, queues publication, retries pending settlement and activates results only for current sessions. It owns in-memory stores too. `session/attachments.ts` receives explicit stores/snapshots/identities and owns no selection, locks, activation or Session persistence. It handles streams, size checks and stage cleanup; publication callbacks enter Manager's original mutex. Never pass whole Managers or keep another active record in adapters.

[Metadata](METADATA.md) owns cross-file locks/decisions/forward recovery; [Projects](PROJECTS.md) owns membership/joining. Context stores projections without deleting history. Resume does not restore tool journals; old results do not prove current state.

`session/memory.ts` centralizes integration rules; Manager owns MemoryStore, mutex, draft save/activation and memoryOperation identity/owner validation. Import MemoryChange directly from its owner. activate binds original identity and each call revalidates. Helpers cannot retain active records/authorization. AgentSession owns evidence, allowance and callId reuse; SessionStore retains locks/durable identity. See [Memory](MEMORY.md).

`session/automations.ts` projects snapshots, validates eligibility and combines cancellation/expiry without loading/activating/claiming. Manager retains refresh, owner checks, background assembly and mutex; AgentSession retains mutations, claims/counters and settlement. ConversationAutomations owns queues, leases and baselines. See [Automation](AUTOMATION.md#session-integration-boundaries).

`session/projects.ts` makes preview/confirmation reread the same sources, keeps Memory under Manager validation and reuses Project draft transformations. Manager owns selection, owner checks, locks, Agent preparation/activation; Store owns discovery/commit/recovery. Prepare directory-change drafts before commit; refresh failure after rename cannot undo it. See [Projects](PROJECTS.md#session-integration-boundaries).

## Verification and unimplemented scope

### Session model selection (phase two)

`SessionManager.modelChoices` returns a credential-free catalog; `setModel(ModelSelection)` is shared switching. Acquire mutex, retry settlement, validate project/record freshness, check capabilities/credentials, prepare runtime, save by revision and activate. Busy state, live claims, conflicts, preparation/save failure never publish new choices. Revision 0 drafts change only memory; switching calls no generation, tools, network probe or compaction.

`modelSelection` stores provider, region, optional workspaceId, model and thinking and appears in SessionSummary. New sessions use host defaults; resume/fork/directory changes retain choices. Records without it use startup defaults in memory without read-time writes and gain it on the next real save. Unavailable connections/capabilities still allow history viewing but fail execution until explicit switching, without provider/region/key fallback.

`createAgent.forModel` rebuilds parent/child/summary/image adapters from explicit connections while retaining directory tools/journals. `forSession` binds actual identity/materials. Caller overrides remain; injected Agents without switch implementations reject. Background work restores its own session selection.

assistant.providerReplay stores API, source identity and provider extras without duplicate answer/arguments. Generic decoding checks API/source; adapters check extras, canonical-field protection and call IDs. Replay requires matching identity/current protocol; cross-model requests retain canonical text/tool facts. Summaries strip it; size/history checks remain. No permission, approval or tool replay is granted. See [Providers](PROVIDERS.md).

Runtime APIs/restored labels are implemented. Preview and consumption/reported/estimated separation are in [Context](CONTEXT.md#current-input-estimation-implemented-phase-three-runtime-api). Phase-four model menu, slider, switching and context controls use the same Manager; see [Web UI](WEBUI.md#model-thinking-and-context-controls).

Optional consumption/lastReportedInput store valid cumulative usage/latest ordinary observations. AgentSession consumes events and commits through existing boundaries. Missing usage cannot be backfilled; reads do not rewrite. Estimates/contextRevision are runtime-only and restore pending. Switching/compaction retain totals; forks clear consumption/observations. AgentSession owns state, context pure calculation/validation, Manager active instances/stale-preview rejection. Context defines coverage/cache semantics.

Checks cover current save/restore, read-without-write, invalid history/UTF-8/size/buckets, publication cleanup/retry, fresh project state, list/member-scan error differences, revision conflicts, real second-process run/compact exclusion, failed claim release, recovery notices, failed directory preparation and three-client behavior. Snapshot/storage regressions belong in `packages/verification/tests/session/`; domain tests retain transaction recovery. Fixed storage/injected checks do not establish long-task quality; browser checks do not establish connectivity.

Encryption, automatic retention, export/backup guarantees, file undo and automatic replay are absent. Commits cannot undo writes, commands, sent data or charges. New sessions do not clear directory journals.
