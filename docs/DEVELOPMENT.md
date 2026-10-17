# Development and verification

[Documentation](README.md) · [Repository rules](../AGENTS.md) · [Architecture](ARCHITECTURE/README.md)

## Local checks

Use Node.js 24.x and pnpm 11.21.0 on native Windows. Run commands from the repository root:

```powershell
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run build
pnpm test
```

`build` compiles TypeScript and copies built-in Skills and Web UI resources. `test`, `start` and the specialized verification scripts build first. Run build-bearing commands sequentially so they do not compete for `dist` output. Choose checks proportional to the change; a documentation-only edit normally needs link, reference and diff checks.

Ordinary tests use fake credentials and injected model transports, without loading `.env` or contacting providers. They can use real temporary files and fixed PowerShell commands. They do not launch Edge. Offline provider contract tests cannot validate credentials, connectivity, model quality or real vision behavior.

For startup and local configuration checks, use `pnpm start --help` and `pnpm start --checkConfig`. Configuration validation does not contact a model. See the [quick start](QUICK_START.md) for setup and [configuration reference](REFERENCE/CONFIGURATION.md) for environment values.

## Internal interfaces and compatibility

Internal APIs, names and import paths may change to clarify ownership. Update all production callers, tests, verification scripts and documentation in the same increment. Import helpers and types from their owning module; remove forwarding modules and re-exports retained only for historical paths. A deliberate public facade or an external consumer may justify compatibility, but record that contract and its reason rather than treating every exported symbol as permanent.

Keep user commands and output, persisted formats and recovery semantics, state ownership, permissions, cancellation and side-effect ordering stable unless the task explicitly changes them. Source compatibility and persisted-data compatibility are separate requirements.

## CLI parsing and startup boundaries

Keep `src/cli.ts` as the executable argv/exit-code entry. `src/cli/options.ts` owns the option definitions, help text, optional resume-selector normalization, implicit chat selection and argument-combination validation. Return typed parsed data without loading configuration, reading stores, opening input or registering signals. `src/cli/run.ts` owns startup orchestration and error/cleanup handling; importing either internal module must not execute argv. These are internal APIs, not compatibility re-exports. Keep the real executable entry used by the package launcher and process tests.

Preserve validation order and early returns. Syntax/combination errors precede help/version; selector-free resume through pipes lists sessions before empty-prompt, TTY or provider checks. Configuration checking and automation-file/watched-path validation retain their existing stages. Do not move all validation into parsing or eagerly load credentials for local operations. Keep permission defaults and enforcement in the existing PermissionPolicy path; argument parsing does not grant access.

The launcher owns its cancellation controller and temporary TerminalInput. Reuse picker input for chat; close it before starting TUI/Web UI so clients never compete for input. Keep signal registration, cancellation forwarding, stdout/stderr output and finally cleanup ordering unchanged. `scripts/start.ts` alone restores pnpm's invocation directory; direct CLI invocation ignores inherited `INIT_CWD`. Do not introduce a shared client-launch framework or move Session state into the launcher.

Keep parser and subprocess regressions in `tests/cli/`, including competing errors, `--` literals, optional resume values, credential-free paths and startup-directory semantics. Use the injected-model Windows terminal check below for picker/input handoff changes, in addition to typecheck and offline tests. The maintained module overview is in [Architecture](ARCHITECTURE/README.md); user syntax remains in [Commands](REFERENCE/COMMANDS.md).

## Host command boundaries

Keep host command parsing, help and response formatting with the capability they expose: `src/project/commands.ts`, `src/attachments/commands.ts`, `src/automation/commands.ts`, and the existing Context and Memory command modules. Use explicit handlers; the current command set does not need a registry or plugin framework. Session selection and workspace commands stay in `src/session/commands.ts`; shared text parsing/escaping belongs in `src/utils/command.ts`, and session labels in `src/session/labels.ts`.

`src/commands.ts` composes interactive dispatch and help, calling Project and Attachment handlers directly. `runSessionCommand` and `sessionCommandHelp` cover only session commands. Import session formatting from `src/session/labels.ts` and natural-language Cron conversion from `src/automation/commands.ts`. New handlers must leave unmatched input to the caller and preserve validation order, error codes/messages, output, cancellation forwarding and the `switched` result. Do not silently change accepted syntax while moving parsing code.

