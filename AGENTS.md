# Working on Fatcat

Fatcat is an independent TypeScript Agent Harness for native Windows coding tasks. CLI, TUI, and Web UI share Session, Loop, model, tools, and permissions; keep execution policy and persistent state out of the clients.

## Task-specific guidance

Read [project goals and boundaries](docs/PROJECT.md), then the documents relevant to the task. Use the [documentation index](docs/README.md) for navigation; do not load every document by default.

| When working on | Read |
| --- | --- |
| Runtime boundaries and agent execution | [Architecture overview](docs/ARCHITECTURE/README.md), [Agent Loop](docs/ARCHITECTURE/AGENT_LOOP.md) |
| Sessions, persistence, or compaction | [Session](docs/ARCHITECTURE/SESSION.md), [Context](docs/ARCHITECTURE/CONTEXT.md), [Metadata](docs/ARCHITECTURE/METADATA.md) |
| Tools, delegation, or execution evidence | [Tools](docs/ARCHITECTURE/TOOLS.md), [Subagent](docs/ARCHITECTURE/SUBAGENT.md), [Execution reports](docs/ARCHITECTURE/EXECUTION_REPORT.md) |
| Permissions, network access, or browser execution | [Permissions](docs/ARCHITECTURE/PERMISSIONS.md), [Web](docs/ARCHITECTURE/WEB.md), [Browser](docs/ARCHITECTURE/BROWSER.md) |
| Providers or Skills | [Providers](docs/ARCHITECTURE/PROVIDERS.md), [Skills](docs/ARCHITECTURE/SKILLS.md) |
| Projects, attachments, or document processing | [Projects](docs/ARCHITECTURE/PROJECTS.md), [Attachments](docs/ARCHITECTURE/ATTACHMENTS.md), [Documents](docs/ARCHITECTURE/DOCUMENTS.md) |
| Memory or scheduled work | [Memory](docs/ARCHITECTURE/MEMORY.md), [Automation](docs/ARCHITECTURE/AUTOMATION.md) |
| Browser or terminal UI | [Web UI](docs/ARCHITECTURE/WEBUI.md), [TUI](docs/ARCHITECTURE/TUI.md) |
| Setup, runtime commands, or verification | [Quick start](docs/QUICK_START.md), [Commands](docs/REFERENCE/COMMANDS.md), [Development](docs/DEVELOPMENT.md) |

## Development constraints

