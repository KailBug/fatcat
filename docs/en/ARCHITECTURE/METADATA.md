# Metadata: cross-domain commits and recovery

English | [简体中文](../../zh-CN/ARCHITECTURE/METADATA.md)

[Architecture](README.md) · [Development rules](../DEVELOPMENT.md#metadata-journal-and-transaction-boundaries)

`packages/runtime/src/metadata/` coordinates cross-file Session, Project, attachment-association and Memory-migration commits. It is internal runtime code, not a separate package, and owns no active session, upload, domain validation or user confirmation state.

| Module | Responsibility |
| --- | --- |
| `metadata/transaction.ts` | MetadataTransactions: same-root queues, process locks, commit preflight, durable decisions and ordered recovery |
| `metadata/journal.ts` | MetadataCommit, pure journal codecs and cross-record consistency validation |
| `metadata/files.ts` | Bounded JSON reads and atomic publication at explicit paths |
| `attachments/catalog.ts` | Catalog reads, format validation and publication without locks or association decisions |
| `attachments/files.ts` | Original locations, staged byte operations and original/derived cleanup |

## Calls and state ownership

SessionStore, ProjectStore and AttachmentStore prepare domain changes through existing entries/lock scopes. AttachmentStore retains association, pin, upload and deletion decisions and commits through MetadataTransactions. SessionStore still coordinates through the attachment store's metadata entry; ProjectStore uses the same-root coordinator. All instances share the same-root queue/process lock. MemoryStore retains scope locks, conflict validation and idempotent migration. Do not add another session, catalog or transaction cache.

MetadataSessionAccess accepts only Session publish/delete callbacks. AttachmentSessionAccess is defined by `attachments/store.ts` and additionally includes load/prepareDraft for actual uploads. Without injected callbacks, the coordinator still publishes/deletes directly in fixed Session buckets. Attachments owns directory/catalog access. The coordinator invokes domain file operations only while applying decisions, without exposing attachment-path or catalog-query APIs.

Source ownership changes do not migrate disk data: process lock remains root `metadata.lock`, journal remains `attachments/pending.json`, and catalog/original/derived/domain-record paths stay unchanged. Existing ATTACHMENT_* and SESSION_* codes/messages remain for caller recognition and recovery guidance. Document caches only reuse JSON helpers; they do not join shared transactions or gain access rights.

## Metadata commits and recovery

Lock order is **metadata gate → Project metadata lock → Session bucket lock**. Same-process same-root work queues; cross-process contention explicitly reports busy. Locks cover local metadata, never model calls, user confirmation or streaming uploads. Public reads/changes first recover existing commit decisions rather than passing partial commits.

Context preview is an explicit read-only exception. withMemorySession validates identity through the same gate; preview only checks for pending.json and rejects its presence without recovering or passing a partial commit. It neither creates missing roots nor reclaims stale locks, and permits only short synchronous locks in existing directories without domain writes. MemoryStore preview also creates no directories or recovered locks; ordinary execution/management retains recovery behavior. See [Context](CONTEXT.md).

`journal.ts` constructs disk shapes from explicit commit descriptions and decodes unknown data, validating versions, member patches, conflicting project changes and Memory-migration/Session-identity consistency. It reuses record validators without reading current stores or creating state owners. Ordinary commits write journal v2; Memory migrations write v3; reads accept v1/v2/v3. These versions are independent of Session v4 and Project v1; embedded session records accept only the current Session format.

After encoding/validating complete commits and checking record sizes, `MetadataTransactions` durably writes `pending.json`, then applies Memory migration, Session snapshots, Project snapshots, member patches, catalog, Session deletion, Project deletion and original/derived purge in that order. It removes the journal only after all succeed. It saves original encoded journals and executes validated results, never reserializing decoded runtime records as journals. Published journals are durable decisions: failure completes forward without replaying models/tools. Coordination still owns locks, ordering, idempotent replay and Session publish/delete callbacks.

`files.ts` only performs caller-specified bounded UTF-8/JSON reads or temporary write/sync/close/rename/cleanup. Optional reads treat only missing files as absent; corruption, overflow and other errors still reject. Staging, transactions and document caches use it directly, without transaction re-exports or shared authorization/lifecycle. Journal read errors retain `ATTACHMENT_CORRUPT`; decoding or execution failure after JSON reading reports `ATTACHMENT_RECOVERY_PENDING`, retains the journal and blocks later operations. See [Development](../DEVELOPMENT.md#metadata-journal-and-transaction-boundaries).

Catalog limit is 16 MiB, journal 96 MiB and Session snapshot 64 MiB. Complete originals precede visible associations. Pre-decision failure may leave undiscoverable blobs but cannot expose dangling originals. Same-uploadId retries do not duplicate associations. See [Memory](MEMORY.md) for idempotent migration.

Reclaim locks only after checking that the owner exited. PID reuse/incomplete locks may conservatively reject. Sync/rename provide local recovery, not losslessness under arbitrary power loss, disk corruption or malicious local processes. Stop older instances before upgrading; old protocols cannot write concurrently.

## Verification

`packages/verification/tests/metadata/` owns journal versions, record consistency, pre-decision rejection, read/recovery error boundaries and JSON size/UTF-8/failed-publication cleanup. Upload, cross-process locks and original destruction remain in `tests/attachments/`; Session read recovery remains with its contracts. Project member patches and Memory migration interruptions remain in `tests/projects/` and `tests/memory/`. Migrate all callers with internal APIs; retain no forwarding from former attachment transaction modules.