Command handlers call the existing SessionManager operations. They must not own another active record, add persistence or bypass permissions and operation locks. Temporary confirmation state belongs to the command interaction, stays bound to its manager and preview, and must retain its consumption/invalidation timing across successful and failed operations. Natural-language `/cron` conversion only prepares a model prompt; local Cron management must not call the model. See [Session](ARCHITECTURE/SESSION.md) for the maintained routing and state boundaries.

Keep command behavior tests with the owning capability; entry parsing belongs with the client. Exercise interactive dispatch and capability handlers as well as cross-domain lifecycle effects, especially confirmation invalidation after switching away and back. Reuse injected models and temporary stores, and verify that local commands do not enter model history.

## Session capability boundaries

Keep session-to-capability rules in focused modules such as `src/session/attachments.ts`, `src/session/memory.ts`, `src/session/automations.ts` and `src/session/projects.ts`. Pass explicit stores, identities, sources or snapshots; do not pass the entire SessionManager or create another owner of its active record. SessionManager retains selection, operation locks, draft persistence and runtime activation. AgentSession retains turn state, and the existing stores retain persistence and transaction boundaries. Move internal exports with their owner and migrate callers as described above.

For Memory, run the entire scoped read/change inside the existing Manager identity/owner gate, including the persistent metadata lock. Bind access to the executing session and revalidate every operation; never cache authorization or replace the captured identity with the UI's current selection. Preserve draft save ordering, cancellation, source attribution, per-turn budgets, result reuse and independent committed side effects. Keep access and lifecycle regressions in `tests/memory/`, including captured bindings and migration fingerprints with tombstones. The maintained contracts and ownership details are in [Session](ARCHITECTURE/SESSION.md) and [Memory](ARCHITECTURE/MEMORY.md).

For Automation, keep task projection, activation eligibility and deadline signal preparation in `src/session/automations.ts`, alongside schedule-change validation. Manager loads and refreshes records, checks live owners, selects the current or background target, and retains host locks and their release ordering. AgentSession alone claims and counts attempts and settles turns; the scheduler retains leases, queues and file baselines. Do not cache eligibility, move counters into helpers, switch foreground selection for a background run, or create another task store. Keep regression tests in `tests/automation/`, covering stale activations, cancellation before and after claim, target isolation and lock release. See [Automation](ARCHITECTURE/AUTOMATION.md).

For Projects, share complete join-preview assembly between preview and confirmation, but read fresh Memory and attachment state on every call. Keep Memory reads inside the existing identity/owner gate and final revision checks inside the storage transaction. Draft projection helpers only prepare records; Manager keeps operation locks, target selection, Agent preparation and activation. Preserve each operation's ordering: directory changes prepare draft transitions before commit, active-project deletion prepares its replacement first, and rename refresh failures do not undo a committed project name. Do not wrap the whole Manager in a Project service or move transaction locks into these helpers. Keep scope, stale-preview, draft and failure regressions in `tests/projects/`; the maintained contract is in [Projects](ARCHITECTURE/PROJECTS.md#session-接入边界).

## Web UI controller boundaries

Keep shared display contracts in `webui/types.ts` and stateless history/event conversion in `webui/turns.ts`. Import types from their owner, without forwarding exports from Controller. Display helpers receive explicit history or events and return presentation data; they must not hold a Controller, SessionManager, operation lock or second transcript owner. Continue using the existing attachment evidence and context usage modules.

Controller owns active/changing operations, transcript, revisions, approval coordination and shutdown. Keep execution dispatch in a private method and install active state before invoking any operation that can emit events or request approval. Preserve manual-command versus automated-prompt routing, background visibility, parent-only context usage, evidence eligibility, display limits and cleanup order. Final list refresh remains inside the active lifetime; do not release the host lock early.

Use explicit restore/preserve intent for management operations. Combine transcript restoration and usage reset only where both already occur together; keep project-specific usage resets and attachment revisions at their existing operation boundaries. Preserve success/failure refresh order and partial committed effects. A failed management operation may refresh metadata for a new confirmation, but must not automatically replay the change or replace the displayed conversation as part of error recovery. Keep public-entry regressions in `tests/webui/`, including synchronous approval, cancellation, refresh failures, background tasks and restored evidence. See [Web UI](ARCHITECTURE/WEBUI.md) for the maintained behavior.

