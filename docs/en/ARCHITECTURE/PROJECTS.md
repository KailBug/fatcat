# Projects: directories, membership and management

English | [简体中文](../../zh-CN/ARCHITECTURE/PROJECTS.md)

[Architecture](README.md) · [Project operations](../GUIDES/SESSIONS.md#share-a-project)

Project is an explicit organization entity owning one working directory. Member Sessions retain independent histories while sharing project attachments and Memory. A common directory neither creates project membership nor grants extra file permissions.

## Modules and data ownership

| Source | Responsibility |
| --- | --- |
| `packages/runtime/src/project/record.ts` | Identity, name, workspace, revisions and Project v1 validation |
| `packages/runtime/src/project/store.ts` | Creation/query policy, revision checks, metadata gate and project locks/recovery |
| `packages/runtime/src/project/files.ts` | Bounded record reads, atomic publication and lock-owner reads |
| `packages/runtime/src/project/operations.ts` | Basic join preview, full comparison and post-confirmation record transformation |
| `packages/runtime/src/session/projects.ts` | Compose Memory/attachment state for joining and prepare projections for unsaved project sessions; no active-session ownership or commits |
| `packages/commands/src/project/commands.ts` | Terminal parsing/help/output and Manager-bound join confirmation tokens; business operations call SessionManager |
| `packages/runtime/src/project/management.ts` | Directory/deletion impact previews, member fingerprints and bounded directory patches |
| `packages/runtime/src/session/store.ts`, `manager.ts` | Discover members, revalidate revisions, coordinate commits and prepare target Agent |
| `packages/runtime/src/session/execution.ts` | Actual execution identity and ownership generation |
| `packages/webui/src/projects.ts`, `project-management.ts` | UI previews, one-time confirmation and entry coordination |

Project v1 lives at `projects/<id>.json` under the Session root, with 120-character names and 64 KiB records. Membership derives from Session location, not another member table. Sessions store only projectId; effective workspace resolves from Project while original storageWorkspace remains. See [Session](SESSION.md) for older-format compatibility.

Terminal `runInteractiveCommand` directly invokes the Project handler. See [Session host command boundaries](SESSION.md) for confirmation consumption and invalidation on switching. These temporary tokens are separate from Web UI management confirmation, are not persisted and grant no tool permissions.

Creation validates an existing directory without creating it or switching sessions. Members cannot override directories individually. An unavailable project fails execution rather than falling back to the launch directory. Tools may be shared by directory; material authorization cannot be cached that way.

## Project file and storage coordination boundaries

`files.ts` accepts explicit metadata directories, IDs, records or lock paths. Reads validate ID, size, UTF-8/JSON and record format, preserving missing/corrupt/other-storage error distinctions. Publication retains Project v1 and 64 KiB limits, using wx/0600 temporary files with write/sync/close/rename and cleanup of the current temporary file on failure. Helpers create no roots, acquire no locks, resolve no current Session and grant no access.

`ProjectStore` retains name/real-workspace validation, storage-directory creation, revision checks, the 10000-raw-entry list limit, filename filtering and name/ID sorting. Lists skip only PROJECT_CORRUPT/PROJECT_NOT_FOUND; direct reads report them. Other storage failures cannot become empty lists. Reading absent stores creates nothing; reading records does not require the workspace still to exist. Session handles current directory availability without silent fallback.

Lock order remains metadata gate → Project lock → Session bucket lock. `loadUnlocked()` and `withProjectUnlocked()` are real internal entries under an existing gate, used by SessionStore and others without reacquiring it, not compatibility exports. File helpers only read owner PIDs; Store owns liveness checks, reclamation gates, retries and release decisions.

Store creation uses file publication and PROJECT_STORAGE errors. Rename/directory management still publishes through MetadataTransactions journals with existing order/recovery errors. Different coordination contexts retain different failure semantics despite shared writing helpers. See [Development](../DEVELOPMENT.md#project-file-and-storage-boundaries) and [Metadata recovery](METADATA.md).

## Joining an independent session

1. Build a preview from explicit source Session/target Project, validate idle host/durable owner and prepare target workspace/Agent.
2. Show old/new directories, independent histories, shared private materials/Memory and paused tasks. Bind confirmation to material counts/scope revisions/fingerprints, Memory state and target revision.
3. Reload and recheck all identities, revisions, claims and sets before commit. Uploads, removal, Memory edits or project changes invalidate old confirmation.
4. Coordinate Session membership, attachment associations and Memory through the recovery journal. Update active runtime only after commit. Atomically pause tasks; locationRevision invalidates old uploads/queued activations.
5. Next requests receive directory/scope-change guidance. Old paths/results remain historical data; only a successful turn commit acknowledges the notice as applied.

Joining moves no workspace files, rewrites no history and restores no approvals. Reconfirming an already completed same-target operation recognizes completion; other conflicts require a fresh preview. A lost response is not proof that commit never happened and must not cause blind reexecution.

An unsaved Web UI draft without materials may update only its in-memory project binding. [Session](SESSION.md#management-and-cross-module-relationships) owns save triggers. Revocable scope tokens prevent old uploads from silently joining a new scope.

## Session integration boundaries

Join preview and confirmation share `sessionProjectJoinPreview`. Each starts from supplied Session/Project snapshots, checks membership constraints, reads private Memory through Manager callbacks, then reads attachment-sharing state for saved sessions. Memory callbacks retain identity/owner validation; drafts do not query persistent attachment scopes. Complete previews contain counts, revisions and fingerprints. Confirmation rebuilds and compares through `requireProjectJoinPreview`; equal counts or cached previews cannot replace revalidation. Final commits still validate material versions under original storage locks.

`projectDraftRecord` only builds candidate unsaved records. Same-directory changes update project name/revision; changed directories reuse the join transformation, retain storage buckets, increment ownership generation, record pending notices and pause tasks. It does not save drafts, replace runtime, own upload tokens or cache membership.

Manager retains target loading, durable-owner checks, Agent preparation, host mutex and activation ordering. Joining a noncurrent session does not switch the foreground; confirmation for the same already-joined project remains idempotent. Directory changes prepare Agent/necessary draft transformations before commit, then add final project name/revision or reload saved sessions. Deleting the current project first prepares a replacement draft in the launch directory. Rename commits before refreshing current session; refresh failure cannot undo the committed name. Preserve each operation's failure boundaries rather than introducing another transaction/lifecycle service.

SessionStore retains member discovery, revision validation and commit coordination. ProjectStore and attachment metadata transactions retain lock order/forward recovery. Terminal/Web UI one-time tokens remain interaction state, separate from business preview validation.

## Project management

Web UI supports rename, directory changes and confirmed deletion; the shared core owns behavior. CLI/TUI have no corresponding rename/delete commands. Management preview tokens are single-use and expire after ten minutes. Directories come from the controlled picker; the server does not accept arbitrary claimed paths as confirmation targets.

| Operation | Persistent effect |
| --- | --- |
| Rename | Update name/revision without merging history |
| Change directory | Update Project and member ownership generations/pending notices, pause tasks; retain histories/buckets/files |
| Delete | Delete member sessions/tasks, release associations/pins, destroy originals without external active references and retain workspace files |

Directory change only requires a valid new directory, permitting repair of lost old paths. Same-directory selection is a no-op. Current drafts update generation without saving empty sessions; managing unselected projects does not switch chats. Deleting the current project returns to an independent launch-directory draft. Memory scope becomes inaccessible, but orphan Memory files are not physically cleaned.

Under metadata gate and Project lock, commits rediscover at most 1000 saved members and verify fingerprints. Live claims, changed material sets or corrupt snapshots conservatively reject. Bulk directory updates use small patches without copying all histories into journals. See [Metadata](METADATA.md) for locks, versions and recovery.

## Design and verification boundaries

Durable membership controls sharing so deleting uploaders does not lose project materials. locationRevision separates scope changes from ordinary history appends so UI switching or one chat does not retarget uploads. Confirmation approves organization changes, not model file writes/commands.

Checks cover project/independent identity, same-directory isolation, cancelled/expired previews, inactive joins, drafts, background/child identity, two-process claims, post-journal faults, consistent member directory updates and externally retained originals. Edge injected-model/picker checks do not establish real-model or native-picker acceptance; see [Web UI](WEBUI.md).

`packages/verification/tests/projects/` also covers read-only absent stores, list/direct-read differences for corrupt/oversized/invalid-UTF-8/mismatched records, sync/rename cleanup, live/incomplete/dead lock owners and revision checks. Existing tests retain Session projection, no fallback on project errors and cross-process recovery coverage.

Detach, cross-project migration, recycle bins, undo and physical Memory cleanup are absent. Which materials/memories can follow detachment/migration requires a separate product decision, not inference from current sharing rules.
