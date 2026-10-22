# Architecture overview

English | [简体中文](../../zh-CN/ARCHITECTURE/README.md)

[Documentation](../README.md) · [Project boundaries](../PROJECT.md) · [Development and verification](../DEVELOPMENT.md)

Fatcat is a TypeScript Agent Harness for local coding tasks. CLI, chat, TUI and local Web UI share the runtime core. Clients own input, approval presentation and results; the core owns execution, persistence, permissions, budgets and cancellation. This page describes current source responsibilities; see the guides for operation.

## Workspace package boundaries

The workspace contains the root application, private `@fatcat/runtime`, `@fatcat/commands`, `@fatcat/tui`, `@fatcat/webui`, `@fatcat/cli`, and development-only `@fatcat/verification` and `@fatcat/eval`. Shared execution, capabilities and persistent state live in `packages/runtime/src/`, compile independently to that package's `dist/`, and expose JavaScript and declarations through explicit subpath exports. CLI, TUI, Web UI, tests and verification scripts import package names; runtime does not depend on its callers. Internal code remains organized by domain without forcing every domain into a separate package.

`packages/commands/src/` owns shared commands, session labels, argument utilities and interactive confirmation state, exported through `@fatcat/commands` and explicit subpaths. Clients may depend on commands and runtime; commands depends only on runtime, which does not depend on commands. `packages/cli/src/` owns CLI/chat, terminal input/approval presentation and application version reading. CLI depends on the core, commands and the two optional interface packages; clients do not depend on CLI. `packages/tui/src/` exposes a lazy entry through `@fatcat/tui` and retains App, views, telemetry and terminal lifecycle. `packages/webui/src/` exposes a lazy entry through `@fatcat/webui` and owns HTTP, Controller, browser views and resources. The two client packages are independent. `packages/verification/tests/` and `packages/verification/verify/` centralize offline contracts and environment checks, compiled by verification. Root `scripts/start.ts` retains the pnpm invocation-directory adapter; root commands orchestrate builds and checks. Verification depends one-way on product packages, exposes no library API and cannot be imported by production packages. Former runtime paths are removed without compatibility forwarding; commands, persistent formats, locks and state ownership remain unchanged. See [development rules](../DEVELOPMENT.md#workspace-package-boundaries) for build, export and dependency requirements.

The independent development package `@fatcat/eval` in `packages/eval/` owns experiment protocols, injected Session/promptfoo adapters, result validation, statistics and its own offline tests. Product packages cannot depend on eval; eval and verification cannot depend on each other. Eval uses reviewed `@fatcat/runtime` exports and has no public exports of its own. Runtime retains Session, Context, tool, permission and persistence ownership. Live model evaluation remains separate. See [Eval](EVAL.md).

## Call chain and state ownership

An entry passes a task to SessionManager. AgentSession first persists an execution claim, then Session calls Loop on a history copy. Loop requests the Model, executes associated tool calls and continues until a final answer or explicit termination. After AgentSession durably commits or records interruption, the entry displays results and the execution report.

| Layer | Current source | Responsibility |
| --- | --- | --- |
| Entry and interaction | `packages/cli/src/cli.ts`, `packages/cli/src/cli/`, `packages/cli/src/chat.ts`, `packages/cli/src/terminal.ts`, `packages/tui/src/`, `packages/webui/src/` | Startup parsing/orchestration, input, host commands, approval interaction, cancellation and display |
| Host commands | `packages/commands/src/commands.ts`, capability `commands.ts` modules | Shared dispatch and capability-owned parsing, help and output; see [Session](SESSION.md) for dispatch/confirmation lifecycle |
| Assembly | `packages/runtime/src/agent.ts` | Prepare Tools/Skills by workspace; bind parent/child execution identity and material access to the actual Session; see [Agent Loop](AGENT_LOOP.md) |
| Sessions | `packages/runtime/src/session/` | Successful history, current records, running claims, selection and persistent storage |
| Turns | `packages/runtime/src/loop.ts`, `packages/runtime/src/subagent.ts` | Model/tool loop, bounded delegation, request allowance and events |
| Models and context | `packages/runtime/src/model.ts`, `packages/runtime/src/providers.ts`, `packages/runtime/src/context/` | Protocol conversion, request projection, full request budgets and compaction |
| Tools and safety | `packages/runtime/src/tools.ts`, `packages/runtime/src/tools/`, `packages/runtime/src/permissions/` | Tool arguments/execution facts and permission/resource boundaries |
| Projects and materials | `packages/runtime/src/project/`, `packages/runtime/src/attachments/`, `packages/runtime/src/documents/`, `packages/runtime/src/memory/` | Project directories, material associations, immutable originals, derived content and current memory |
| Scheduling and evidence | `packages/runtime/src/automation/`, `packages/runtime/src/execution-report.ts` | Bounded activations and observations from this turn, without owning another conversation history |

Keep these states distinct:

- **Successful history and interruption records** belong to Session / AgentSession; restoring does not replay tools or old authorization.
- **Workspace tool journals** record process-local writes, commands and browser checks. New sessions neither undo effects nor clear these journals.
- **Request context** is a bounded projection of history and current guidance, not a replacement for full history or current files.
- **Project, attachment and Memory scope** is validated against actual execution identity, never inferred from a common directory, UI selection or model-provided ID.
- **Execution reports** describe observed facts, without certifying model answers or implementing full Task acceptance.

## CLI startup boundaries

`packages/cli/src/cli.ts` is the process entry: it reads argv, calls `runCli()` and sets the exit code. `packages/cli/src/cli/options.ts` owns option definitions, help, optional `--resume` normalization, implicit chat selection and combination validation, returning typed Node parseArgs results. It does not access configuration, storage or terminals. `packages/cli/src/cli/run.ts` owns local checks, interactive session selection, configuration/permission assembly, client dispatch, output and host cleanup; importing it does not start CLI. Package root `@fatcat/cli` maps directly to callable runCli; `@fatcat/cli/entry` maps to the argv-executing entry. Tests/native checks use `@fatcat/cli/internal/*` for internal access. The root adapter restores the pnpm invocation directory before importing /entry. VERSION comes from CLI's own manifest; build boundary checks require the CLI and root versions to match. Old root src paths are removed. The executable entry is the actual startup contract, not a compatibility re-export.

Combination validation precedes early returns for help/version. Noninteractive selector-less `--resume` lists sessions before empty-prompt, TTY and model-configuration checks. Automation configuration and watched-path validation also precede model configuration. The interactive picker reuses TerminalInput for chat and closes it before TUI/Web UI. Each client owns its runtime lifecycle; PermissionPolicy retains permission decisions. Usage/configuration/cancellation exit codes and stdout/stderr responsibilities retain their contracts.

`scripts/start.ts` alone restores pnpm's `INIT_CWD`; direct CLI execution does not interpret it. See [Commands](../REFERENCE/COMMANDS.md) for startup rules and [Development](../DEVELOPMENT.md) for maintenance constraints and injected-model terminal checks.

## Topic index

| Responsibility | Document |
| --- | --- |
| Turn control, assembly and termination | [Agent Loop](AGENT_LOOP.md) |
| Session records, running claims and recovery | [Session](SESSION.md) |
| History projection, older-read omission and compaction | [Context](CONTEXT.md) |
| General tool protocol, file operations and journals | [Tools](TOOLS.md) |
| Permission modes, approvals and shared execution guards | [Permissions](PERMISSIONS.md) |
| Bounded children with isolated histories | [Subagent](SUBAGENT.md) |
| Request, usage and operation facts | [Execution reports](EXECUTION_REPORT.md) |
| Experiment protocol, grading records and completeness statistics | [Eval](EVAL.md) |
| Model protocols and capability adaptation | [Providers](PROVIDERS.md) |
| Local guidance discovery and on-demand reads | [Skills](SKILLS.md) |
| Project directories, joining and management | [Projects](PROJECTS.md) |
| Cross-domain metadata commits, locks and recovery | [Metadata](METADATA.md) |
| Originals, associations, pins and publication | [Attachments](ATTACHMENTS.md) |
| Local parsing, vision requests and provenance | [Documents](DOCUMENTS.md) |
| User facts, scope and revisions | [Memory](MEMORY.md) |
| Session-bound and standalone scheduling | [Automation](AUTOMATION.md) |
| HTTP(S) search and page retrieval | [Web](WEB.md) |
| Workspace page execution and evidence | [Browser](BROWSER.md) |
| Terminal interaction and telemetry | [TUI](TUI.md) |
| Local HTTP, interface and previews | [Web UI](WEBUI.md) |
| Unimplemented retrieval, audio and multimodal proposals | [RAG and future material capabilities](RAG.md) |

## Cross-module constraints and decisions

1. Keep a simple Loop and a few general tools. Evolve capabilities from concrete tasks without prebuilding Graph engines, plugin frameworks or empty interfaces.
2. Tools may be cached per workspace; Session/Project identity must bind at execution. Background work and children inherit the actual target, not the current UI scope.
3. Validate permissions, budgets and cancellation before operations. Prompts, Skills, materials, Memory and history cannot elevate authorization. Shell and command-risk classification are not an OS sandbox.
4. Side effects and session commits are separate transactions. Preserve facts after failure, cancellation or storage errors; never claim files or external requests roll back automatically.
5. Mutexes and durable claims guard execution; short locks guard metadata commits. Cross-file material changes use recovery journals. Never hold disk locks while waiting for users, models or upload networks.
6. Manage originals, derived content, Memory and request projections separately. Fixed provenance cannot silently point to a new version after reparsing or rebuilding.
7. The core does not depend on terminal or HTTP presentation. New clients reuse Session, Loop, Tools and Permissions.

The toolchain uses Node.js 24.x, pnpm 11.21.0, ESM/NodeNext and compilation before execution. [package.json](../../../package.json) and the lockfile define exact versions. Retain Node's env-file loading and test runner rather than adding bundlers or runtimes without demonstrated need. Domain topics record specialized dependency decisions; see [Development](../DEVELOPMENT.md) for version policy and commands.

TypeScript maintenance follows relevant concrete pi agent source and state ownership; engineering rules live in [AGENTS](../../../AGENTS.md). Reference projects are neither Fatcat dependencies nor evidence of available capabilities. Do not maintain architecture Excalidraw files.

## Verification and evolution boundaries

Topics record required check boundaries and known gaps; commands live in [Development and verification](../DEVELOPMENT.md). Validate offline contracts, real Windows/Edge, public network and real models separately. Existing fixed-example results do not validate current changes.

Further refactoring follows workspace package boundaries, first checking actual assembly, state ownership and lifecycles while retaining persistence, permissions, budgets, cancellation and side-effect contracts. The package move does not change storage formats. Web UI/TUI topics own their future requirements. Existing materials and Memory remain the compatibility baseline; a shift in development focus does not close quality gaps.

Graph, Channels/Apps, remote services, parallel or recursive delegation, file-restoration checkpoints and full Task acceptance are unimplemented. Retrieval and audio are deferred. Cost optimization first needs representative tasks, success thresholds and cost baselines. The current task determines order.
