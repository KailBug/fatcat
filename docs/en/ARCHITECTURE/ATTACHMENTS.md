# Attachments: originals, scope and publication

English | [简体中文](../../zh-CN/ARCHITECTURE/ATTACHMENTS.md)

[Architecture](README.md) · [Material operations](../GUIDES/MATERIALS.md)

The attachment layer stores immutable originals, scope associations and history retention. Successful upload does not imply parseable content. [Documents](DOCUMENTS.md) owns parsing/vision; [Projects](PROJECTS.md) owns project organization.

## Modules and identity

| Source | Responsibility |
| --- | --- |
| `packages/runtime/src/attachments/record.ts` | Original/association/pin/upload-target formats and fixed references |
| `packages/runtime/src/attachments/store.ts`, `memory.ts` | Persistent/in-memory originals, publication and access |
| `packages/runtime/src/attachments/files.ts` | Stateless staging paths, streaming byte writes, size/hash-checked reads, upload-owner record reads and original/derived cleanup |
| `packages/runtime/src/attachments/catalog.ts` | Catalog reading, validation and publication without locks or association policy |
| `packages/runtime/src/metadata/` | Cross-domain metadata gate, journal codecs, commit/recovery and JSON file operations |
| `packages/runtime/src/attachments/import.ts` | Import through current file permissions |
| `packages/commands/src/attachments/commands.ts` | Terminal parsing, help, output and deletion-confirmation text; scoped operations/cancellation forwarded through SessionManager |
| `packages/runtime/src/attachments/read.ts`, `tools.ts` | General read wrapper, text paging and authorized access |
| `packages/runtime/src/session/store.ts`, `manager.ts` | Actual Session identity, drafts, publication mutex and cross-file commit coordination |
| `packages/runtime/src/session/attachments.ts` | Explicit-identity access adapters, transfer/cleanup and authorized document cache wrappers; no active Session ownership |
| `packages/webui/src/attachment-http.ts`, `attachments.ts` | Bounded uploads and host material interfaces |

References use `attachment:<uuid>@<sha256>`; filenames are not identity. Calls bind sessionId, optional projectId and locationRevision, then reload actual Session/Project records to validate effective directory/revisions. A shared directory, known ID/hash, UI selection or model-provided projectId does not authorize access. Background work and children use the actual running Session.

Originals live at `attachments/blobs/<id>/<version>` under the Session store root; the catalog stores provenance and independent associations. Uploaders are provenance, not lifecycle owners of project materials.

## Associations, pins and lifecycle

| Operation | Current semantics |
| --- | --- |
| Project/independent upload | Publish a shared Project or private Session association respectively |
| Draft browsing/upload | Browsing project materials does not save an empty session; successful original publication also saves the initiating draft |
| Private session joins project | After confirmation, durably promote associations and recover them with ownership |
| fork | Copy valid private associations/history pins; project forks remain shared |
| Delete Session | Release private associations/pins, retaining project associations |
| Remove association | Revoke discovery/read/preview/download in the current scope; retain original and management receipt |
| Permanent deletion | Destroy only after explicit confirmation and with no other active association or retained pin; leave a tombstone explaining old references |

Save a pin before actual model reads. Direct references to authorized versions in history/attempts also retain pins. Pins prevent byte destruction but grant no access. Removed references retain identity but reopening must fail. Compaction retains original history pins, forks copy them and deleting the corresponding Session releases them.

Project deletion releases member associations/pins and destroys only originals without external retention. Deletion does not erase text already copied into history or delete workspace directories. No automatic garbage collection, retention period or orphan-original management entry exists.

## Upload and text reads

Originals are limited to 16 MiB. Web upload is separate from ordinary JSON messages, with four tickets and 120-second validity. Targets and ownership generations bind at initiation; UI switching does not retarget them. Joining, workspace changes or target deletion invalidate old transfers without redirecting them to the current session. Completed bytes can wait cancellably for busy-session publication.

