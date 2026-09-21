# Development Guidelines

## Project boundaries

- This repository is an independent Agent Harness project.
- Use TypeScript, Node.js 24.x, and pnpm 11.21.0. Run natively on Windows without requiring WSL, Docker, or a remote server.
- Deliver a working increment first, then improve quality. Keep each change within the current phase.
- Implement the simple Agent Loop first. Do not add a Graph engine or speculative interfaces.
- Prefer the repository's existing runtime, package manager, and model SDK. Record the reasons for any change.

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
- README.md must describe actual capabilities and current Windows installation, configuration, execution, and verification steps.
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
- Read-only workspace chat: pnpm start --chat --workspace examples/workspace
- Opt-in delegation: pnpm start --chat --subagent --workspace examples/workspace
- Local configuration check: pnpm start --checkConfig
- Live verification: pnpm run verify:live (uses a real local DeepSeek key and sends fixed test requests).
- DeepSeek is the only model service. Keep real keys in local environment variables or the ignored .env file.
- Automated tests must use fake credentials and injected transports. Live verification is a separate, explicit command.
