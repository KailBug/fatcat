# Eval: experiment protocol and result statistics

English | [简体中文](../../zh-CN/ARCHITECTURE/EVAL.md)

[Architecture](README.md) · [Checks and evidence requirements](../DEVELOPMENT.md#evaluation-evidence-requirements)

`packages/eval` is an independent development package for experiment definitions, injected Session execution, result records and statistics. It calls runtime's Session, Loop, Context, tools and stores through existing package exports; runtime retains their ownership. Product packages do not depend on it; eval and verification do not depend on each other. Live model execution, an automated dataset-download manager, whole-experiment budget scheduling and a general experiment CLI remain unimplemented. The injected headless entry below is available for the pinned Linux task environment.

## Modules and references

| Module | Responsibility |
| --- | --- |
| `src/experiment.ts` | `Experiment`, strict configuration parsing, versioned provenance references and experiment SHA-256 digests |
| `src/result.ts` | `EvalResult`, execution/grading states, usage coverage and JSON serialization/reading |
| `src/summary.ts` | Configuration binding, per-attempt completeness and statistics; JSON-serializable summaries and all records |
| `src/validation.ts` | Shared scalar, object and digest-encoding validation |
| `src/artifacts.ts` | Local content hashes, confined artifact reads, exclusive evidence writes and observed checkout/build/environment identity |
| `src/materials.ts` | Verified dataset, prompt, policy and separate reference answers |
| `src/session-runner.ts` | One isolated attempt through runtime; events, usage, cancellation, evidence, cleanup and independent grading |
| `src/promptfoo-provider.ts` | Thin promptfoo provider mapping sample/repetition to the runner and returning output plus result metadata |
| `src/harbor-result.ts` | Offline reading of hash-bound, single-step Harbor trial results; preserves rewards, exceptions and nullable usage without local regrading |
| `src/headless.ts`, `scripts/headless.ts` | Injected task-directory Session execution, explicit limits/policy, durable evidence and executable signal lifecycle |
| `harbor/`, `scripts/verify-linux.ts` | Pinned official task/controller dependencies, Oracle/image metadata and real Linux acceptance |
| `tests/`, `scripts/test.ts` | Package synthetic data, file round trips, statistics and integration regressions; source-inventory-driven offline entry |

Organization references Maka `packages/eval` experiment/result separation and strict decoding (commit `8686793e5d051018c61e53350e542992d19d5311`); types and explicit functions reference pi `usage-totals.ts` (commit `3daa20280f6a7c7cbe0935680c9a38fdc3863005`) and its SDK's explicit dependency assembly. This independent implementation follows Fatcat contracts without importing Maka Harbor, Fleet, proxy networks or retry selection. Eval declares `@fatcat/runtime` and pins development dependency `promptfoo` at `0.124.1` for actual provider-loader integration. The provider imports types from `promptfoo/contracts`, avoiding unrelated database-driver declarations from the root type entry without weakening TypeScript checks. The workspace permits esbuild's required installation build.

The pinned promptfoo dependency graph currently reports peer-range mismatches for OpenTelemetry API (1.10.0 versus SDK ranges below 1.10), nunjucks/chokidar (5 versus 3), and MongoDB/gcp-metadata (9 versus 7). The exercised in-memory provider path passes; telemetry exporters, watch mode and database integrations are not validated here. These upstream compatibility warnings are retained, not hidden by disabling peer checks or adding unverified overrides.

## Experiment definitions

`schemaVersion` is `fatcat.eval.v1`. Parsers reject missing/extra fields, invalid numbers, duplicate samples and unknown versions, and copy nested data. Experiments contain:

- `id`, complete Git SHA, `dirty` and specific OS/Node/pnpm environment identities.
- `evidence`: `synthetic`, `injected` or `live`; `level`: `contract`, `model_quality` or `task_acceptance`. They are independent: synthetic task-acceptance results remain synthetic evidence.
- Provider, model ID and nonsecret generation parameters. Parameters accept only finite JSON scalars and reject common credential fields. This is not general redaction; callers must not supply real keys, private bodies or complete runtime configuration.
- Data ID/version, manifest provenance and SHA-256. Manifests should locate fixed inputs, reference answers and sample identities. `sampleIds` is the complete declared-version inventory; development/holdout are disjoint subsets, and selection must come from one declared split.
- `coverage`: `subset` or `full`, with `full` allowed only when selection equals all `sampleIds`. This checks consistency with the declared inventory, not agreement with an official benchmark or unchanged official environment. Integrators still verify version, license, full inventory and corpus reductions.
- Separate prompt, policy and grader versions, sources and content SHA-256; repetitions; per-attempt/whole-run request, token, time and optional USD caps. `costUsd: null` means no declared money limit, not free execution.

Sources may be recoverable repository-relative paths or fixed external resources. The protocol parser reads no files, accesses no network and verifies neither Git objects nor actual content. The injected adapter below supports only local files, verifies their hashes and compares code/environment against the actual checkout. Model aliases/services may change; locatable configuration does not guarantee identical output. Formal comparisons first use clean commits. `dirty: true` can record diagnostics, but v1 stores no uncommitted patch or untracked files and cannot claim reproducibility.

`experimentDigest()` SHA-256 hashes the complete parsed result with sorted object keys and declared array order. Results bind both experiment ID and digest. Changes to code, model parameters, samples, prompts, policy, budgets or graders prevent mixing old results.

## Results and grading

Each `fatcat.eval.result.v1` record is located by experiment ID/digest, sample ID and one-based repetition. Repetitions differ from infrastructure retries. v1 accepts one terminal record per planned position without overwrite, retry selection or resume. The injected adapter atomically claims each position before execution.

Execution `status` is `completed`, `failed`, `timeout`, `cancelled` or `infra_error`. Noncompleted states require `failureReason` and `not_assessed` grading. Completed work may be `passed`, `failed` or unassessed; assessed results require reasons and source/SHA-256 evidence. `completed` does not imply acceptance. [Execution reports](EXECUTION_REPORT.md) retain `taskVerification: not_assessed`; independent graders supply evaluation decisions. This validates record shapes, not graders themselves.

`usage.requests` counts observed request attempts in record scope, not provider-confirmed billed calls. `reportedRequests` counts attempts with valid usage. Input/output are known-request subtotals, missing as null. Cache hits are a subset of input, never added again or zero-filled when unreported. Overflow remains unknown. Costs require complete usage plus `estimated`/`reported` basis and price/billing provenance; unknown prices are null. Failures/cancellation retain previously observed usage/cost. Mixed cost categories do not pose as one measured total.

## Summary definitions

`summarizeExperiment()` rejects mismatched experiments, unknown samples, out-of-range repetitions and duplicates. Planned count is `selectedIds.length × repetitions`. Preserve every attempt and sort by sample/repetition rather than selecting the best.

- Missing records yield `complete: false`, planned/recorded/missing counts and null final `successRate`.
- When all planned positions have records and every completed record is graded, success rate is passed/planned. Failures, timeouts, cancellations and infrastructure errors stay in the denominator and have separate counts. This is a local attempt success rate, not an official benchmark score or pass@k.
- Completed but ungraded answers also make final success rate null. Failed terminal states are not mistaken for pending grading.
- Usage shows known subtotals and request coverage. Complete totals require a complete experiment and input/output counters for all requests. No known values means null.
- Costs aggregate only when every planned record has finite costs on the same basis; otherwise null, with individual records retained. Display JSON null as `unknown`, never 0.

Synthetic examples in `packages/eval/tests/fixtures/experiments.ts` contain five records: pass, wrong answer, timeout, cancellation and environment error, yielding 1/5 success, only two known usage records and unknown cost. They test statistics, not actual Fatcat performance.

## Injected Session execution

`runSessionEvaluation({ experiment, sourceRoot, outputRoot }, { createTransport }, { sampleId, repetition }, signal?)` is the package-local execution entry. Build first and invoke through pnpm so the actual pnpm version can be recorded. `evidence` must be `injected`; there is no fallback to real fetch or credential loading. The caller supplies a trusted transport factory, producing fresh transport state per attempt. This is an explicit test dependency, not a sandbox for arbitrary transport code.

Materials use UTF-8 JSON/text and content SHA-256 references relative to `sourceRoot`:

- Dataset: `{ "samples": [{ "id": "read", "prompt": "Read note.txt and return its color.", "files": [{ "path": "note.txt", "artifact": { "source": "note.txt", "sha256": "<64 hex characters>" } }] }] }`. Inventory must match the experiment. Workspace paths reject traversal, hidden segments, `node_modules`, Windows device names and ambiguous suffixes. Each sample has at most 64 files; each source is a regular file of at most 1 MiB, confined to the source root.
- Prompt: nonempty plain text prepended to the sample instruction.
- Policy: `{ "permission": "read-only", "maxRequestBytes": 262144, "requestTimeoutMs": 5000, "autoCompaction": true }`; `workspace-write` is also accepted. Shell execution is denied and web/browser tools are not enabled. Runtime still enforces file permissions.
- Grader: `{ "type": "exact-match", "answers": { "read": "violet" } }`, with exactly one nonempty answer per declared sample. Answers stay outside the workspace and model input; this simple grader checks answer text, not coding-task acceptance.

The model uses runtime's validated provider/model identity with exactly `region` and `thinking` parameters; unsupported extra parameters are rejected rather than silently ignored. Evidence records the resolved model selection, runtime generation defaults and prepared request bodies without SDK credential headers. It also records actual Git SHA/dirty state, OS/Node/pnpm versions and a digest of runtime/eval compiled JavaScript. Build first: this digest identifies executed artifacts but does not prove that a stale build matches its source commit.

Each attempt creates its own temporary workspace, SessionStore, SessionManager and Agent. Real file tools, Context preparation, model decoding and Session persistence run against the injected transport. Request events supply usage; missing usage and all unpriced costs remain unknown. The runner propagates caller cancellation and its per-attempt deadline, awaits runtime settlement, saves history/events, then removes only its generated temporary directory. Runtime's request allowance is configured from `perAttempt.requests`; token, money and whole-experiment limits remain declarative pending KAI-23. Deadlines require cooperative injected transports and runtime cancellation; they are not process termination guarantees.

Outputs are exclusively written under `outputRoot/<experimentDigest>/<sha256(sampleId)>-<repetition>/`:

| File | Meaning |
| --- | --- |
| `evidence.json` | Full experiment, observed execution identity, request bodies, events, Session snapshot, answer and execution outcome before cleanup |
| `grade.json` | Completed attempts only: independent exact-match decision, expected/actual answer and hashed execution-evidence reference |
| `result.json` | Protocol result with final status, grading references, elapsed time, usage and unknown cost |

Material/configuration errors fail before claiming an attempt. Once claimed, ordinary setup/runtime failures produce a terminal record; cleanup errors make its final status `infra_error`. A failed evidence write retains temporary state for diagnosis; disk failures or process termination can leave an incomplete output directory. Duplicate claims, including partial directories, fail instead of overwriting or resuming. Evidence includes task content and history; choose nonsecret fixtures and protect the output directory.

For promptfoo, a trusted wrapper extends `FatcatProvider` and supplies the transport in its constructor, following the [custom JavaScript provider interface](https://www.promptfoo.dev/docs/providers/custom-api/). Its config is the same `{ experiment, sourceRoot, outputRoot }`. Use prompt `{{sampleId}}`, test vars `{ sampleId }`, `cache: false` and `repeat: experiment.repetitions`; promptfoo's zero-based repeat index becomes a one-based repetition. The provider rejects alternate untracked prompt text and returns the authoritative result plus evidence location in metadata. Promptfoo assertions and runtime execution reports do not replace the independent saved grade.

The runnable examples are `tests/fixtures/session.ts`, `tests/fixtures/promptfoo-provider.ts` and `tests/fixtures/promptfoo-run.mjs`. After a root build, run `pnpm --filter @fatcat/eval test`, or just `pnpm --filter @fatcat/eval exec node --test dist/tests/promptfoo.test.js`. The latter uses the actual pinned promptfoo loader in an isolated process, temporary config directory and sanitized environment, blocking outbound fetch/HTTP/socket access. In 0.124.1, disabling telemetry still attempts one disabled-notice request; the fixture rejects that request locally and asserts this known behavior. No telemetry or model request is sent.

Baseline and candidate are separate complete experiment configurations. Changing prompt/policy/model identity changes their digests and output directories; do not relabel old records or substitute a historical Git SHA for the running checkout. The injected comparison test verifies this separation, not a model-quality improvement. The promptfoo fixture repeats two samples twice, with one deliberately wrong answer: four executions complete, two grades pass, and the independent summary reports 0.5. Test outputs are temporary and removed after assertions.

## Harbor result evidence

`readHarborTrialResult(root, { source, sha256 })` reads an existing local trial `result.json` through the confined artifact reader, checks its SHA-256 and decodes strict UTF-8 JSON. `parseHarborTrialResult(value)` supplies the pure projection for callers that already hold decoded JSON. Neither function starts Harbor, imports promptfoo, creates a Session, loads credentials, writes files or contacts a service. The original artifact remains authoritative; retain it with the verifier logs and Agent trajectory.

The projection follows the single-step `TrialResult`, `VerifierResult` and `AgentContext` source in Harbor 0.23.0, inspected at [commit fd0049126a060f930372f9b0b0aa330caf1f19e5](https://github.com/harbor-framework/harbor/tree/fd0049126a060f930372f9b0b0aa330caf1f19e5/src/harbor/models). It reads the fields it consumes and permits additive upstream metadata; this is not a full Harbor schema validator or a claim of compatibility with other releases. Nonempty `step_results` are rejected, rather than silently losing per-step failures. Job aggregates are not trial records. The local reader retains the existing 1 MiB artifact limit.

- `scoring: scored` requires recorded start/end times for the trial, Agent execution and verifier, a non-null Agent result, numeric rewards and no trial exception. Zero and fractional rewards stay unchanged. This status does not prove that Fatcat or a real model ran: an Oracle or injected trial can also be scored. KAI-44 acceptance additionally requires the fixed task/configuration, actual model-execution evidence, logs and trajectory.
- Missing execution or verification evidence is `incomplete`, never a fabricated zero reward. An exception produces `error` while preserving any rewards and usage already recorded. Malformed numeric values, identities and timing fail validation. No pass threshold, exact-match grade, local success rate or official aggregate is inferred.
- Input tokens already include cached tokens. Independently unknown input, output, cache and cost values stay null; the adapter invents neither request counts nor a price/billing basis. Harbor's raw cost field is retained as upstream data, not converted to the stricter `EvalResult.cost` contract.
- Config, environment values and tracebacks are not copied into the projection. This is not general redaction: exception messages and the original artifacts can contain task content. Hashes bind bytes, not source authenticity or compliance with benchmark rules.

The synthetic builder `tests/fixtures/harbor.ts` and `tests/harbor-result.test.ts` verify these distinctions, hash mismatch, malformed inputs and read-only evidence handling. After building, run `pnpm --filter @fatcat/eval exec node --test dist/tests/harbor-result.test.js`. These tests do not produce an official score.

## Current Linear milestones

Scope reconciled with Linear on 2026-10-22:

| Issue | Current responsibility and dependency |
| --- | --- |
| [KAI-18](https://linear.app/kailtian/issue/KAI-18) | Run one Terminal-Bench 4.0 task using Fatcat + DeepSeek V4.1 Flash and retain official scoring; a valid zero reward can complete the integration milestone |
| [KAI-21](https://linear.app/kailtian/issue/KAI-21), [KAI-22](https://linear.app/kailtian/issue/KAI-22) | Existing protocol and injected Session/promptfoo foundation; KAI-22 is implemented and published for review; it is not a mandatory Harbor layer |
| [KAI-43](https://linear.app/kailtian/issue/KAI-43) | Pinned Linux task environment and injected headless core execution; implementation and reruns are described below |
| [KAI-44](https://linear.app/kailtian/issue/KAI-44) | After KAI-43, integrate directly with Harbor, inject the model first, then run one explicitly authorized DeepSeek attempt and preserve official evidence |

KAI-43 adds Linux execution and the injected headless entry. KAI-44's installed Harbor agent and real-model scoring remain separate. Native Windows remains the product path; Linux/container support is an additional evaluation path. No TUI/Web UI port, new sandbox, local replacement task set or Context/RAG redesign belongs in this increment.

## KAI-43 execution plan

The environment-first plan has been implemented through the injected Linux execution stage. The preceding KAI-22/planning increment is commit `89b8581c0ae87b91a69016cb1d28e99277e532c0`, published in [PR #115](https://github.com/KailBug/fatcat/pull/115). The current increment is an additional evaluation path, not a Linux UI port. Installation, exact commands, failures and verification limits are maintained in [Linux evaluation](../GUIDES/LINUX_EVAL.md).

### Source audit and intended boundaries

- `runtime/src/tools/shell/bash.ts` implements foreground Linux execution with the existing ProcessResult contract; `tools/shell.ts` selects Bash or native PowerShell. Permission leases, cwd rechecks, journals and cleanup lockout remain in the shared shell tool. Platform guidance is accurate; Bash never enters the PowerShell risk classifier. See [Tools](TOOLS.md#shell-execution-boundaries) and [Permissions](PERMISSIONS.md#free-to-go-command-risk-classification).
- The inspected pi reference remains commit `3daa20280f6a7c7cbe0935680c9a38fdc3863005`, specifically `core/tools/bash.ts` and `utils/shell.ts`. Immediate group SIGKILL replaces the proposed delayed TERM escalation, to terminate TERM-ignoring children while avoiding delayed signals after leader exit. Container teardown remains necessary for escaped descendants; no sandbox claim is made.
- `eval/src/headless.ts` uses public `createAgent`, `createTools`, `SessionManager` and `SessionStore` exports directly in the actual task cwd. It neither copies the task nor changes Session/Loop/Context/model SDK ownership. KAI-22's fixture workspace, promptfoo provider and exact-match grader are unchanged.
- `eval/scripts/headless.ts` owns argv, trusted injection-module loading and SIGINT/SIGTERM. The library import starts no host work. A fresh private Session directory lives outside the task; evidence is written after settlement and before removing only that owned directory. The task workspace is never deleted by this driver.

### Ordered implementation and acceptance

1. **Pinned official source and resources.** `harbor/terminal-bench-4.0.json` records release `terminal-bench/terminal-bench@4.0.0`, commit `452bf305c6daa62fc59061d22133a7cbc7c1572e`, the single CPU task `terminal-bench/sound-change-cascade`, all 18 source-file SHA-256 hashes and its resource/time limits. The release contains 66 task manifests; only this task was selected. Local Docker was checked before execution; no cloud resources were launched.
2. **Official Oracle control.** Harbor 0.23.0, concurrency one, one attempt and zero automatic retries produced reward `1.0` and seven passing official verifier tests. `harbor/oracle-control.json` records the trial, source/image identities and artifact hashes. Earlier environment failures were retained. This is an Oracle score, not a Fatcat score.
3. **Runtime and headless execution.** Windows retains PowerShell; Linux uses Bash. The headless entry requires absolute task/result paths, explicit file and shell policy, instruction text, 1–32 requests and 100–120000 ms. Only read-only/deny and workspace-write with allow/deny are accepted; missing or interactive approval fails explicitly. Requests/deadlines are enforced by the existing runtime and cancellation signal, including delegated work.
4. **Real injected acceptance.** In the official task environment with Node 24.19.0 and frozen pnpm 11.21.0 dependencies, file tools and Bash ran in `/app`. Read/create/edit/reread, nonzero exit, timeout, output overflow, denial, case-distinct files, spaces, symlink escape, early abort, parent/child cancellation and durable interruption/cleanup were checked. The executable's SIGTERM path also settled with exit 130. Runs used `--network none`; no provider request or official Fatcat score was produced.
5. **Windows regression and handoff.** Keep fresh typecheck, boundary/build and offline-suite evidence alongside Linux logs. CLI/TUI/Web UI entry/input code is unchanged. KAI-44 owns the installed Harbor agent, official verifier wiring for Fatcat and separately authorized live DeepSeek execution; KAI-43 does not silently advance into those activities.

### Proposed rerun commands and exit criteria

The former templates are now concrete commands in [Linux evaluation](../GUIDES/LINUX_EVAL.md). `scripts/verify-linux.ts` runs the real task-directory integration; product process/path contracts remain under verification, and eval orchestration contracts remain under eval. Neither development package imports the other. The independent Python requirements snapshot is for the Windows Harbor controller; all Fatcat JavaScript dependencies continue to use pnpm and the existing lockfile.

Headless evidence includes prepared request bodies (without SDK headers), events, current Session history/interruption, usage consumption, writes, command outcomes, platform and temporary-state location. `result.json` records final status and cleanup. These are injected integration artifacts, not generic EvalResult grades or Harbor rewards. They can contain task text and require private handling. Publication or disk failure can leave partial artifacts/private state; there is no overwrite, automatic resume, sandbox, token/money cap or whole-experiment budget. KAI-23 remains responsible for the broader budget contract.

KAI-44 must run the actual authorized model, finish official verification, and retain numeric reward (including a valid zero), trajectory and available usage/cost. An environment failure, missing execution or absent grading cannot satisfy that milestone. Source/image/version identities and every failed attempt must remain distinguishable from the selected task's valid result.

## Future work boundaries

[KAI-23](https://linear.app/kailtian/issue/KAI-23) completes whole-run budgets, retry/delegation usage and cost coverage before scaling real evaluations. [KAI-24](https://linear.app/kailtian/issue/KAI-24) (LongMemEval), [KAI-25](https://linear.app/kailtian/issue/KAI-25) (BEIR), [KAI-26](https://linear.app/kailtian/issue/KAI-26) (Context comparisons) and [KAI-27](https://linear.app/kailtian/issue/KAI-27) (commands/CI/results) are deferred and do not block the first official task. [KAI-42](https://linear.app/kailtian/issue/KAI-42) considers Langfuse only if local evidence is insufficient; no automatic uploads. [KAI-52](https://linear.app/kailtian/issue/KAI-52) follows the single-task path and full budget controls: check GPU/resources, run a small authorized cost pilot, then evaluate the fixed official set and compare model-plus-agent combinations with the matching Codex leaderboard entry. A subset is never a full leaderboard result.

Offline tests neither read `.env`, call real models nor authorize spending. Native Windows interaction, Linux task execution, public benchmarks and real-model quality require separate acceptance; injected success demonstrates integration contracts only. Current token, money and whole-experiment budgets remain declarative as described above; adding a result reader does not enforce them.
