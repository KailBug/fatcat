# Memory: user facts, scope and revisions

English | [简体中文](../../zh-CN/ARCHITECTURE/MEMORY.md)

[Architecture](README.md) · [Memory operations](../GUIDES/MATERIALS.md#remember-facts-across-conversations)

Memory stores durable facts, definitions, preferences and decisions directly supplied by the current user, separate from history summaries, attachments and RAG. Parent models can save through general write; host commands are optional management entries.

## Module responsibilities

| Source | Responsibility |
| --- | --- |
| `packages/runtime/src/memory/record.ts` | Scopes, provenance, complete revisions and persistent record validation |
| `packages/runtime/src/memory/store.ts` | In-memory state, locks, mutations/revision conflicts, capacity and migration coordination |
| `packages/runtime/src/memory/files.ts` | Bounded scope reads, atomic publication, lock-owner reads and file limits |
| `packages/runtime/src/memory/tools.ts` | General read and per-request current-state notices |
| `packages/runtime/src/memory/write.ts` | Reserved write addresses, evidence and capability guidance |
| `packages/commands/src/memory/commands.ts` | User management without model requests or successful-history additions |
| `packages/runtime/src/session/memory.ts` | Visible scopes, scoped mutation rules, model-write conversion and migration statistics; no active-session ownership |
| `packages/runtime/src/session/manager.ts` | MemoryStore instances, host mutex, draft save/activation, identity-bound access and per-operation validation |
| `packages/runtime/src/session/agent-session.ts` | Current parent user turn, mutation allowance and callId result reuse |
| `packages/runtime/src/session/store.ts` | Actual identity and durable attempt-owner revalidation |
| `packages/runtime/src/metadata/transaction.ts` | Idempotent Memory transfer during project joining |

MemoryAccess binds outside workspace Tools caches. Every operation revalidates Session/Project, locationRevision, projectRevision and effective workspace. Children inherit visible scope but cannot mutate; automated tasks cannot mutate either.

`session/memory.ts` receives explicit MemoryStore, identity and mutation provenance, handles source sessionId consistency, scope selection, identical active-content reuse and mutations; it is not an independent authorization entry. Manager memoryOperation wraps the whole read/change process. Persistent SessionStore.withMemorySession revalidates inside metadata locks; in-memory Manager checks current sessionId/locationRevision and optional turn owner. Do not validate only when constructing access or release the existing validation boundary between read and write.

Manager exposes listMemories/changeMemory. Import MemoryChange directly from `session/memory.ts`, not a manager re-export. First host mutation still saves/activates the draft before changing Memory; later failure does not undo that saved Session. Cancellation before the operation does not save it. Model writes derive default private/project scope from captured identity; AgentSession retains evidence, eight-attempt allowance and callId results.

MemoryAccess closures capture original identity/necessary draft snapshots on activate. Every list reenters Manager validation without caching records/authorization. Persistent old bindings still target their original sessions after switching; later joining, scope changes or deletion reject through storage validation. In-memory bindings require a matching active session. Join previews compute active counts and whole-record fingerprints after validated reads; zero active count cannot exclude tombstones.

## Saving and provenance contracts

write at memory:new saves to actual private/project scope; memory:global:new requires an explicit global request. `memory:<uuid>@<revision>` modifies an existing entry, with empty content deleting it. No specialized model tool is added; only successful tool results prove saving.

Natural-language changes require memoryEvidence matching the actual current user request verbatim. The host checks running attempt ownerPid/startedAt and records source sessionId, request, turn and evidence. Long requests retain bounded evidence excerpts marked requestExcerpt; turn is completed prior turns plus one. Host commands instead record literal commands and the completed-turn count at that time, with different provenance semantics.

Evidence matching proves input origin, not semantic intent or global authorization mechanically. Models must select direct user facts, not independently derive memories from web pages, tools, assistants or summaries. Current capability guidance supersedes old claims of inability to save but grants no other tool authorization.

Each user turn permits eight evidence-validated mutation attempts, including failed attempts. Same callId/arguments reuse committed results; different arguments reject. Identical active content returns the existing record without semantic merging or tombstone revival. Saving is an independent effect that survives later model failure, cancellation or Session-save failure.

## Scopes and current state

Independent sessions read their own and global records; project sessions read project and global records. Global belongs only to the selected store root, not a common directory. Project sessions create project or explicitly global records, never new private entries.

Memory is controlled metadata available in Plan/read-only, without granting ordinary file, command or network access. This is interface separation, not OS sandboxing. Nonpersistent Managers use independent memory stores; even global does not access disk global records. Draft queries do not persist; first host mutation saves its source Session first.

read supports memory:list and current UUID@revision, with literal active-body queries. Old/deleted revisions return MEMORY_STALE; invisible IDs return MEMORY_NOT_FOUND. /memory show can inspect revisions. Deletion is not physical erasure; historical text may remain.

Each parent/child model request reloads the current manifest and some active bodies. Notices do not enter successful history; omitted bodies can be read separately. Missing/stale/deleted records cannot regain validity from old reads, forks or compaction. This supplies state evidence, not a guarantee against repeated stale facts.

Context preview uses MemoryAccess.preview with the same manifest/body budgets/notice assembly through read-only metadata/Memory gates. It validates identity/scope without creating directories, recovering transactions or reclaiming stale locks, acquiring/releasing only short synchronization locks. Injected accessors without read-only preview make context estimation unknown rather than falling back to list. Ordinary execution retains list recovery semantics; see [Context](CONTEXT.md) and [Metadata](METADATA.md).

## Storage and lifecycle

| Boundary | Limit |
| --- | --- |
| Records per scope | 64 including tombstones |
| Body; source request/evidence | 1 KiB; 2 KiB UTF-8 each |
| Revisions per record | 32, reserving the last for deletion |
| Scope file | 64 MiB |
| read list | 16 KiB; default 20, maximum 64 entries |
| Request notice / body collection | 24 KiB / 8 KiB, still within full request budgets |

Files under memory/ are `session-<uuid>.json`, `project-<uuid>.json` and `global.json`, using bounded decoding, revision locks and atomic publication. Corruption/write failure cannot be overwritten as empty data.

Joining a private Session to a Project transfers all records, including tombstones, provenance and revisions. Previews display active counts and bind whole-record fingerprints; commit preflights target capacity/conflicts. v3 recovery journals idempotently publish project Memory before clearing private scope and coordinating Session/attachment ownership; partial commits are not observable. See [Metadata recovery](METADATA.md).

Independent forks do not copy private Memory; project forks remain shared. Deleting source Sessions does not delete project/global memories. Deleted Session/Project scopes become inaccessible while orphan disk files remain without physical cleanup.

## Scope file and storage coordination boundaries

`files.ts` receives explicit Memory directories, scopes, records, lock paths and cancellation. Scope reads reuse record.ts key/record validation, retaining symlink rejection, 64 MiB limits, strict UTF-8/JSON and scope matching. Only missing files return empty records; corruption cannot become empty-file replacement. Publication preserves v1 `{ version, scope, records }` and filenames, using wx/0600 temporary files, write/sync/close, another cancellation check and then rename. Failure cleans the current temporary file and preserves error semantics.

`MemoryStore` retains nonpersistent Map/serial queue, root creation, disk locks, retries/dead-process reclamation, mutations, revision/capacity checks and migration rules. File helpers do not create roots, lock, choose Session/Project or authorize. In-memory instances remain isolated, copy inputs/outputs and write no disk. Session retains identity, turn allowance and callId reuse.

Lock-owner reads return a valid PID from bounded content or unknown; cancellation propagates. Store retains PID liveness, reclamation gate and release order. Memory cancellation, link checks and error conversion differ from attachment JSON helpers, so it keeps its own functions without a generic storage framework or compatibility forwarding.

On Windows, exclusive lock creation may return `EPERM` while an old lock awaits deletion. Only acquisition retries cancellably up to 40 times at 25 ms intervals, without reclaiming/deleting another owner's lock. Persistent denial returns `MEMORY_IO`; `EEXIST` retains owner checks and busy `MEMORY_CONFLICT`. Owner-write failure after lock creation cleans that lock and fails without acquisition retry.

Migration preflight/merge remains under original locks. Publish project scope before clearing private scope. A later failure does not roll back published project data; replay deduplicates by original identity/content or rejects conflict. MetadataTransactions owns recovery decisions spanning Session/attachments; helpers cannot migrate independently. See [Development](../DEVELOPMENT.md#memory-file-and-storage-boundaries).

## Verification and unimplemented scope

Check natural-language write/read through production assembly, current evidence, Plan/read-only exceptions, child/automation denial, old capability replies, revisions/tombstones, restart/same-directory isolation, retained effects and migration recovery. Historical fixed DeepSeek examples checked saving, sharing across independent project histories, restart and other-project isolation. Edge replies are injected.

`packages/verification/tests/memory/` covers cancellation after scope/lock files open, cancellation after sync but before publication without overwriting originals and with Store lock release, and replay after project publication succeeds but private clearing fails. Existing tests cover corruption/overflow, revision conflicts, memory isolation, real second-process writes and lock recovery. File-boundary refactoring cannot replace these contracts with real-model/browser checks.

These results do not establish broad natural-language selection/use quality or other-provider quality. Automatic extraction, semantic merging, conflict resolution, task-semantic filtering, file provenance/pins, indexes and physical history cleanup are unimplemented. Enhancements/broad evaluation are deferred; first define representative tasks and capacity evolution when resuming.
