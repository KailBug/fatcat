# Development Guidelines

## Project boundaries

- This repository is an independent Agent Harness project.
- Use TypeScript, Node.js 24.x, and pnpm 11.21.0. Run natively on Windows without requiring WSL, Docker, or a remote server.
- Deliver a working increment first, then improve quality. Keep each change within the current phase.
- Implement the simple Agent Loop first. Do not add a Graph engine or speculative interfaces.
- Prefer the repository's existing runtime, package manager, and model SDK. Record the reasons for any change.

## Development direction and organization

- Prioritize a working local coding workflow: inspect, modify, verify, and deliver reviewable results. Keep CLI interaction for now; defer channels, TUI, Web UI, and app development.
- Prefer a small set of general-purpose, composable tools such as read, write, and shell execution. Do not add a separate model-facing tool for every development operation. Native Windows support must not require Bash.
- Target task-driven tool selection and delegation. Users should not need to enable internal capabilities per task; the harness still enforces workspace access, permissions, budgets, and cancellation. The CLI makes bounded delegation available by default; the model chooses whether to use it.
- Keep interaction, loop control, model communication, tool execution, and state ownership clear. Favor readable modules and narrow interfaces; avoid monolithic handlers and speculative frameworks.
- Maintain architecture descriptions in docs/ARCHITECTURE/ when module boundaries or development direction change. Distinguish implemented behavior from planned capabilities. Do not maintain Excalidraw files or add docs/ARCHITECTURE/fatcat-architecture.excalidraw to Git; any local copy is an unmaintained reference.
- Treat selected LoopX and OpenViking capabilities as long-term benchmarks, evaluated through concrete tasks rather than feature counts.

## Git workflow

- Start implementation on a purpose-named branch after checking the current branch, base commit, and uncommitted changes.
- Use feat/<topic> for features, fix/<topic> for bug fixes, doc/<topic> for documentation-only work, refactor/<topic> for behavior-preserving restructuring, and test/<topic> for test-only work. Follow any explicitly requested branch name.
- Keep changes focused on one reviewable increment. Include documentation and tests with the feature or fix they support; do not split them into unrelated branches.
- Preserve user changes and untracked files. Do not reset, clean, force-push, or rewrite shared history to prepare a branch.
- When committing, stage explicit relevant paths and use a concise type(scope): summary message. Verify the staged diff and completed checks before committing.
- Report the branch, validation, and remaining limitations at handoff. Do not merge or push without authorization.

## Language policy

- Use English in all repository text files outside docs/, including source, tests, comments, identifiers, error messages, CLI help, scripts, configuration, README.md, and this file.
- Chinese is allowed only in files under docs/.
- User prompts and model responses may use any language at runtime. Do not translate or restrict user data to enforce the source-file policy.

## Before starting a task

1. Read this file, README.md, docs/PROJECT.md, docs/ROADMAP.md, docs/PROGRESS.md, and docs/ARCHITECTURE/README.md, plus relevant system architecture documents.
2. Inspect related source, configuration, and uncommitted changes. Preserve valid conventions and user changes.
3. Separate the current task from long-term directions. Refine later phases only when implementation requires it.

## During implementation

- Update project scope, roadmap, or architecture documents when the scope or approach changes.
- Keep README.md concise: logo, brief demo description, a usage-guide link, and image attribution. Maintain actual capabilities and current Windows installation, configuration, execution, and verification steps in docs/USAGE.md.
- Keep architecture documents in docs/ARCHITECTURE/. README.md is the overview and index; create separate system design and implementation documents as needed.
- Record actual modules, data flow, interfaces, and decisions. Clearly label future design and work as planned or unimplemented.
- Do not create empty documents for future systems. Do not treat written code as verified behavior.
- Keep tests proportional to the change. Distinguish simulated checks from live model validation, and report missing environment or credentials honestly.
- Never include real credentials in source, logs, documentation, or version control.

## At the end of every task

- Update docs/PROGRESS.md with actual work, verification results, blockers, limitations, and next steps, including failed or interrupted tasks.
- Distinguish planned, implemented, and verified work.
- Synchronize affected README.md, PROJECT.md, ROADMAP.md, and architecture documents.
- PROGRESS.md is the primary source of progress facts. Resolve discrepancies using code and verification evidence.
- Mark a phase complete only when its acceptance criteria are satisfied.

## Project commands

- Use pnpm exclusively inside this project and preserve pnpm-lock.yaml.
- Install: pnpm install --frozen-lockfile
- Type-check: pnpm run typecheck
- Build: pnpm run build
- Test: pnpm test
- Help: pnpm start --help
- Continuous chat: pnpm start --chat
- Workspace chat with per-write and per-command terminal approval: pnpm start --chat --workspace examples/workspace
- Explicit read-only workspace chat: pnpm start --chat --workspace examples/workspace --permission read-only
- Preauthorized workspace editing (does not preauthorize commands): pnpm start --chat --workspace examples/workspace --permission workspace-write
- Preauthorized command execution: add --shell-permission allow to a workspace task; commands are not OS-sandboxed.
- Task-driven delegation is available in ordinary task and chat commands without a capability flag.
- Local configuration check: pnpm start --checkConfig
- Local skill catalog: pnpm start --listSkills (add --workspace <directory> for project skills; no model credentials required).
- Live verification: pnpm run verify:live (uses a real local DeepSeek key and sends fixed test requests).
- Live delegation verification: pnpm run verify:delegation (fixed read-only temporary fixtures, at most 20 real model requests).
- Live coding verification: pnpm run verify:coding (uses a temporary search/read/edit fixture, authorizes only its designated edit and fixed test command, checks the execution report and provider token usage, and allows at most 14 real model requests).
- Live multi-file workflow verification: pnpm run verify:workflow (two turns in a temporary cart/receipt fixture, narrowly authorized source edits and fixed checks, independent reruns and per-turn report validation, at most 28 real model requests).
- Live context verification: pnpm run verify:context (three turns over a synthetic read-only temporary workspace, a 26000-byte request budget, and at most 27 real model requests).
- DeepSeek is the default model provider; Kimi, MiMo, and Qwen are also supported through the shared OpenAI-compatible client. Keep credentials isolated per provider in local environment variables or the ignored .env file.
- Follow docs/ARCHITECTURE/PROVIDERS.md for provider changes: use official endpoints and supported request fields, preserve tool-call validation, request budgets, cancellation, safe errors, and injected-transport coverage. New providers do not require live API validation unless explicitly requested.
- Existing live verification scripts are restricted to DeepSeek; do not silently redirect them to another provider.
- Built-in Skills live in src/skill/<subsystem>/<skill-name>/SKILL.md and ship with the build. Add task guidance only for implemented subsystems; do not create empty placeholders or copy runtime permission enforcement into prompts.
- Skills are discovered from explicit workspace and user skill roots, then the built-in catalog, and loaded through read. Local same-name Skills take precedence. Skill metadata and instructions never grant additional workspace or shell permissions.
- Automated tests must use fake credentials and injected transports. Live verification is a separate, explicit command.
