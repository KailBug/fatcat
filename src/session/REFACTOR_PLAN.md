# Session refactoring plan

## Scope and baseline

Requested branch: `feat/session-perfection`. Fatcat baseline: `f1bcf3f`.
The tracked working tree was clean before this work. Reference source was read
from the local `D:/pi` checkout on 2026-10-09; this is not a claim about upstream
pi or a dependency upgrade. Execution follows the phases below in order, with
checks at each boundary. Architecture documentation remains in
[`docs/ARCHITECTURE/SESSION.md`](../../docs/ARCHITECTURE/SESSION.md).

## Reference findings and decisions

| Concrete pi source | Finding | Fatcat decision |
| --- | --- | --- |
| `packages/coding-agent/src/core/session-manager.ts`: `SessionEntry`, `SessionManager`, `_appendEntry`, `_persist`, `buildSessionContext` | Persisted records and model context have explicit ownership; entries are append-only JSONL tree nodes. | Separate snapshot data/validation from disk operations. Retain version 1 atomic JSON snapshots, successful histories and separate interrupted attempts. No tree or format migration. |
| `packages/coding-agent/src/core/agent-session.ts`: `AgentSession`, event subscription and lifecycle state | The agent session coordinates execution and persistence for all interaction modes. | Introduce `AgentSession` for one active record, Loop execution, checkpoints, recovery projection and durable outcomes. Keep the small in-memory `Session` entry point. |
| `packages/coding-agent/src/core/agent-session-runtime.ts`: `AgentSessionRuntime`, `switchSession`, `createRuntime`, `apply` | Active-session replacement and cwd-bound services are distinct from a turn. | Retain `SessionManager` as Fatcat's host-facing selection and workspace boundary. Prepare target tools before activation; preserve the current session when preparation fails. Do not copy pi's teardown-first replacement policy. |
| `session-manager.ts`: `_hasConversation`, `_persist` | Empty setup need not create a file; a user message is saved before completion. | Preserve Web UI revision-zero drafts and claiming a revision before model/tool work. CLI/TUI creation behavior stays unchanged. |
| `agent-session-runtime.ts`: explicit fields, constructor assignments, named interfaces, small lifecycle methods | State ownership is visible and types describe concrete responsibilities. | Use explicit fields, named options, readable blocks and direct module imports. No parameter properties in rewritten classes, service container, plugin framework or compatibility barrel. |

At the baseline, the problem was responsibility overlap:
`manager.ts` mixed selection, durable execution, recovery prompts and schedule
policy; `store.ts` mixed snapshot shape/decoding with filesystem locks.
A final save failure must still preserve prior successful history and emit a
stopped outcome even if the model already answered. Schedule changes made by a
tool must remain in the same record through subsequent checkpoints.

## Phase 1 - Snapshot boundary

Status: verified (2026-10-09). Typecheck, build and 23 existing session tests passed.

- Move snapshot types, summary/name helpers and decoding to `record.ts`.
- Keep filesystem access, file limits, locking, atomic publication and revision
  checks in `store.ts`; `record.ts` shares the pure workspace bucket hash with
  decoding, which still verifies the storage bucket.
- Update direct consumers without re-export wrappers or changing serialized data.
- Gate: typecheck, build and existing session persistence/draft/workspace tests.

## Phase 2 - Active agent session

Status: verified (2026-10-09). Build and 38 session/automation tests passed,
including three new durable lifecycle fault regressions.

- Move one record's execution, checkpoint/commit/failure handling and request-only
  recovery/automation metadata into `agent-session.ts`.
- Keep selection, memory catalog, workspace preparation, cross-session automation
  routing and the shared operation lock in `manager.ts`.
- A narrow save callback and workspace automation listing callback connect the
  active session to the manager. The active record has one owner.
- Preserve public Manager/Session methods, completion timing, cancellation,
  draft creation, history isolation and revision conflict behavior.
- Gate: session and automation tests plus fault-injection checks for claim,
  checkpoint, final publication and observer failure after publication.

