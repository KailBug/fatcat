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

Temporary fixtures are separate from the user's project; existing basic live reads also use synthetic `examples/workspace` samples. Cleanup does not undo provider usage. The exact runner and assertions are in the matching `scripts/verify-*.ts` source.

## Verification evidence

This page describes how to run checks, not a record of checks that have passed. A script's existence, written code or a historical passing result does not validate the current change.

At handoff, report the branch, checks actually run, outcomes, failures/blockers and remaining limits. Distinguish offline contracts, real browser/terminal behavior, public-network checks and real model requests. Keep material behavior and validation limits in the corresponding tracked architecture topic so a fresh clone can be understood independently. Detailed task history belongs in Git/PRs and local handoff notes, not duplicated acceptance claims across manuals.

## Version and badges

[package.json](../package.json) is the version source of truth. The package is private and runs from a checkout; its version does not imply an npm publication or GitHub release. `pnpm start --version` needs no credentials or session. After building, `node dist/src/cli.js --version` prints just the version.

Use `0.x.y` during early development: patch for fixes, minor for new capabilities or compatibility changes. Document compatibility changes before upgrading; reserve `1.0.0` for a stable compatibility contract. Application, session and automation schema versions are independent.

README version and CI badges refer to `main`, not the local branch or working tree. Update static Node.js/pnpm badges in both READMEs when requirements change. Repository stars and badge state do not constitute verification evidence.
