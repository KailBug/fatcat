# Fatcat project

English | [简体中文](../zh-CN/PROJECT.md)

Fatcat is an independent TypeScript Agent Harness that runs natively on Windows. Its near-term focus is local coding tasks: read projects, make controlled changes, run verification and deliver reviewable results.

This page maintains stable goals and boundaries. See the [documentation index](README.md) for usage and development entry points and the [architecture index](ARCHITECTURE/README.md) for the overall structure. Proposals, acceptance criteria and unresolved issues belong in their respective topics; the current task determines implementation order.

## Project goals

- Establish a practical local development cycle whose results can be checked against files, commands and execution evidence.
- Share Session, Loop, model communication, tools and permission boundaries across CLI, optional TUI and local Web UI.
- Let concrete tasks drive capability selection and evolution. Models select general tools, Skills and bounded delegation as needed; the harness enforces scope, permissions, budgets and cancellation.
- Preserve room for a general-purpose harness, measuring progress through representative task success rates and maintainability.

The project is still in early development. Passing fixed examples does not establish maturity on complex tasks; describe implementation, offline checks, real-environment verification and real-model quality separately. The root [package.json](../../package.json) is the version source of truth.

The developer is currently the only user. Prioritize a clear current design without assuming compatibility commitments for historical sessions or internal APIs. Format changes may remove old-version readers and migration branches while updating code, tests and documentation together; they must not automatically delete or rewrite existing files. After launch, establish supported versions, migration methods and compatibility periods from actual user needs.

## Core principles

- **Deliver a working increment first.** Define the problem, scope and acceptance criteria for each change, preserving existing user behavior and data boundaries.
- **Keep it simple.** Start with a simple Agent Loop and a small set of general, composable tools; derive abstractions from demonstrated needs.
- **Make responsibilities and ownership explicit.** Clients handle input and display, Loop controls turns, model clients communicate, tools execute, and Session and state modules own their data.
- **Report results with evidence.** Tool success, a model's final answer and task acceptance are distinct facts. Report completed operations accurately after failures, cancellation or interruption.
- **Prioritize correctness and task quality.** Cost optimization requires a defined task set and success-rate baseline; fewer tokens are not a substitute for task completion.

## Engineering boundaries

- Preserve native Windows support and the existing TypeScript/Node.js toolchain. [AGENTS.md](../../AGENTS.md) owns versions, package management and pi agent style requirements; see [Architecture](ARCHITECTURE/README.md) for dependency decisions.
- Tools, Skills, delegation, attachments and Memory cannot expand authorization. The relevant architecture defines explicit permission-mode exceptions and execution boundaries; command-risk checks are not an OS sandbox.
- Keep persistent history, working directories, material scope and execution facts distinct. Restoring history neither restores old authorization nor replays operations automatically.
- [AGENTS.md](../../AGENTS.md) owns development workflow, language rules, credential protection and verification requirements.

## Non-goals and long-term direction

Current work does not include a Graph engine, extension frameworks without demonstrated need, or wholesale migration of reference projects into Fatcat. Channels, Apps and remote services are not near-term deliverables. Architecture topics maintain existing limitations and possible later designs; a design document does not imply scheduled development. Revisit requirements, code and acceptance criteria before resuming deferred work.

LoopX's task/evidence management and OpenViking's context/memory organization are long-term learning references. Evaluate mechanisms against the reference version, implementation cost and observable benefits for a concrete task, rather than competing on feature counts.