uploadId supplies idempotency; stageToken/PID leases identify transfer owners. Same-ID concurrency is rejected; old requests can clean only their own part. A same-ID retry can reclaim a dead-process lease; there is no guaranteed background scan of all residue.

SessionManager resolves host targets. Internal access adapters and AttachmentUploadTarget belong to `session/attachments.ts` and are imported directly from their owner. Transfer runs outside the host-operation mutex. Afterward Manager queues, checks cancellation/draft tokens and calls store publication. Success/failure cleanup uses the captured stageToken. Size mismatch does not publish a draft and permits retry with the original uploadId. See [Session](SESSION.md#management-and-cross-module-relationships) for ownership and extension rules.

attachment:list queries filter filenames only. UTF-8 text/Markdown reads page complete lines, default 100 and maximum 200, within 16 KiB; oversized single lines fail explicitly. Catalog scans allow 1000 items. Fixed versions still report coverage/unread information; search hits do not imply full review. See Documents for nontext formats and parsed references.

In-memory storage allows 1000 originals and four pending uploads, with originals plus pending buffers capped at 64 MiB and lost on exit. This is not a total Node process-memory cap.

## Staging and publication coordination boundaries

`AttachmentStore` retains upload lifecycle: validate targets/metadata, claim ownership, revalidate stageToken, decide idempotent return/conflict, reload target Session, prepare drafts, update catalog and commit. `files.ts` accepts only explicit paths, attachment directories, byte streams, cancellation or expected sizes/hashes. It receives no entire Store and creates no upload manager, session state or authorization cache.

Staging has three phases: inside the metadata gate, check PID/old claims and save new ownership; outside it, stream bytes with the 16 MiB limit, cancellation, hashing and sync/close; then reenter and publish staging metadata only if the token still matches. Returned size/hash does not mean publication. On receive failure, close handles before Store cleanup using the captured token. After removing its part, reread ownership and delete json/lock only on a match. Old requests cannot erase new retry claims.

`completeUpload` retains identity revalidation, draft preparation, original validation/move, association updates and commit in the original short lock. Original bytes precede visible association publication; preparing a draft is not saving it. Idempotency, existing-blob retry checks and forward recovery retain their ordering. File helpers do not resolve current Session/Project or decide pins, associations or deletion permissions. Integrity checks do not replace Store authorization.

`record.ts` owns fixed references/staging formats, `catalog.ts` catalog file operations and `files.ts` original paths/cleanup. `metadata/` owns cross-domain commits. AttachmentStore retains its directory and directly calls catalog helpers inside the existing gate. Existing modules retain in-memory attachments, Session integration and Web uploads; no generic storage framework or compatibility re-exports are added. See [Development](../DEVELOPMENT.md#attachment-file-and-publication-boundaries).

[Metadata](METADATA.md) owns cross-domain lock order, journal format, commit order and recovery errors. Attachments retains original/association lifecycle; derived documents cannot replace original identity.

## Verification and unimplemented scope

Check upload cancellation/retry ownership, draft publication, changed-identity rejection, sharing/isolation, pins without authorization, fixed versions, removal/permanent deletion, publication faults and real second-process recovery. `packages/verification/tests/attachments/` also checks gate availability while receiving is paused, old streams not damaging retries, failed-stream cleanup and corrupt staging not publishing drafts. `packages/verification/tests/metadata/` covers durable identity versus temporary projections, version compatibility, pre-decision conflict rejection, read/recovery error boundaries and JSON size/UTF-8/failed-publication cleanup. Project member-patch and Memory migration interruption recovery remain in `packages/verification/tests/projects/` and `packages/verification/tests/memory/`. Edge material checks use temporary inputs and injected models, not document-understanding quality evidence.

Forced destruction of history-retained originals, background cleanup, cross-project material migration and storage encryption are absent. Originals, derived content, sessions and Memory cannot be merged into one lifecycle.
