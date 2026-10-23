# Development and verification

English | [简体中文](../zh-CN/DEVELOPMENT.md)

[Documentation](README.md) · [Repository rules](../../AGENTS.md) · [Architecture](ARCHITECTURE/README.md)

## Local checks

Use Node.js 24.x and pnpm 11.21.0 on native Windows. Run commands from the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run build
pnpm test
```

`typecheck` checks package boundaries, builds the five product packages (JavaScript/declarations and runtime built-in Skills), verification JavaScript and its native probe, and the independent eval package, then checks the root start adapter without emitting it. `build` performs the same dependency build and package resource copies before compiling the root start adapter. `test`, `start` and the specialized verification scripts build first. Root `pnpm test` runs both eval and verification offline suites sequentially through pnpm. Run these commands sequentially so they do not compete for output. Choose checks proportional to the change; a documentation-only edit normally needs link, reference and diff checks.

Ordinary tests use fake credentials and injected model transports, without loading `.env` or contacting providers. They can use real temporary files and fixed PowerShell commands. They do not launch Edge. Offline provider contract tests cannot validate credentials, connectivity, model quality or real vision behavior.

The additional Linux evaluation path has its own [installation and rerun guide](GUIDES/LINUX_EVAL.md). Run `bash.test.js` and `headless.test.js` in the pinned task container; Linux-specific skips in the Windows suite are not Linux evidence. `packages/eval/dist/scripts/verify-linux.js` exercises the actual `/app` task cwd and the built headless executable's signal lifecycle. Docker/Python remain evaluation dependencies, not native Windows product requirements.

Model contracts live in `@fatcat/runtime/model-types`; tool definitions live in runtime `tools/types.ts`. The boundary check confines OpenAI SDK imports to `model.ts`, `model-adapters/chat-completions.ts` and `model-protocol.ts`. Injected Models and persisted session histories use canonical messages; HTTP transport fixtures use independent wire types in verification `tests/support/chat-protocol.ts`. Model contract checks cover exact prepared/sent JSON, full encoded byte limits, images and recoverable malformed arguments. Session tests cover the current format, durable tool history, interrupted attempts and recovery without replay; there is no legacy-session conversion or compatibility suite.

On Windows, HTTP fixtures using an OS-assigned port can intermittently fail with Node fetch's `bad port` before sending a request. Preserve the failed log and distinguish this from route/assertion failures when rerunning. A passing rerun does not resolve this existing fixture port-allocation limitation.

For startup and local configuration checks, use `pnpm start --help` and `pnpm start --checkConfig`. Configuration validation does not contact a model. See the [quick start](QUICK_START.md) for setup and [configuration reference](REFERENCE/CONFIGURATION.md) for environment values.

## Workspace package boundaries

The pnpm workspace contains the private root application, `@fatcat/runtime`, `@fatcat/commands`, `@fatcat/tui`, `@fatcat/webui`, `@fatcat/cli` and the development-only `@fatcat/verification` and `@fatcat/eval`. Runtime owns shared execution, capability state and persistence; commands owns shared host command dispatch, capability handlers, confirmation state, session labels and argument/output helpers. TUI owns its application, views, telemetry and terminal lifecycle in `packages/tui/src`. Web UI owns its HTTP host, controller, browser views and resources in `packages/webui/src`. CLI owns argument parsing, startup orchestration, terminal chat/input and approval presentation in `packages/cli/src`. Verification owns centralized offline tests, fixtures, specialized runners and their dependencies in `packages/verification`. The root retains the pnpm start adapter, workspace orchestration, documentation and examples.

Import runtime from its explicit package subpaths, such as `@fatcat/runtime/agent` or `@fatcat/runtime/session/manager`. These exports point to built `.js` and `.d.ts` files, not source aliases. Within runtime use relative imports. The dependency direction is root start adapter → CLI → TUI/Web UI → commands → runtime; CLI and clients may also use commands/runtime directly. CLI may load TUI/Web UI, while neither client may depend on CLI. TUI and Web UI depend on runtime and commands, never on each other or root application code. Commands may import only runtime package exports and its own relative modules. Product packages must not import verification/eval code or root scripts; runtime must not depend on commands or clients, and commands must not depend on clients. Do not cross package boundaries with relative paths or import another package's `src`/`dist`. No old root runtime, command, TUI, Web UI or CLI forwarding modules are retained.

The export map lists actual host consumers. White-box tests and specialized verification may use `@fatcat/runtime/internal/*` for implementation modules; this is an intentionally unstable verification surface, not a production API or an old-path compatibility layer. Do not broaden host exports solely to support tests. When adding a real host consumer, explicitly review and add its subpath to the manifest. Package boundaries do not change Session, store, permission or transaction ownership.

Commands exports its dispatcher at `@fatcat/commands`, capability entries at `/automation`, `/context`, `/memory` and `/session`, and labels at `/session/labels`. These map directly to their implementation modules; there is no compatibility barrel or command registry. Project/Attachment handlers and argument helpers remain package-private because current external consumers use the dispatcher.

TUI exports only `runTui` through `@fatcat/tui`. The launcher loads it lazily after CLI validation and input-owner handoff. Tests and native verification use `@fatcat/tui/internal/*` to exercise the real App, view and telemetry; production must not use these internals. Importing the package must not start input, install signal handlers or execute a model request.

Web UI exports `runWebUi` through `@fatcat/webui`; CLI retains lazy loading after argument validation. `@fatcat/webui/internal/*` is for tests and verification only. Keep HTTP, Controller, display contracts, browser modules, static resources and the native directory helper in this package without changing their state owners. Server and helper resource paths are relative to their built modules, never the process working directory. Importing the entry must not listen, open a browser, register signal handlers or request a model.

Verification is a private development package with no library exports or import barrel. Its `tests/`, `verify/` and `scripts/` compile to the matching paths below its own `dist/`; no declarations are needed. All five product packages and external fixture/browser dependencies are direct development dependencies. Production packages must not declare a dependency on verification (including a development dependency) or import its files. Only this package may consume product `internal/*` exports. Package boundaries are checked in tests and runners as well as production.

Root `pnpm test` and `verify:*` commands retain their names, arguments and environment-file behavior, building first and invoking the corresponding package executable. Building, installing or type-checking verification never executes its runners. The offline runner resolves the package root from its own module and discovers only `tests/**/*.test.ts`; browser/native/network/live runners stay outside that inventory. `scripts/copy-resources.mjs` copies the native inspection probe into the package build. The launch-adapter regression intentionally executes root `dist/scripts/start.js`, the version regression reads the root manifest, and the live read scenario still uses repository `examples/workspace`; these explicit checkout resources are not runtime code imports.

CLI exposes callable `runCli` at `@fatcat/cli` and the argv-executing process entry at `@fatcat/cli/entry`. These exports map directly to their owning modules. Verification uses `@fatcat/cli/internal/*` for parser, chat and terminal details; process tests resolve the executable through `import.meta.resolve`, rather than depending on a relative build location. The callable entry must not execute argv or acquire input on import. `VERSION` reads the adjacent CLI manifest; the boundary check requires its version to match the root application version, so update both together.

Browser modules remain plain ESM served through the explicit HTTP whitelist. They may use runtime/server types through type-only imports; emitted imports must stay inside `dist/client`. The package build checks literal imports and copies assets through `packages/webui/scripts/copy-assets.mjs`. Computed imports need explicit review. Do not expose server files, source maps, declarations or the native helper as static assets. Preserve HTTP URLs, capability checks and CSP; package exports do not enlarge the static whitelist.

Declare each external dependency in the package using it. Runtime owns model, parsing, network and browser dependencies; TUI owns its pinned pi-tui dependency, while verification declares the direct development dependencies for terminal fixtures, document fixtures and browser checks. Keep pinned versions and the shared lockfile. `pnpm install --frozen-lockfile` links workspace packages. `pnpm run check:boundaries` checks the current static/literal import forms, export use and direct dependency declarations; typecheck/build run it automatically. Computed module loading requires explicit review because the static check cannot infer its target.

`tsconfig.base.json` holds shared strict ESM/NodeNext settings. Product packages compile `src/` to their own `dist/` with declarations. Verification compiles its tests/runners without declarations; the root compiles only its start adapter to root `dist/`. Root typecheck/build select `./packages/*` and let pnpm build in dependency order (runtime, commands, the independent TUI/Web UI clients, CLI, then verification), so a clean checkout does not depend on stale declarations. Built-in Skills are validated/copied by `packages/runtime/scripts/copy-skills.mjs` into runtime `dist/skill/`; runtime locates them relative to its module. Web UI assets and the native folder-picker script are copied to its own `dist/`. The shared branding source `images/logo/mini-logo.png` remains repository-owned and is copied into Web UI at build time; the running package never reads from root images or source directories. Preserve worker entry paths, resource lookup and invocation-directory behavior during moves.

Keep product offline tests centralized under `packages/verification/tests/`, retaining the responsibility groups below. Package resolution, exported/blocked paths and execution from an unrelated working directory are covered in `packages/verification/tests/harness/runtime-package.test.ts`; `commands-package.test.ts` checks command exports and confirmation invalidation across package entries using the same runtime manager; `tui-package.test.ts` verifies side-effect-free loading and blocked private paths; `webui-package.test.ts` checks side-effect-free loading, private path rejection and HTTP/native-resource resolution from an unrelated directory; `cli-package.test.ts` checks the callable package entry and private path rejection; existing CLI subprocess and Skills checks cover entry/resource behavior. After package moves, remove only the corresponding obsolete generated outputs, verify source/compiled inventories, run typecheck/offline tests, and exercise affected native terminal and Edge entry points with injected models. Public-network or live-model checks require their own scope.

The independent private `@fatcat/eval` development package owns experiment protocols, injected Session adapters and statistics in `packages/eval/src/`, its tests and fixtures in `tests/`, and its offline launcher in `scripts/`. TypeScript compiles to matching locations under its own `dist/`, without declarations or public exports; the promptfoo integration subprocess also reads its package-local `.mjs` source fixture. Eval declares `@fatcat/runtime` through reviewed public subpaths and pins promptfoo as a development dependency. Product packages cannot depend on eval, even through devDependencies; eval and verification cannot depend on each other. Eval is not permitted to consume product `internal/*` exports. Ordinary imports/builds do not execute experiments; tests execute isolated Sessions with injected transports, without loading credentials or contacting model providers.

Eval is included in the workspace glob, root dependency build, lockfile and package-boundary scan (including its tests/scripts). Its test launcher selects current `tests/**/*.test.ts` sources and rejects missing compiled outputs or an empty inventory, just like verification. No cross-package helper imports or compatibility barrels are introduced. See [Evaluation protocol](ARCHITECTURE/EVAL.md) for the implemented contracts and remaining execution work.

## Internal interfaces and compatibility

Internal APIs, names and import paths may change to clarify ownership. Update all production callers, tests, verification scripts and documentation in the same increment. Import helpers and types from their owning module; remove forwarding modules and re-exports retained only for historical paths. A deliberate public facade or an external consumer may justify compatibility, but record that contract and its reason rather than treating every exported symbol as permanent.

Keep user commands and output, recovery semantics, state ownership, permissions, cancellation and side-effect ordering stable unless the task explicitly changes them. During development, session formats may change without a legacy reader or migration. Do not automatically delete or rewrite existing user files. Establish post-launch compatibility requirements explicitly, following [project boundaries](PROJECT.md).

## CLI parsing and startup boundaries

Keep `packages/cli/src/cli.ts` as the executable argv/exit-code entry. `packages/cli/src/cli/options.ts` owns the option definitions, help text, optional resume-selector normalization, implicit chat selection and argument-combination validation. Return typed parsed data without loading configuration, reading stores, opening input or registering signals. `packages/cli/src/cli/run.ts` owns startup orchestration and error/cleanup handling; importing either internal module must not execute argv. The package root maps directly to run.ts; /entry maps directly to cli.ts. Keep this callable/executable distinction and the real process entry used by the root adapter and subprocess tests; do not add forwarding files at old paths.

Preserve validation order and early returns. Syntax/combination errors precede help/version; selector-free resume through pipes lists sessions before empty-prompt, TTY or provider checks. Configuration checking and automation-file/watched-path validation retain their existing stages. Do not move all validation into parsing or eagerly load credentials for local operations. Keep permission defaults and enforcement in the existing PermissionPolicy path; argument parsing does not grant access.

The launcher owns its cancellation controller and temporary TerminalInput. Reuse picker input for chat; close it before starting TUI/Web UI so clients never compete for input. Keep signal registration, cancellation forwarding, stdout/stderr output and finally cleanup ordering unchanged. `scripts/start.ts` alone restores pnpm's invocation directory; direct CLI invocation ignores inherited `INIT_CWD`. Do not introduce a shared client-launch framework or move Session state into the launcher.

Keep parser and subprocess regressions in `packages/verification/tests/cli/`, including competing errors, `--` literals, optional resume values, credential-free paths and startup-directory semantics. Use the injected-model Windows terminal check below for picker/input handoff changes, in addition to typecheck and offline tests. The maintained module overview is in [Architecture](ARCHITECTURE/README.md); user syntax remains in [Commands](REFERENCE/COMMANDS.md).

## Host command boundaries

Keep shared host commands in `packages/commands/src`, with parsing, help and response formatting grouped by the capability they expose: `packages/commands/src/project/commands.ts`, `packages/commands/src/attachments/commands.ts`, `packages/commands/src/automation/commands.ts`, and the existing Context and Memory command modules. Use explicit handlers; the current command set does not need a registry or plugin framework. Session selection and workspace commands stay in `packages/commands/src/session/commands.ts`; shared text parsing/escaping belongs in `packages/commands/src/utils/command.ts`, and session labels in `packages/commands/src/session/labels.ts`.

`packages/commands/src/commands.ts` composes interactive dispatch and help, calling Project and Attachment handlers directly. `runSessionCommand` and `sessionCommandHelp` cover only session commands. Outside the package, import session formatting from `@fatcat/commands/session/labels` and natural-language Cron conversion from `@fatcat/commands/automation`. New handlers must leave unmatched input to the caller and preserve validation order, error codes/messages, output, cancellation forwarding and the `switched` result. Do not silently change accepted syntax while moving parsing code.

Command handlers call the existing SessionManager operations. They must not own another active record, add persistence or bypass permissions and operation locks. Temporary confirmation state belongs to the command interaction, stays bound to its manager and preview, and must retain its consumption/invalidation timing across successful and failed operations. Natural-language `/cron` conversion only prepares a model prompt; local Cron management must not call the model. See [Session](ARCHITECTURE/SESSION.md) for the maintained routing and state boundaries.

Keep command behavior tests with the owning capability; entry parsing belongs with the client. Exercise interactive dispatch and capability handlers as well as cross-domain lifecycle effects, especially confirmation invalidation after switching away and back. Reuse injected models and temporary stores, and verify that local commands do not enter model history.

## Session capability boundaries

Keep session-to-capability rules in focused modules such as `packages/runtime/src/session/attachments.ts`, `packages/runtime/src/session/memory.ts`, `packages/runtime/src/session/automations.ts` and `packages/runtime/src/session/projects.ts`. Pass explicit stores, identities, sources or snapshots; do not pass the entire SessionManager or create another owner of its active record. SessionManager retains selection, operation locks, draft persistence and runtime activation. AgentSession retains turn state, and the existing stores retain persistence and transaction boundaries. Move internal exports with their owner and migrate callers as described above.

For Memory, run the entire scoped read/change inside the existing Manager identity/owner gate, including the persistent metadata lock. Bind access to the executing session and revalidate every operation; never cache authorization or replace the captured identity with the UI's current selection. Preserve draft save ordering, cancellation, source attribution, per-turn budgets, result reuse and independent committed side effects. Keep access and lifecycle regressions in `packages/verification/tests/memory/`, including captured bindings and migration fingerprints with tombstones. The maintained contracts and ownership details are in [Session](ARCHITECTURE/SESSION.md) and [Memory](ARCHITECTURE/MEMORY.md).

For Automation, keep task projection, activation eligibility and deadline signal preparation in `packages/runtime/src/session/automations.ts`, alongside schedule-change validation. Manager loads and refreshes records, checks live owners, selects the current or background target, and retains host locks and their release ordering. AgentSession alone claims and counts attempts and settles turns; the scheduler retains leases, queues and file baselines. Do not cache eligibility, move counters into helpers, switch foreground selection for a background run, or create another task store. Keep regression tests in `packages/verification/tests/automation/`, covering stale activations, cancellation before and after claim, target isolation and lock release. See [Automation](ARCHITECTURE/AUTOMATION.md).

For Projects, share complete join-preview assembly between preview and confirmation, but read fresh Memory and attachment state on every call. Keep Memory reads inside the existing identity/owner gate and final revision checks inside the storage transaction. Draft projection helpers only prepare records; Manager keeps operation locks, target selection, Agent preparation and activation. Preserve each operation's ordering: directory changes prepare draft transitions before commit, active-project deletion prepares its replacement first, and rename refresh failures do not undo a committed project name. Do not wrap the whole Manager in a Project service or move transaction locks into these helpers. Keep scope, stale-preview, draft and failure regressions in `packages/verification/tests/projects/`; the maintained contract is in [Projects](ARCHITECTURE/PROJECTS.md#session-integration-boundaries).

## Session snapshot and storage boundaries

Keep snapshot file mechanics in `packages/runtime/src/session/snapshots.ts`: explicit root/bucket paths, bucket discovery, bounded reads, physical-bucket validation, atomic publication and file removal. Reuse `record.ts` for current-format encoding/decoding. Return the stored record without resolving projects, selecting a session, caching records or creating another store. Close the snapshot handle before SessionStore resolves current project state. A read must not rewrite data or create an absent store.

SessionStore retains query policy, project projection, operation validation, lock scopes, revision/owner checks and cross-file coordination. Keep bucket-entry limits, sorting, selector matching, duplicate detection and corrupt-file handling at their existing operation boundaries. Ordinary listing may skip damaged snapshots; explicit ID reads report errors and project management must reject scans that could hide members. Do not implement project membership through the permissive session list.

Snapshot publication/removal helpers are internal file operations, not substitutes for SessionStore save/delete. Invoke them through the existing locked transaction callbacks; preserve storageWorkspace, byte limits, file modes, sync/rename/cleanup and error codes/messages. Do not move metadata/project/bucket locks or journal recovery into these helpers, generalize all stores into a shared filesystem framework, or add compatibility forwarding exports.

Keep file/coordination regressions in `packages/verification/tests/session/`; keep project and attachment transaction scenarios with their owning capabilities. Run typecheck and offline tests, covering current-format reads, corrupt/oversized snapshots, fixed buckets, publication failures, conflicts, live owner claims and recovery without replay. Client-specific browser/terminal checks are needed when those interactions change, not solely because persistence code moves. See [Session](ARCHITECTURE/SESSION.md#snapshot-file-and-storage-coordination-boundaries) for the maintained boundary and [Metadata](ARCHITECTURE/METADATA.md) for lock order and journal semantics.

## Attachment file and publication boundaries

Keep physical attachment operations in `packages/runtime/src/attachments/files.ts`: validated staging paths, streaming writes, bounded size/hash verification and staging-owner record reads. Pass explicit paths, attachment directories, streams, signals or expected content metadata. Helpers close their own handles and return file results; they do not receive an AttachmentStore, acquire metadata locks, resolve sessions, publish catalog entries or create another upload owner. Reading ownership metadata does not grant ownership, and verifying bytes does not grant attachment access.

AttachmentStore retains claim/reclaim decisions, token checks, idempotency, current-target validation, draft preparation, catalog changes and commit ordering. Keep the three staging phases explicit: claim under the metadata gate, receive bytes outside it, then recheck ownership and publish staging metadata under the gate. Preserve cancellation points and close-before-cleanup ordering. Store cleanup removes only the captured token's part and rechecks current ownership before removing json/lock; an old stream completing after cancellation must not publish or discard a newer retry.

Keep completeUpload under its existing metadata gate, including target revalidation and original verification before visible associations are committed. Preserve the existing blob paths, size limits, hashes, file modes, metadata formats, error behavior and transaction recovery. Record validation remains in `record.ts` and cross-file commit/recovery in `metadata/transaction.ts`; do not combine non-persistent attachments or document parsing into the file helper. Migrate internal callers directly without compatibility re-exports.

Keep upload/file boundary regressions in `packages/verification/tests/attachments/`, including paused streams, failed producers, token-isolated cleanup, corrupted staged bytes, draft publication and real second-process ownership/recovery. Run typecheck and offline tests. Add injected-model Edge attachment checks when changing host upload interactions; extraction confined to Store file mechanics does not require repeating the browser flow. See [Attachments](ARCHITECTURE/ATTACHMENTS.md#staging-and-publication-coordination-boundaries).

## Metadata journal and transaction boundaries

Keep the MetadataCommit contract and pure journal encoding/decoding in `packages/runtime/src/metadata/journal.ts`. Reuse record codecs, preserve disk versions and cross-record validation, and pass explicit values rather than a store or current session. Internal API migration does not remove persistent-format compatibility: ordinary commits write v2, memory migrations write v3, and readers accept v1/v2/v3. Do not add a version or serialize decoded runtime projections merely to reorganize code.

MetadataTransactions in `packages/runtime/src/metadata/transaction.ts` retains the per-root queue, process lock/recovery, preflight size limits, durable decision and ordered application. Validate the complete encoded journal before publishing it; write the original encoded shape and apply the validated result. Preserve Memory-before-Session, original-before-association and catalog-before-deletion ordering, fixed session buckets, idempotent member patches, injected Session publication/removal and fallback behavior. Remove the journal only after all effects succeed. Keep journal reads outside the recovery error wrapper: read failures and decoded-decision failures retain their existing distinct errors and must block the operation.

Keep attachment catalog IO in `attachments/catalog.ts` and original/derived-file paths and cleanup in `attachments/files.ts`; callers hold the existing metadata gate. The coordinator receives only Session publication/removal callbacks through MetadataSessionAccess. AttachmentSessionAccess belongs to AttachmentStore and adds load/prepareDraft for upload coordination. Stores retain domain validation, associations and lifecycle decisions; do not create a second state owner or generic transaction registry. Keep `metadata.lock`, `attachments/pending.json`, all record locations and existing error codes/messages unchanged.

Keep bounded JSON reads and atomic JSON writes in `packages/runtime/src/metadata/files.ts`, with explicit paths and byte limits. Preserve strict UTF-8, optional-missing-only reads, file modes, sync/close/rename ordering and temporary-file cleanup. File helpers do not acquire locks, choose transaction targets, decide recovery, or grant attachment/document access. Attachment staging and document caches import them directly; do not re-export them from the coordinator or create a general storage framework across unrelated stores.

Keep journal/file regressions in `packages/verification/tests/metadata/`; retain project member/deletion and memory migration recovery scenarios with those capabilities. Run typecheck and offline tests covering legacy formats, invalid/conflicting decisions before publication, partial commit recovery, real second-process ownership, error boundaries and failed file publication. Add browser/terminal checks when host interactions change. See [Metadata](ARCHITECTURE/METADATA.md) for the maintained protocol.

## Memory file and storage boundaries

Keep scope-file reads, atomic publication and bounded lock-owner reads in `packages/runtime/src/memory/files.ts`, using explicit memory directories, scopes, records, lock paths and cancellation signals. Reuse `record.ts` for scope keys and record validation. Helpers own only their file handles; they do not receive MemoryStore, create the storage root, acquire locks, resolve session identity or cache authorization. Import file limits and functions from this module directly, without forwarding exports from Store.

MemoryStore retains its per-instance in-memory records and queue, directory creation, process lock/recovery, record and revision limits, mutation rules, migration fingerprints and conflict decisions. Keep persistent operations inside their existing locks. In-memory mode must remain isolated, clone caller-owned data and avoid disk access. Session identity/attempt-owner authorization, turn budgets and call-ID reuse remain with the existing Session modules.

Preserve the v1 scope envelope, file names, 64 MiB limit, symbolic-link rejection on scope reads, strict UTF-8 and missing-versus-corrupt behavior. Keep cancellation checks during reads and before rename, file modes, sync/close/rename order, temporary-file cleanup and the existing MEMORY_IO/MEMORY_LIMIT/CANCELLED behavior. Lock-owner parsing must propagate cancellation without turning it into an absent owner; only the coordinator decides whether an owner is stale. Do not replace these functions with attachment JSON helpers that have different cancellation, link and error contracts.

Migration still validates source fingerprints and destination capacity/conflicts under the store lock, publishes the project scope before clearing the private scope, and deduplicates already-published records on replay. Cross-owner recovery remains with MetadataTransactions; moving file code does not create a new transaction or permission boundary. See [Memory](ARCHITECTURE/MEMORY.md#scope-file-and-storage-coordination-boundaries) for ownership and [Metadata](ARCHITECTURE/METADATA.md) for the journal protocol.

Keep regressions in `packages/verification/tests/memory/`, covering opened-read cancellation, cancellation after sync but before publication, failed publication cleanup, interrupted migration replay, corrupt scope files, in-memory isolation and cross-process locks. Use temporary stores and deterministic failure/cancellation injection. Run typecheck and offline tests; browser/terminal checks are needed when host interactions change.

## Project file and storage boundaries

Keep bounded project-record reads, atomic creation publication and lock-owner reads in `packages/runtime/src/project/files.ts`. Pass an explicit project metadata directory, ID, record or lock path, and reuse `record.ts` validation. Preserve Project v1, file names, the 64 KiB limit, strict UTF-8/JSON checks, file modes, sync/close/rename and temporary-file cleanup. Helpers own their handles, not locks, directory creation, workspace resolution or session state. Do not add compatibility re-exports or a general storage framework.

ProjectStore retains name/workspace validation, storage directory creation, list entry limits/filtering/sorting, revision checks, the metadata gate and project lock/recovery. Listing skips only PROJECT_CORRUPT and PROJECT_NOT_FOUND records; direct reads report those errors, and storage failures must not become empty or partial success. Keep absent-store reads free of directory creation. Loading a saved project must not require its workspace to exist; creation validates the directory, while Session determines current workspace availability without fallback.

Keep metadata gate → project lock → session bucket lock ordering. The loadUnlocked and withProjectUnlocked operations have real callers that already hold the metadata gate; retain their explicit preconditions rather than reacquiring the gate or bypassing the owning store. Reading an owner PID does not decide whether a lock is stale: liveness, recovery gates and release remain in ProjectStore.

Project creation uses the project file publisher and its PROJECT_STORAGE errors. Project management changes continue through MetadataTransactions and its durable journal, application order and recovery errors. Do not route one through the other merely to share file code or silently change failure behavior. See [Projects](ARCHITECTURE/PROJECTS.md#project-file-and-storage-coordination-boundaries) and the [metadata recovery protocol](ARCHITECTURE/METADATA.md).

Keep regressions in `packages/verification/tests/projects/`, covering strict reads versus listing, malformed/oversized records, failed publication and cleanup, revision conflicts, live/incomplete/dead lock owners, and existing cross-process management recovery and Session project projection. Run typecheck and offline tests; add browser/terminal checks when host interactions change.

## Web UI controller boundaries

Keep shared display contracts in `packages/webui/src/types.ts` and stateless history/event conversion in `packages/webui/src/turns.ts`. Import types from their owner, without forwarding exports from Controller. Display helpers receive explicit history or events and return presentation data; they must not hold a Controller, SessionManager, operation lock or second transcript owner. Continue using existing attachment evidence; context usage comes directly from the runtime ContextUsageSnapshot, without a client-owned observation accumulator.

Controller owns active/changing operations, transcript, revisions, approval coordination and shutdown. Keep execution dispatch in a private method and install active state before invoking any operation that can emit events or request approval. Preserve manual-command versus automated-prompt routing, background visibility, main-request observation identity, evidence eligibility, display limits and cleanup order. Final list and read-only context refresh remain inside the active lifetime; do not release the host lock early. Preview failures must still settle the host operation.

Use explicit restore/preserve intent for management operations. Runtime owns usage restore/reset semantics: model changes and compaction preserve cumulative consumption and historical observations; new sessions/forks have their own accounting. Refresh current estimates after lifecycle changes rather than clearing history in the client. Keep attachment revisions at their existing operation boundaries. Preserve success/failure refresh order and partial committed effects. A failed management operation may refresh metadata for a new confirmation, but must not automatically replay the change or replace the displayed conversation as part of error recovery. Keep public-entry regressions in `packages/verification/tests/webui/`, including synchronous approval, cancellation, refresh failures, background tasks and restored evidence. See [Web UI](ARCHITECTURE/WEBUI.md) for the maintained behavior.

## Web UI browser view boundaries

Keep the authoritative page snapshot, ETag, connection/sending state, draft and request/polling lifecycle in `packages/webui/src/client/app.ts`. The entry coordinates menus, dialogs, approvals, scrolling and preview reset. `TranscriptView` in `client/transcript.ts` owns only rendered turn nodes and signatures; `SessionListView` in `client/session-list.ts` owns only list nodes, its signature, per-project collapse display preferences (browser local storage with an in-memory fallback) and display formatting. `ComposerMotion` owns only idle presentation and its timer, with enablement and focus callbacks from the entry; it never submits or modifies the draft. `SettingsPanel` owns its modal/focus behavior and browser-only theme preference; current-session actions remain callbacks into the entry. Pass rendering data explicitly and expose concrete action callbacks; do not add a second application store or let views call the API. Import `displaySessions` from its list owner wherever menus or details need the same projection.

Preserve DOM reuse, expanded details, captured source Session IDs, preview path filtering, list grouping and keyboard/drag behavior when moving rendering code. Consult live management availability at event time, and resolve dropped Session IDs against the entry's current snapshot. Apply button disabled states even when rendering is skipped by a matching signature. Keep request completion, draft clearing, old-revision rejection, scrolling and focus ordering unchanged.

Register new browser runtime modules in the explicit `packages/webui/src/server.ts` asset whitelist and extend HTTP asset checks in `packages/verification/tests/webui/`; compilation alone does not make an ES module URL available. Use the existing injected-model Edge runners for DOM, focus and interaction checks, with local helper probes under `packages/verification/verify/browser/support/`. The `verify:webui` runner checks view caching, expanded sections, source identity and live drag gating; use Project and document/attachment runners for affected cross-component flows. These runs do not validate real provider behavior or the native folder dialog. See [Web UI](ARCHITECTURE/WEBUI.md) for the maintained ownership and behavior.

`verify:webui` also checks metadata search, polling/draft preservation and project collapse restoration; pointer/keyboard preview resizing, limits, drag cancellation, reload persistence and overlay transitions; and CommonMark/GFM structures, literal code, attachment references, heading focus, rejected unsafe links and inert source HTML. Screenshot probes cover Markdown tables and nested content in both themes at desktop and 320px widths. The pinned Marked ESM and license are copied from Web UI's direct dependency at build time; the browser import must remain client-local and explicitly whitelisted. No CDN or browser Node resolution is used.

ModelControls owns modal DOM, render signatures and the temporary selection captured when a form opens. app.ts supplies the current snapshot on opening, sends requests and preserves drafts across model changes. The server compares Session ID, revision and previous model identity (including revision-zero drafts) before setModel. Use `verify:webui-models` for switching, discrete effort, unknown/estimated/reported context states and lifecycle refresh; do not replace runtime estimates with browser calculations or weaken assertions to accommodate races.

## TUI turn and presentation boundaries

`packages/tui/src/app.ts` owns the active operation, cancellation controller, approval coordinator, editor draft, display state, evidence deduplication and terminal lifecycle. Install operation state before calling anything that can synchronously emit events or request approval. Share common initialization in private methods; start conversation telemetry and clear display deduplication only for normal/automatic turns. Explicit compaction begins its own telemetry without adding a conversation turn. Keep command errors, failed-turn exit status, background-target counter restoration and each path's final refresh/cleanup order distinct.

`packages/tui/src/presentation.ts` receives explicit events or approval requests and returns display data/text. Do not give it an App, Session, editor, execution journal or mutable cache. Observe every event in telemetry before deciding whether to display it; App deduplicates writes by ID plus record fingerprint and commands by ID across parent/child events. Updated writes and evidence warnings must remain visible. Keep message ordering, scrolling and render requests in App, terminal sanitization/layout in view, and usage accounting in telemetry/metrics. Do not create another transcript or permission owner.

Preserve fresh approval input, draft restoration, cancellation followed by another turn, and exit waiting for work before draining input and restoring the terminal. Keep TUI regressions in `packages/verification/tests/tui/`. For input/lifecycle changes, also run the injected-model Windows terminal fixture described below; fake-terminal tests alone do not establish native terminal behavior. See [TUI](ARCHITECTURE/TUI.md) for the maintained runtime contracts.

## Test and verification layout

Keep product offline tests outside production code, grouped by the contract they verify. Eval maintains its own package tests as described below. Use `*.test.ts` for test entry points and descriptive filenames for helpers.

Use `describe` and `it` from `node:test` to group related cases in new or substantially revised test files. A small standalone check may continue using `test`; `it` is the same test API, and suites add organization rather than stronger assertions. Keep setup and cleanup local to each case unless sharing is intentional, preserve serial/concurrent execution settings, and avoid deeply nested suites. Do not rename existing tests across the repository solely for style or add another test framework for this syntax.

The current responsibility groups are:

| Directory under `packages/verification/tests/` | Responsibility |
| --- | --- |
| `agent/` | Agent assembly, Loop, delegation and execution reports |
| `model/` | Model transports, providers and configuration |
| `context/` | Request projection, compaction and request budgets |
| `session/` | Session history, persistence, lifecycle, drafts and workspace selection |
| `metadata/` | Cross-domain journal, recovery and shared JSON file contracts |
| `projects/`, `attachments/`, `documents/`, `memory/`, `automation/` | Each capability's contracts and lifecycle integration |
| `tools/` | General tool contracts; `files/`, `shell/`, `web/` and `browser/` hold capability-specific checks |
| `permissions/` | Permission policies, command risk, approval enforcement and file/network scope |
| `skills/` | Skill discovery, loading, built-in resources and integration |
| `cli/`, `tui/`, `webui/` | Entry-specific input, presentation, transport and interaction contracts |
| `workflows/` | Complete task scenarios spanning capabilities, such as the coding workflow |
| `harness/` | Tests of verification infrastructure, such as test discovery, temporary workspace cleanup and live configuration guards |

Cross-module imports do not make a test a workflow test. Assign it to the primary contract: write facts surviving failed turns belong in `tools/files/`; Memory scope across sessions belongs in `memory/`; document auxiliary request budgets belong in `documents/`. HTTP authentication and project confirmation handling belong in `webui/`, while project migration semantics belong in `projects/`. Keep domain integration tests beside the corresponding capability tests instead of introducing a catch-all integration directory. A mixed existing file can stay with its primary owner; split it only when the behaviors justify separate maintenance.

Keep helpers used by one domain in that domain's `support/` directory. Put shared setup, injected transports, cleanup and assertions in `packages/verification/tests/support/`, and sample data or sample generators in `packages/verification/tests/fixtures/`. For example, `packages/verification/tests/support/workspace.ts` owns temporary workspaces, `packages/verification/tests/support/coding-workflow.ts` shares workflow setup and assertions with live verification, and `packages/verification/tests/fixtures/document-fixtures.ts` supplies document samples to offline and browser checks. Child-process entry points and transport preloads are executable support files: load them explicitly, never through a shared import barrel. Keep their names distinct from `*.test.ts` so discovery does not execute them as tests. Production code must not depend on tests or verification helpers.

Specialized runners stay outside ordinary test discovery:

| Directory | Execution requirements |
| --- | --- |
| `packages/verification/verify/browser/` | Installed Edge, temporary local pages and injected model decisions |
| `packages/verification/verify/native/` | Interactive Windows desktop; native probe in `native/support/` |
| `packages/verification/verify/network/` | Public network access, without model requests |
| `packages/verification/verify/live/` | Explicit authorization for real DeepSeek requests and API usage |
| `packages/verification/verify/support/` | Shared specialized-runner support, including the live configuration guard |

Verification runners may reuse `packages/verification/tests/support/` and `packages/verification/tests/fixtures/`; ordinary shared helpers must not start verification or load credentials on import. Transport preloads are explicit executable entry points, as described above. `scripts/start.ts` is the root start adapter; package resource-copy scripts remain build scripts, including `packages/verification/scripts/copy-resources.mjs` for the native probe. `packages/verification/scripts/test.ts` launches the offline suite. Command names are maintained in [package.json](../../package.json); use the `verify:*` commands below instead of depending on compiled runner locations.

`pnpm test` builds first, then `packages/verification/scripts/test.ts` discovers `packages/verification/tests/**/*.test.ts` and passes only their corresponding compiled files to Node's test runner. Obsolete outputs from moves or branch switches cannot add tests to this list. An empty source list or any missing compiled test fails before execution; test failures remain nonzero exits. The verification TypeScript configuration includes nested tests, runners and the offline launcher. Package-local test execution expects the product packages to have been built; use root `pnpm test` for the complete sequence.

To run a focused group after building and removing obsolete outputs in that group, use the following quoted globs for native Windows shells. These direct Node commands scan compiled files and bypass the source-based selection used by `pnpm test`:

```powershell
pnpm exec node --test "packages/verification/dist/tests/session/*.test.js"
pnpm exec node --test "packages/verification/dist/tests/tools/**/*.test.js"
```

When moving or deleting tests, update static imports, `import.meta.url` paths, child-process/preload paths, source assets referenced from compiled files, package commands and documentation. TypeScript does not remove obsolete outputs: remove only the corresponding generated `.js` and `.js.map` files under the owning package's `dist/` (or the former build location during migration), then verify that every source test has exactly one compiled counterpart and no orphan compiled tests remain. Preserve test names, assertions, fixture data, timeouts and environment gates during a layout-only change. Offline tests may use local HTTP servers and native PowerShell; they still must not load `.env`, launch Edge or contact real model providers.

Eval package tests are the exception to the centralized product-test layout: keep protocol, result, summary and eval integration checks under `packages/eval/tests/`, and synthetic builders under its `tests/fixtures/`. Run `pnpm --filter @fatcat/eval test` after the root build for a focused offline check. This does not execute a benchmark or validate model quality. Root `pnpm test` includes this suite and the existing verification suite; the existing live/browser/native commands retain their scopes and provider guards.

## Windows terminal checks

Run `pnpm run verify:cli` in an interactive, VT-capable Windows terminal to check CLI startup and input handoff. `TERM=dumb` is deliberately rejected. If a ConPTY host supports VT but incorrectly inherits `TERM=dumb`, set `$env:TERM = 'xterm-256color'` in that verification shell; do not relax the production TUI guard. The runner uses a temporary session store/workspace, fake credentials and an intercepted model transport, without loading `.env` or contacting a provider. Follow its three phases:

1. Select `native-cli`, submit `approval`, answer the fresh write approval with `yes`, wait for `CLI APPROVAL VERIFIED`, then submit `/exit`.
2. At the next resume picker, enter `/exit`. This must leave the model request count unchanged.
3. Select `native-cli` again to enter TUI. Submit `cancel`, wait for the active request and press Esc. After cancellation settles, submit `continue`, wait for `CLI TUI HANDOFF VERIFIED`, then press Ctrl+D.

The runner asserts exit statuses, the actual approved file, the exact model prompt sequence, persisted history without approval answers/cancelled input, and raw-mode/SIGINT-listener restoration between hosts. A successful run prints `passed: true` and removes the temporary directory. This exercises the real launcher, readline, TUI and model SDK with an injected response transport; it does not exercise native browser-opening handoff, full IME behavior or real model quality. Subprocess offline tests separately cover the executable CLI and Web UI startup through pipes.

Run `pnpm run verify:tui` in a native Windows interactive terminal (ConPTY is supported), with stdin/stdout attached to that terminal. This builds and launches `packages/verification/verify/native/verify-tui.ts` with an injected model and real ProcessTerminal. It uses a temporary workspace, does not load `.env` or contact providers, and removes its fixture directory on exit. Ordinary `pnpm test` does not launch this interactive check.

Use the following sequence, waiting for each result before proceeding:

1. Submit `/skills unexpected`; check that the usage error leaves the input usable.
2. Submit `approval` and immediately type `draft after approval` without Enter. The fixture waits 1.5 seconds before requesting write approval. Check that the pending draft disappears from the approval editor.
3. Press Enter with empty approval input; it must still require yes/no. Submit `yes`, wait for `APPROVED FILE SAVED`, and check that the draft reappears. Press Enter to submit that restored draft and wait for `DRAFT RESTORED`.
4. Submit `/compact` and wait for the context summary result.
5. Submit `cancel`, wait for active work, press Esc, and wait for the cancellation result. Submit `continue` and wait for `CONTINUED AFTER CANCELLATION`.
6. Press PgUp/PgDn and check scrolling, then Ctrl+D. Check normal terminal/cursor restoration and the final JSON with `passed: true`.

The fixture asserts the real approved file, exact model prompt sequence, cancelled-turn history isolation, summary/conversation counts, raw mode and SIGINT listener restoration. Interactive display/scroll checks complement these assertions; this does not validate full IME behavior or real model quality. Stopping early fails the fixture's acceptance assertions.

## Public network and local browser checks

These scripts do not call model APIs or require model credentials. Browser scripts require installed Microsoft Edge; they use temporary fixtures and injected model decisions. Ordinary `pnpm test` does not run them.

| Command | Coverage / additional requirement |
| --- | --- |
| `pnpm run verify:web` | Five fixed public search, page and weather checks; requires network access |
| `pnpm run verify:browser` | Controlled browser execution and evidence on temporary local pages |
| `pnpm run verify:webui` | Responsive UI, centered settings/modal dismissal and focus, current draft details and inset keyboard scrolling, compact turn evidence, theme persistence, connection recovery, single-row composer controls, idle collapse and pointer/focus/draft protection, keyboard wake, home/busy exclusions and reduced motion, long drafts/short windows, composer alignment and resizing, split/overlay previews with native modal background isolation and keyboard return from the frame, code/answer clipboard contents and denied-access retry, back-to-bottom navigation, keyboard navigation, dialogs, approvals, cancellation and Cron controls |
| `pnpm run verify:sessions` | Saved sessions, workspace switching, stable layout/drafts during delayed selection, owner identity and cancellation/error recovery with an injected picker |
| `pnpm run verify:webui-models` | Rounded available-model list and keyboard navigation, medium default and saved off preservation, mandatory thinking, protocol aliases, errors and busy conflicts, draft preservation, compact context summary and runtime usage/estimate separation, tool/answer/compaction refresh, model identity and unknowns, reload/resume, unclipped focus, rounded hover, icon alignment and responsive light/dark layout |
| `pnpm run verify:projects` | Project grouping/collapse and compact spacing, collapse restoration after browser/server restart and storage-unavailable fallback, focused form label clearance, fixed workspace and confirmed migration, including stale/cancelled previews |
| `pnpm run verify:project-management` | Project rename, directory change and deletion |
| `pnpm run verify:folder-picker` | Real native Windows directory picker owned by Edge; requires Edge and an interactive desktop. Checks modal ownership, stacking, DPI, browser recovery and helper/host exit after selection, cancellation, abort, timeout, tab/browser closure, normal shutdown and forced exit of an isolated fixture server |
| `pnpm run verify:attachments` | Attachment upload, sharing, source display and lifecycle |
| `pnpm run verify:documents` | Local document parsing, source evidence and injected visual-model integration |
| `pnpm run verify:memory` | Scoped Memory interaction and management with injected model decisions |

To retain `verify:webui` or `verify:webui-models` screenshots, set `$env:FATCAT_VERIFY_SCREENSHOTS = 'D:\tmp\fatcat-review'` before running. The native picker verifier instead accepts an optional output image path, for example `pnpm run verify:folder-picker D:\tmp\picker.png`. Injected directory choices do not validate a real native dialog; injected vision responses do not validate real image understanding. Report which environments and paths were actually exercised.

## Explicit live model checks

These optional commands are outside the [current zero-API-spend evaluation strategy](ARCHITECTURE/EVAL.md#current-evaluation-strategy). Do not use them as a substitute for the paused Harbor live runs or as a routine review gate; they still require their own explicit request and spending authorization.

Run these only when real model verification is explicitly requested. They load the local env file, use a real DeepSeek key and consume API credits. Do not silently redirect them to another provider. Bounds include possible child requests; scripts report failed expectations rather than retrying until success.

| Command | Fixture and acceptance scope | Maximum requests |
| --- | --- | --- |
| `pnpm run verify:live` | Direct answer, sum, contextual follow-up, paginated sample reads, delegation and temporary create/read/edit/read | 29 |
| `pnpm run verify:delegation` | Temporary read-only reviews with isolated child context; unchanged files and no shell/write operations | 20 |
| `pnpm run verify:coding` | Temporary search/read/edit task and narrowly authorized fixed test; independent rerun and execution/usage checks | 14 |
| `pnpm run verify:workflow` | Two-turn multi-file pricing/receipt fixture; per-turn reports, protected files and independent checks | 28 |
| `pnpm run verify:context` | Three-turn read-only fixture with changed content and a 26000-byte request budget; omission and fresh rereading | 27 |
| `pnpm run verify:memory:live` | Explicit remembering, project sharing, restart and scope isolation in temporary data | 16 |

The coding checks authorize only designated source edits and a fixed test command. Workflow checks require failed and final successful verification within each turn, but do not separately assert that failure preceded the first edit. Delegation checks do not mechanically prove every review claim. Context checks are small behavioral fixtures, not token-cost or general success-rate benchmarks. Ordinary execution reports still use `taskVerification: not_assessed`.

Temporary fixtures are separate from the user's project; existing basic live reads also use synthetic `examples/workspace` samples. Cleanup does not undo provider usage. The exact live runners are in `packages/verification/verify/live/`; shared workflow fixtures and assertions are in `packages/verification/tests/support/coding-workflow.ts`.

## Verification evidence

This page describes how to run checks, not a record of checks that have passed. A script's existence, written code or a historical passing result does not validate the current change.

At handoff, report the branch, checks actually run, outcomes, failures/blockers and remaining limits. Distinguish offline contracts, real browser/terminal behavior, public-network checks and real model requests. Keep material behavior and validation limits in the corresponding tracked architecture topic so a fresh clone can be understood independently. Detailed task history belongs in Git/PRs and local handoff notes, not duplicated acceptance claims across manuals.

## Evaluation evidence requirements

The [current evaluation strategy](ARCHITECTURE/EVAL.md#current-evaluation-strategy) prioritizes harness reliability with no real model requests or model API spending. Real-model Harbor/Terminal-Bench runs are paused; the adapter, official scoring path and historical evidence remain available for future funded use. Choose the affected offline/injected checks below. Missing live-quality evidence is an explicit limit, not a reason to spend or block a change that makes no quality claim.

Use the versioned [eval protocol](ARCHITECTURE/EVAL.md) for new experiment records. The implementation lives in `packages/eval`, separate from product regression checks. Configuration and serialization checks use synthetic data and do not demonstrate actual Session execution or model quality. The Session/promptfoo integration tests use injected transport with real runtime tools, persistence, cancellation and cleanup. They prove these integration contracts, not model quality; see [Injected Session execution](ARCHITECTURE/EVAL.md#injected-session-execution) for commands, materials, evidence and limitations.

| Change | Required evidence |
| --- | --- |
| Eval protocol, serialization or statistics | Offline validation and synthetic hand-calculated totals; malformed inputs, missing/duplicate attempts and unknown usage/cost |
| Eval Session adapter or lifecycle | Injected-model integration, isolated workspace/session state, cancellation and cleanup; live quality remains separate |
| Long requests, truncated responses or execution limits | Deterministic request/response failure fixtures; assert terminal state, durable evidence, cancellation/child settlement and cleanup for the affected path |
| Harbor adapter, task environment or official result handling | Offline adapter/result contracts; affected local injected/Oracle controls for environment or scoring changes, with no real model requests |
| Context selection or compaction quality claim | Offline contracts plus fixed model/data/budget comparison on declared development and holdout samples; no claim of improvement from token savings alone |
| Retrieval ranking or chunking | Deterministic labeled retrieval metrics and source checks; answer correctness and citation support assessed separately |
| CLI, TUI or Web UI interaction | Existing affected native Windows terminal/Edge injected-model checks in addition to offline contracts |
| Complete coding task acceptance | Independent checks of final artifacts and protected files, with recorded verifier version; a model answer or successful tool exit alone is insufficient |

Declare scope, sample IDs, repetitions, code/model/data/prompt/policy/grader identities and budgets before running. Preserve all failures, timeouts, cancellations and infrastructure errors. Development and holdout IDs must be fixed and disjoint; holdout data is for acceptance, not iterative tuning. Missing results produce an incomplete report, never a reduced denominator or a best-attempt score. A subset is not the full public benchmark, and synthetic/injected evidence is not live quality evidence. Dirty-code experiments are diagnostic only unless a separate reproducible snapshot mechanism is supplied; v1 does not provide that mechanism. Unknown counters/prices remain `null` (display as `unknown`); partial usage is labeled as a known subtotal, not a complete total. Budget declarations do not enforce limits or authorize API spending.

The generic injected runner currently enforces its per-attempt request allowance and deadline; its token, money and whole-run limits remain declarative. The retained [DeepSeek/Harbor path](ARCHITECTURE/EVAL.md#authorized-deepseek-attempt) has a narrower shared request/CNY gate, not complete experiment-budget enforcement. Both that path and larger real-model evaluations are paused under the current strategy. Generic live orchestration, paired quality reports and scheduled/manual quality commands remain deferred. Existing DeepSeek verification commands retain their provider guards and separate authorization requirements; historical budgets do not authorize new evaluation calls.

## Version and badges

[package.json](../../package.json) is the version source of truth. The package is private and runs from a checkout; its version does not imply an npm publication or GitHub release. `pnpm start --version` needs no credentials or session. After building, `node packages/cli/dist/cli.js --version` prints just the version.

Use `0.x.y` during early development: patch for fixes, minor for new capabilities or compatibility changes. Document compatibility changes before upgrading; reserve `1.0.0` for a stable compatibility contract. Application, session and automation schema versions are independent.

README version and CI badges refer to `main`, not the local branch or working tree. Update static Node.js/pnpm badges in the root README and requirements in both documentation languages when requirements change. Repository stars and badge state do not constitute verification evidence.