- Use TypeScript, Node.js 24.x, and pnpm 11.21.0. Use pnpm exclusively, preserve pnpm-lock.yaml, and keep native Windows support without requiring Bash, WSL, Docker, or a remote server. Prefer the existing runtime and model SDK; record reasons for changes.
- Strictly follow pi agent's TypeScript style. Before implementation, inspect relevant pi source; review naming, types, function structure, module boundaries, and abstractions against concrete examples while preserving Fatcat's contracts.
- Deliver a working, reviewable increment driven by the current task. Keep a simple Agent Loop and general-purpose tools; do not add a Graph engine, speculative interfaces, or per-task capability switches. The harness enforces permissions, budgets, and cancellation for parent and delegated work.
- Use English in repository text outside docs/, including code, comments, tests, help, and scripts. Chinese is allowed under docs/. User prompts and model responses may use any language.
- Never put real credentials in source, logs, documentation, or version control. Skills and saved history do not grant permissions; restoring a session must not replay operations or restore old approvals.
- For CLI changes, follow the [development guide](docs/DEVELOPMENT.md), section "CLI parsing and startup boundaries". Keep argument parsing free of host effects, preserve validation and early-return ordering, and leave terminal ownership/cleanup in the launcher and clients. Verify selector-to-client input handoff with injected-model Windows terminal checks.
- Keep host command parsing, help and output with the owning capability, following the [development guide](docs/DEVELOPMENT.md), section "Host command boundaries". Preserve user-visible command behavior and confirmation lifecycles; command handlers use SessionManager operations without taking ownership of execution policy or persistent state.
- Internal APIs and import paths may change during refactoring. Migrate all callers, tests, scripts and documentation together; remove obsolete forwarding modules and re-exports instead of preserving historical paths without a real consumer. Preserve user behavior, persisted data and state ownership; document any genuine compatibility requirement.
- Shared execution code belongs in `packages/runtime/src`; shared host commands and labels belong in `packages/commands/src`; TUI belongs in `packages/tui/src` and Web UI in `packages/webui/src`; CLI startup, chat and terminal approval presentation belong in `packages/cli/src`. Follow the [workspace package boundaries](docs/DEVELOPMENT.md#workspace-package-boundaries): use declared `@fatcat/runtime`, `@fatcat/commands`, `@fatcat/tui`, `@fatcat/webui` and `@fatcat/cli` exports across packages, preserve CLI → TUI/Web UI → commands → runtime dependencies, keep internal subpaths verification-only, declare direct dependencies and keep resources with their owning package. Product verification belongs in the private `packages/verification` development package; experiment protocols, evaluation adapters and their tests belong in private `packages/eval`. Production packages must not depend on either. Run the boundary check and validate built entry points after package moves.
- Keep session capability helpers free of active-session ownership, following the [development guide](docs/DEVELOPMENT.md), section "Session capability boundaries". Pass explicit dependencies and identities; preserve per-operation validation, lock boundaries and draft/turn lifecycles. Reuse preview-building rules while reading fresh sources at confirmation; keep each operation's preparation, commit and activation order explicit.
- For session persistence changes, follow the [development guide](docs/DEVELOPMENT.md), section "Session snapshot and storage boundaries". Keep snapshot file operations free of project resolution and transaction ownership; SessionStore retains query policy, validation, locks and commit coordination. Preserve strict project-member scans, fixed storage buckets, legacy reads and recovery semantics.
- For attachment storage changes, follow the [development guide](docs/DEVELOPMENT.md), section "Attachment file and publication boundaries". Keep byte operations separate from upload ownership and publication; AttachmentStore retains token checks, target validation, cleanup decisions and commits. Receive streams outside the metadata gate and preserve close-before-cleanup and original-before-association ordering.
- For metadata transaction changes, follow the [development guide](docs/DEVELOPMENT.md), section "Metadata journal and transaction boundaries". Keep journal codecs and JSON file operations separate from coordination; MetadataTransactions retains locks, durable decisions and recovery. Preserve disk-version compatibility, preflight validation, application order and read/replay error boundaries; import helpers directly from their owning modules.
- For memory storage changes, follow the [development guide](docs/DEVELOPMENT.md), section "Memory file and storage boundaries". Keep scope file operations and lock-owner reads separate from coordination; MemoryStore retains in-memory state, locks, revisions and migration decisions. Preserve cancellation points, error semantics and project-before-private publication; file helpers do not grant scope access.
- For project storage changes, follow the [development guide](docs/DEVELOPMENT.md), section "Project file and storage boundaries". Keep record file operations separate from list policy, revision checks and locks. Preserve strict direct reads, selective skipping in lists and metadata/project/session lock order; creation publication and journal recovery retain their own error boundaries.

- For Web UI changes, follow the [development guide](docs/DEVELOPMENT.md), sections "Web UI controller boundaries" and "Web UI browser view boundaries". Controller retains host lifecycles and display state; the browser entry retains its page snapshot, requests and draft, while views own only DOM and rendering caches. Preserve approval, cancellation, refresh and focus ordering; keep browser runtime imports client-local, retain package-local asset/helper lookup, register new browser modules in the static whitelist and verify affected interactions in injected-model Edge checks.
- For TUI changes, follow the [development guide](docs/DEVELOPMENT.md), section "TUI turn and presentation boundaries". TuiApp retains operation, approval, draft and terminal lifecycles, display state and evidence deduplication; presentation helpers only format explicit data. Keep command, conversation and background-task settlement distinct, and verify input/lifecycle changes in an injected-model Windows terminal.

## Common development commands

| Purpose | Command |
| --- | --- |
| Install locked dependencies | `pnpm install --frozen-lockfile` |
| Type-check | `pnpm run typecheck` |
| Build | `pnpm run build` |
| Offline tests (includes build) | `pnpm test` |
| CLI help | `pnpm start --help` |
| Local configuration check | `pnpm start --checkConfig` |

See the [command reference](docs/REFERENCE/COMMANDS.md) for runtime options and [development guide](docs/DEVELOPMENT.md) for specialized checks.

## Workflow and verification

- Inspect the branch, base commit, uncommitted changes, related source, and configuration before editing. Preserve user changes and untracked files; never reset, clean, force-push, or rewrite shared history to prepare a branch.
- Use a purpose-named branch: feat/, fix/, doc/, refactor/, or test/; follow an explicitly requested name and reuse the task's existing branch. Keep changes within one reviewable increment.
- Run checks proportional to the change. Automated tests use fake credentials and injected transports. Distinguish offline, real browser/terminal, and real model evidence; historical passing results do not validate a new change. Run real model verification only when explicitly requested, and do not redirect existing DeepSeek verification scripts to another provider.
- Follow the [development guide](docs/DEVELOPMENT.md), section "Test and verification layout", for new and moved tests: group product offline tests under `packages/verification/tests/` by the contract they verify, keep entry-specific checks with that client, and place complete task scenarios in `packages/verification/tests/workflows/`. Keep local helpers with their owner, shared helpers in `packages/verification/tests/support/`, sample data/builders in `packages/verification/tests/fixtures/`, and environment-dependent runners under `packages/verification/verify/`. Evaluation protocols, result statistics and future experiment adapters belong in the private `packages/eval` package, with their own tests and fixtures under `packages/eval/tests/`. Neither development package may depend on the other; production packages must not import or depend on either. Eval currently has no product dependencies or public exports; review actual runtime consumers when adding execution adapters. For moves, update imports, runtime resource paths, commands and documentation, remove only obsolete generated outputs, and check source/compiled test inventory parity.
- When committing, stage explicit relevant paths, inspect the staged diff, and use a concise `type(scope): summary` message. Report branch, completed checks, and remaining limitations at handoff. Do not push or merge without authorization.

## Documentation maintenance

- Update the affected document: PROJECT for stable scope, QUICK_START/GUIDES for operation, REFERENCE for commands/configuration, DEVELOPMENT for checks, and ARCHITECTURE for modules, interfaces, state ownership, and lasting decisions. Keep proposals and acceptance criteria in the relevant topic, clearly separate from implemented behavior; do not create empty future-system documents.
- Link to the maintained source instead of repeating it. Keep root README concise and use docs/README.md for navigation. Use Git and PRs for historical plans and delivery history. Do not maintain or commit architecture Excalidraw files.
- Update local docs/PROGRESS.md with a short outcome, checks actually run, unresolved blockers, and next steps, including failed or interrupted work. Create it if absent and keep it ignored. Consult it when continuing work, but keep shared behavior and material verification limits in tracked topic documents; public documentation must not depend on this local log. Mark work complete only when its acceptance criteria are satisfied.