## Web UI browser view boundaries

Keep the authoritative page snapshot, ETag, connection/sending state, draft and request/polling lifecycle in `webui/client/app.ts`. The entry coordinates menus, dialogs, approvals, scrolling and preview reset. `TranscriptView` in `client/transcript.ts` owns only rendered turn nodes and signatures; `SessionListView` in `client/session-list.ts` owns only list nodes, its signature and display formatting. Pass rendering data explicitly and expose concrete action callbacks; do not add a second application store or let views call the API. Import `displaySessions` from its list owner wherever menus or details need the same projection.

Preserve DOM reuse, expanded details, captured source Session IDs, preview path filtering, list grouping and keyboard/drag behavior when moving rendering code. Consult live management availability at event time, and resolve dropped Session IDs against the entry's current snapshot. Apply button disabled states even when rendering is skipped by a matching signature. Keep request completion, draft clearing, old-revision rejection, scrolling and focus ordering unchanged.

Register new browser runtime modules in the explicit `webui/server.ts` asset whitelist and extend HTTP asset checks in `tests/webui/`; compilation alone does not make an ES module URL available. Use the existing injected-model Edge runners for DOM, focus and interaction checks, with local helper probes under `scripts/verify/browser/support/`. The `verify:webui` runner checks view caching, expanded sections, source identity and live drag gating; use Project and document/attachment runners for affected cross-component flows. These runs do not validate real provider behavior or the native folder dialog. See [Web UI](ARCHITECTURE/WEBUI.md) for the maintained ownership and behavior.

## TUI turn and presentation boundaries

`tui/app.ts` owns the active operation, cancellation controller, approval coordinator, editor draft, display state, evidence deduplication and terminal lifecycle. Install operation state before calling anything that can synchronously emit events or request approval. Share common initialization in private methods; start conversation telemetry and clear display deduplication only for normal/automatic turns. Explicit compaction begins its own telemetry without adding a conversation turn. Keep command errors, failed-turn exit status, background-target counter restoration and each path's final refresh/cleanup order distinct.

`tui/presentation.ts` receives explicit events or approval requests and returns display data/text. Do not give it an App, Session, editor, execution journal or mutable cache. Observe every event in telemetry before deciding whether to display it; App deduplicates writes by ID plus record fingerprint and commands by ID across parent/child events. Updated writes and evidence warnings must remain visible. Keep message ordering, scrolling and render requests in App, terminal sanitization/layout in view, and usage accounting in telemetry/metrics. Do not create another transcript or permission owner.

Preserve fresh approval input, draft restoration, cancellation followed by another turn, and exit waiting for work before draining input and restoring the terminal. Keep TUI regressions in `tests/tui/`. For input/lifecycle changes, also run the injected-model Windows terminal fixture described below; fake-terminal tests alone do not establish native terminal behavior. See [TUI](ARCHITECTURE/TUI.md) for the maintained runtime contracts.

## Test and verification layout

Keep offline tests outside production code, grouped by the contract they verify. Use `*.test.ts` for test entry points and descriptive filenames for helpers.

Use `describe` and `it` from `node:test` to group related cases in new or substantially revised test files. A small standalone check may continue using `test`; `it` is the same test API, and suites add organization rather than stronger assertions. Keep setup and cleanup local to each case unless sharing is intentional, preserve serial/concurrent execution settings, and avoid deeply nested suites. Do not rename existing tests across the repository solely for style or add another test framework for this syntax.

The current responsibility groups are:

| Directory under `tests/` | Responsibility |
| --- | --- |
| `agent/` | Agent assembly, Loop, delegation and execution reports |
| `model/` | Model transports, providers and configuration |
| `context/` | Request projection, compaction and request budgets |
| `session/` | Session history, persistence, lifecycle, drafts and workspace selection |
| `projects/`, `attachments/`, `documents/`, `memory/`, `automation/` | Each capability's contracts and lifecycle integration |
| `tools/` | General tool contracts; `files/`, `shell/`, `web/` and `browser/` hold capability-specific checks |
| `permissions/` | Permission policies, command risk, approval enforcement and file/network scope |
| `skills/` | Skill discovery, loading, built-in resources and integration |
| `cli/`, `tui/`, `webui/` | Entry-specific input, presentation, transport and interaction contracts |
| `workflows/` | Complete task scenarios spanning capabilities, such as the coding workflow |
| `harness/` | Tests of verification infrastructure, such as test discovery, temporary workspace cleanup and live configuration guards |

Cross-module imports do not make a test a workflow test. Assign it to the primary contract: write facts surviving failed turns belong in `tools/files/`; Memory scope across sessions belongs in `memory/`; document auxiliary request budgets belong in `documents/`. HTTP authentication and project confirmation handling belong in `webui/`, while project migration semantics belong in `projects/`. Keep domain integration tests beside the corresponding capability tests instead of introducing a catch-all integration directory. A mixed existing file can stay with its primary owner; split it only when the behaviors justify separate maintenance.

Keep helpers used by one domain in that domain's `support/` directory. Put shared setup, injected transports, cleanup and assertions in `tests/support/`, and sample data or sample generators in `tests/fixtures/`. For example, `tests/support/workspace.ts` owns temporary workspaces, `tests/support/coding-workflow.ts` shares workflow setup and assertions with live verification, and `tests/fixtures/document-fixtures.ts` supplies document samples to offline and browser checks. Child-process entry points and transport preloads are executable support files: load them explicitly, never through a shared import barrel. Keep their names distinct from `*.test.ts` so discovery does not execute them as tests. Production code must not depend on tests or verification helpers.

Specialized runners stay outside ordinary test discovery:

| Directory | Execution requirements |
| --- | --- |
| `scripts/verify/browser/` | Installed Edge, temporary local pages and injected model decisions |
| `scripts/verify/native/` | Interactive Windows desktop; native probe in `native/support/` |
| `scripts/verify/network/` | Public network access, without model requests |
| `scripts/verify/live/` | Explicit authorization for real DeepSeek requests and API usage |
| `scripts/verify/support/` | Shared specialized-runner support, including the live configuration guard |

Verification runners may reuse `tests/support/` and `tests/fixtures/`; ordinary shared helpers must not start verification or load credentials on import. Transport preloads are explicit executable entry points, as described above. `scripts/start.ts`, `scripts/copy-skills.ts` and `scripts/copy-webui.ts` remain startup/build scripts; `scripts/test.ts` launches the offline suite. Command names are maintained in [package.json](../package.json); use the `verify:*` commands below instead of depending on compiled runner locations.

`pnpm test` builds first, then `scripts/test.ts` discovers `tests/**/*.test.ts` and passes only their corresponding compiled files to Node's test runner. Obsolete outputs from moves or branch switches cannot add tests to this list. An empty source list or any missing compiled test fails before execution; test failures remain nonzero exits. The existing TypeScript configuration already includes nested tests and scripts.

To run a focused group after building and removing obsolete outputs in that group, use the following quoted globs for native Windows shells. These direct Node commands scan compiled files and bypass the source-based selection used by `pnpm test`:

```powershell
pnpm exec node --test "dist/tests/session/*.test.js"
pnpm exec node --test "dist/tests/tools/**/*.test.js"
```

When moving or deleting tests, update static imports, `import.meta.url` paths, child-process/preload paths, source assets referenced from compiled files, package commands and documentation. TypeScript does not remove obsolete outputs: remove only the corresponding generated `.js` and `.js.map` files under the repository's `dist/`, then verify that every source test has exactly one compiled counterpart and no orphan compiled tests remain. Preserve test names, assertions, fixture data, timeouts and environment gates during a layout-only change. Offline tests may use local HTTP servers and native PowerShell; they still must not load `.env`, launch Edge or contact real model providers.

## Windows terminal checks

Run `pnpm run verify:cli` in an interactive, VT-capable Windows terminal to check CLI startup and input handoff. `TERM=dumb` is deliberately rejected. If a ConPTY host supports VT but incorrectly inherits `TERM=dumb`, set `$env:TERM = 'xterm-256color'` in that verification shell; do not relax the production TUI guard. The runner uses a temporary session store/workspace, fake credentials and an intercepted model transport, without loading `.env` or contacting a provider. Follow its three phases:

1. Select `native-cli`, submit `approval`, answer the fresh write approval with `yes`, wait for `CLI APPROVAL VERIFIED`, then submit `/exit`.
2. At the next resume picker, enter `/exit`. This must leave the model request count unchanged.
3. Select `native-cli` again to enter TUI. Submit `cancel`, wait for the active request and press Esc. After cancellation settles, submit `continue`, wait for `CLI TUI HANDOFF VERIFIED`, then press Ctrl+D.

The runner asserts exit statuses, the actual approved file, the exact model prompt sequence, persisted history without approval answers/cancelled input, and raw-mode/SIGINT-listener restoration between hosts. A successful run prints `passed: true` and removes the temporary directory. This exercises the real launcher, readline, TUI and model SDK with an injected response transport; it does not exercise native browser-opening handoff, full IME behavior or real model quality. Subprocess offline tests separately cover the executable CLI and Web UI startup through pipes.

Run `pnpm run verify:tui` in a native Windows interactive terminal (ConPTY is supported), with stdin/stdout attached to that terminal. This builds and launches `scripts/verify/native/verify-tui.ts` with an injected model and real ProcessTerminal. It uses a temporary workspace, does not load `.env` or contact providers, and removes its fixture directory on exit. Ordinary `pnpm test` does not launch this interactive check.

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
| `pnpm run verify:webui` | Responsive UI, themes, keyboard navigation, dialogs, approvals, cancellation, preview and Cron controls |
| `pnpm run verify:sessions` | Saved sessions and workspace switching |
| `pnpm run verify:projects` | Project grouping, fixed workspace and confirmed migration, including stale/cancelled previews |
| `pnpm run verify:project-management` | Project rename, directory change and deletion |
| `pnpm run verify:folder-picker` | Real native Windows directory picker; requires an interactive desktop, with selection/cancellation driven by the verification helper |
| `pnpm run verify:attachments` | Attachment upload, sharing, source display and lifecycle |
| `pnpm run verify:documents` | Local document parsing, source evidence and injected visual-model integration |
| `pnpm run verify:memory` | Scoped Memory interaction and management with injected model decisions |

To retain `verify:webui` screenshots, set `$env:FATCAT_VERIFY_SCREENSHOTS = 'D:\tmp\fatcat-review'` before running. The native picker verifier instead accepts an optional output image path, for example `pnpm run verify:folder-picker D:\tmp\picker.png`. Injected directory choices do not validate a real native dialog; injected vision responses do not validate real image understanding. Report which environments and paths were actually exercised.

## Explicit live model checks

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

Temporary fixtures are separate from the user's project; existing basic live reads also use synthetic `examples/workspace` samples. Cleanup does not undo provider usage. The exact live runners are in `scripts/verify/live/`; shared workflow fixtures and assertions are in `tests/support/coding-workflow.ts`.

## Verification evidence

This page describes how to run checks, not a record of checks that have passed. A script's existence, written code or a historical passing result does not validate the current change.

At handoff, report the branch, checks actually run, outcomes, failures/blockers and remaining limits. Distinguish offline contracts, real browser/terminal behavior, public-network checks and real model requests. Keep material behavior and validation limits in the corresponding tracked architecture topic so a fresh clone can be understood independently. Detailed task history belongs in Git/PRs and local handoff notes, not duplicated acceptance claims across manuals.

## Version and badges

[package.json](../package.json) is the version source of truth. The package is private and runs from a checkout; its version does not imply an npm publication or GitHub release. `pnpm start --version` needs no credentials or session. After building, `node dist/src/cli.js --version` prints just the version.

Use `0.x.y` during early development: patch for fixes, minor for new capabilities or compatibility changes. Document compatibility changes before upgrading; reserve `1.0.0` for a stable compatibility contract. Application, session and automation schema versions are independent.

README version and CI badges refer to `main`, not the local branch or working tree. Update static Node.js/pnpm badges in both READMEs when requirements change. Repository stars and badge state do not constitute verification evidence.