## Phase 3 - Automation policy and integration

Status: verified (2026-10-09). Final typecheck/build, 416 offline tests, CLI help
and real installed Edge session-workspace verification passed.

- Extract schedule argument validation, limits and file-watch checks into
  `automations.ts`. It prepares a record/result; `AgentSession` saves it.
- Preserve current-workspace discovery, attempt counters, background selection,
  self-scheduling denial and fork behavior. No scheduler redesign.
- Review all changed TypeScript against the concrete pi examples above.
- Gate: typecheck, full offline tests (including CLI/TUI/Web UI), CLI help and
  the existing real Edge session-workspace verification with injected models.
- Synchronize the Session/Automation architecture, project/roadmap and progress.
  Record actual results and unavailable checks here; do not infer live model
  validation from offline or browser checks.

## Invariants and exclusions

- No credentials, approvals or provider configuration enter snapshots.
- Successful history and incomplete attempts remain separate. Recovery does not
  replay tools, roll back files or restore permissions.
- A stale revision fails before model work; completed is emitted only after save.
- UI rendering, tool journals, permission enforcement and Loop control keep their
  existing owners. Runtime, pnpm, SDK and lockfile stay unchanged.
- JSONL/tree navigation, compaction, streaming, extensions, graph execution,
  permanent failure audit, imports and performance optimization are out of scope.
- This bounded refactoring does not complete the overall phase 2D roadmap.

## Execution log

- Planning: compared the local pi source above with Fatcat Session, Manager,
  Store, history validation, session consumers and persistence/automation tests.
  No implementation change preceded this plan.
- Phase 1: extracted `record.ts`, updated direct type/helper consumers and kept
  Store publication, locks and bounded reads. Typecheck/build and 23 tests passed.
- Phase 2: introduced `AgentSession`; Manager holds its runtime rather than a
  second mutable active record. Three new fault regressions and existing suites
  passed (38 tests). Completion is delivered after the Manager lock is released.
- Phase 3: extracted schedule preparation and added a failed-publication/listing
  regression. Reviewed explicit constructors, interfaces, named lifecycle methods,
  request projections and direct imports against the local pi examples. No new
  dependency, runtime change or lockfile modification.
- Final checks: `pnpm run typecheck`, `pnpm test` (includes build; 416 passed,
  zero failed/skipped), `pnpm run verify:sessions`, `pnpm start --help`, and
  `git diff --check` passed. Edge used temporary fixtures and injected models;
  it verified global selection, restored workspaces, existing/draft directory
  changes, actual reads, session menus, narrow layout and no page errors.
- Intermediate issues: sandbox Corepack could not resolve the registry; the
  approved host environment ran the existing pinned pnpm 11.21.0. The first full
  test run included a stale ignored `dist/tests/webui-folder-picker.test.js`
  from another branch (417 tests, one failure). Confirmed its source was absent,
  removed only that generated test and its map, then reran the current suite.
  A temporary formatting attempt found no legacy compiler AST API in the installed
  TypeScript package; it changed no source. Formatting was completed directly.
- Handoff: all three bounded phases are implemented and verified. The user
  subsequently authorized committing, pushing and opening an English pull request.
  No live provider API, manual TUI or performance validation was performed.
  Existing snapshot size limits, full snapshot rewrites and process-bound
  automation remain. Further storage/context changes require a new scoped plan.
- Main integration (2026-10-09): merged main at `952e1ed` into the feature
  branch. Preserved both architecture/progress updates and main's native Windows
  workspace picker; removed the obsolete browser workspace dialog. Session
  record imports remain aligned with this refactor.
- Integration checks: `pnpm run typecheck`, `pnpm test` (includes build; 418
  passed, zero failed/skipped), `pnpm run verify:sessions`,
  `pnpm run verify:webui`, and staged whitespace/conflict checks passed.
  Both browser checks used real installed Edge with injected model decisions
  and workspace pickers. Native dialog clicks and live provider requests were
  not exercised. The user authorized pushing this integration to PR #76.
