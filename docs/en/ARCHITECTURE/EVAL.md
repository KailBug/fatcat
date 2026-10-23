# Eval: experiment protocol and result statistics

English | [简体中文](../../zh-CN/ARCHITECTURE/EVAL.md)

[Architecture](README.md) · [Checks and evidence requirements](../DEVELOPMENT.md#evaluation-evidence-requirements)

`packages/eval` is an independent development package for experiment definitions, injected Session execution, result records and statistics. It calls runtime's Session, Loop, Context, tools and stores through existing package exports; runtime retains their ownership. Product packages do not depend on it; eval and verification do not depend on each other. The injected headless entry and a narrowly scoped DeepSeek/Harbor live path exist for the pinned Linux task environment. An automated dataset-download manager, whole-experiment budget scheduling and a general experiment CLI remain unimplemented. The live path is retained but paused under the strategy below.

## Current evaluation strategy

As of 2026-10-23, paid real-model evaluation through Harbor is paused because its cost is not affordable for current development. Near-term work measures harness correctness, execution boundaries and diagnosability without real model requests. Routine evaluation has **zero model API spending**; local CPU, storage, electricity and dependency downloads still consume resources. Access to a local model or free API is not a prerequisite for contributing or reviewing changes.

| Layer | Current use | Evidence and limit |
| --- | --- | --- |
| Offline contracts and failure fixtures | Default for affected runtime, product and eval changes | Validate decoding, state transitions, permissions, request accounting, evidence and cleanup with fake credentials and deterministic inputs |
| Injected Session and tool workflows | Default when execution or integration changes | Exercise real Session/Loop/Context, filesystem, shell and persistence with trusted injected responses; use native Windows or Linux checks where the change requires them |
| Local Harbor injection or Oracle control | Targeted checks when the adapter, task environment or official grading integration changes | Retain the installed-agent bridge and official verifier with no real model requests; Docker/images/downloads are additional local dependencies, not requirements for every change |
| Harbor with a real model on Terminal-Bench | Paused; retained for future funded evaluation | Official task-solving quality remains unassessed for new changes until a separately authorized live evaluation is performed |

Use [Development](../DEVELOPMENT.md#evaluation-evidence-requirements) to select checks proportional to the change. Passing fixed fixtures establishes only their contracts. Oracle rewards validate the reference solution/environment; injected rewards validate the scoring connection. Neither is a Fatcat real-model success rate. Historical live results retain their original model, configuration, failures and limitations; they do not validate later changes. Do not interpret synthetic usage, unknown cost or fewer tokens as measured API savings or improved task quality.

### Near-term harness acceptance

The following priorities guide subsequent implementation; this documentation update does not implement new recovery behavior or a general trajectory-replay service. Extend existing tests around observed failures and preserve package ownership: product contracts stay in `packages/verification`, evaluation adapters and result contracts stay in `packages/eval`.

1. **Long-task failures.** Use bounded request/response fixtures to reproduce encoded request overflow, context-limit responses, truncated output and malformed tool calls. Check explicit failure classification, retained execution evidence and cleanup; do not count a shortened or interrupted run as successful task completion.
2. **Execution boundaries.** Inject failures, timeouts and cancellation into parent/delegated work. Check permission decisions, shared request allowances, budget accounting where implemented, child-process settlement and ownership of temporary files. Passing a declared-budget parser does not prove that the budget is enforced.
3. **Tool workflows.** Cover read, edit, execute, inspect and correction sequences with fixed expected artifacts and protected-file checks. Preserve Windows behavior and run Linux-specific process/path checks for affected Linux code. These are development fixtures, not a replacement public benchmark.
4. **Evidence and regression.** Reduce useful historical failures to nonsecret synthetic fixtures or reviewed response sequences. Record the exercised configuration, terminal state, tool results and cleanup outcome. Replaying responses verifies harness behavior under that sequence; it does not simulate new model decisions or prove quality improvements. Restoring a Session must not replay tool effects or old approvals.

Review acceptance consists of the relevant offline/injected checks, actual outcomes and explicit remaining limits. Real-model evaluation is not a routine review prerequisite during this pause. Claims about model quality, general task success rates or better compaction/reasoning remain deferred without corresponding evidence.

### Retained Harbor route and resumption

Keep Harbor as the intended route for future Terminal-Bench evaluation: retain the adapter, task/version pins, official verifier, Linux guide and all recorded controls and failures. Do not substitute fixture scores for official real-model results or remove the integration because paid runs are paused.

Resume only after a new explicit instruction to resume paid evaluation with an agreed scope and spending cap. Recheck model availability, current pricing, task/Harbor versions and enforced request/time/cost limits, then validate the affected offline/injected path before spending. Begin with a bounded official single-task pilot; expand to a declared subset or full set only within a separately justified budget. The previous KAI-44 CNY 10 authorization and any unused balance are not continuing authorization after this pause. Code review, passing tests and retained command examples do not resume paid execution. This is a development policy; no runtime disable switch is introduced here.

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
| `src/headless.ts`, `scripts/headless.ts` | Shared task-directory Session execution and injected entry, explicit limits/policy, durable evidence and executable signal lifecycle |
| `src/deepseek-headless.ts`, `src/deepseek-budget.ts`, `scripts/headless-live.ts` | Retained, paused DeepSeek entry with a dated shared request/CNY gate and temporary credential consumption |
| `harbor/fatcat_agent.py`, `harbor/Dockerfile.bundle` | Harbor 0.23.0 installed-agent bridge and explicit Linux bundle export; injected mode and retained, paused live mode |
| `scripts/verify-harbor.ts` | Check retained official trials and native injected/live evidence without new model calls or regrading |
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

Issue scope reference, reconciled with Linear on 2026-10-22. These dependencies do not override the [current evaluation strategy](#current-evaluation-strategy); the pause changes development priorities, not the historical acceptance criteria or Linear statuses.

| Issue | Current responsibility and dependency |
| --- | --- |
| [KAI-18](https://linear.app/kailtian/issue/KAI-18) | Run one Terminal-Bench 4.0 task using Fatcat + DeepSeek V4.1 Flash and retain official scoring; a valid zero reward can complete the integration milestone |
| [KAI-21](https://linear.app/kailtian/issue/KAI-21), [KAI-22](https://linear.app/kailtian/issue/KAI-22) | Existing protocol and injected Session/promptfoo foundation; KAI-22 is implemented and published for review; it is not a mandatory Harbor layer |
| [KAI-43](https://linear.app/kailtian/issue/KAI-43) | Pinned Linux task environment and injected headless core execution; implementation and reruns are described below |
| [KAI-44](https://linear.app/kailtian/issue/KAI-44) | After KAI-43, integrate directly with Harbor, inject the model first, then run one explicitly authorized DeepSeek attempt and preserve official evidence |

KAI-43 adds Linux execution and the injected headless entry. KAI-44 adds the installed Harbor bridge, injected controls and an explicitly authorized single-task DeepSeek path. Native Windows remains the product path; Linux/container support is an additional evaluation path. No TUI/Web UI port, new sandbox, local replacement task set or Context/RAG redesign belongs in this increment.

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

Headless evidence includes prepared request bodies (without SDK headers), events, current Session history/interruption, usage consumption, writes, command outcomes, platform and temporary-state location. `result.json` records final status and cleanup. Evidence explicitly distinguishes injected and live execution; Harbor owns official rewards. They can contain task text and require private handling. Publication or disk failure can leave partial artifacts/private state; there is no overwrite, automatic resume or sandbox. The live path below has a narrow request/cost gate; KAI-23 remains responsible for the broader experiment budget contract.

KAI-44's live integration acceptance requires actual authorized model execution, normal official verification, and numeric reward (including a valid zero), trajectory and available usage/cost. Its recorded acceptance is described below; this criterion is not an instruction to rerun paid evaluation during the pause. An environment failure, missing execution or absent grading cannot satisfy that milestone. Source/image/version identities and every failed attempt must remain distinguishable from the selected task's valid result.

## Harbor installed-agent injection

`harbor/fatcat_agent.py:FatcatAgent` implements Harbor 0.23.0's `BaseInstalledAgent`. The small Python bridge is required by Harbor's Python integration API; execution, limits, permissions, Session, Loop and Context remain in existing TypeScript modules. It uploads and checks a caller-reviewed Linux bundle, installs outside `/app`, transfers the original instruction as UTF-8 JSON, and launches the existing headless executable with an empty inherited environment. Bundle exports omit `.env` files and Git metadata, including dependency copies. The bundle is trusted executable code, not a sandboxed upload.

Injected mode rejects a model name; both modes reject agent environment overrides. Injected runs require the existing 1–32 request/100–120000 ms bounds and explicit workspace-write/shell-allow policy. The entry settles its own deadline and signal cancellation; an outer Harbor timeout or abrupt host loss can leave incomplete artifacts and relies on Harbor container teardown. The bridge does not replace Harbor's task setup, artifact transfer or separate official verifier. Native `agent/fatcat/evidence.json` retains requests, Session history, tool outcomes and synthetic usage; it is not an ATIF export. Harbor token/cost fields remain null because fixture counters are not provider billing.

`tests/fixtures/harbor-smoke.ts` makes actual read/write/shell calls and writes a deliberately incorrect identity rule plus ordering. The official verifier should return reward 0 with its two exact-match checks failing and five structural/determinism checks passing. This demonstrates scoring integration, not a solved task. `harbor-failure.ts` injects a provider failure; the executable exits nonzero and Harbor must retain an exception. `scripts/verify-harbor.ts` checks these artifacts and writes their hashes, never changes the official tests or computes a substitute reward. Windows offline tests cover the same transport through Session; separate Python tests exercise the pinned bridge without Docker. Commands and current evidence limits are in [Linux evaluation](../GUIDES/LINUX_EVAL.md#harbor-injected-adapter).

## Authorized DeepSeek attempt

**Paused under the [current evaluation strategy](#current-evaluation-strategy).** This section documents the retained implementation and historical evidence, not permission to spend. A new explicit resumption and budget are required; the earlier CNY 10 limit is not an ongoing allowance.

The same bridge accepts explicit `mode=live` with `deepseek/deepseek-flash` and no injected module. `scripts/headless-live.ts` calls the same `runHeadlessSession` and existing model SDK, with high thinking, at most 32 global requests, a 180-second request timeout and 30-minute attempt deadline. The SDK and Harbor do not retry. `src/deepseek-headless.ts` assembles the live profile with a 1 MiB encoded request-body limit; the injected path retains 256 KiB. This is a byte limit, separate from the provider token window. A temporary credential file outside the task/log directories is consumed and removed before Session startup; it is absent from command arguments, environment overrides and retained configuration.

`src/deepseek-budget.ts` wraps all SDK requests, including children and compaction. Before dispatch it reserves the provider's entire 1,048,576-token context at the documented cache-miss peak rate plus the requested output cap (at most 16,384 tokens). It uses integer nanoyuan and refuses dispatch when total retained charges plus the reservation exceed CNY 10. A manually continued authorization must seed `prior_cost_nano_cny` with the sum of all preceding attempt ceilings; a new process does not justify resetting the authorized total. Validated response usage releases only the excess reserve; missing usage, failed responses and timeouts retain it. Cache misses are assumed when cache usage is unknown. Redirects, other endpoints/models, streaming and server-side tools are rejected. This narrow, dated tariff is not a provider-neutral billing engine; the live entry requires its pricing date to cover the run and another date requires a price review.

The ledger records response IDs/model strings, nullable usage, accounting ceilings and stop reasons. The documented model version and pricing source are distinct from the model identity actually returned by the API. Costs use peak CNY rates, so they are conservative estimates rather than an invoice; Harbor USD cost remains null. Complete real token counters populate Harbor usage. `verify-harbor --expect live` requires completed execution, normal official grading, seven finished verifier tests, real response records and a ceiling within the authorized budget. A valid zero is retained; execution failures remain failures.

Recorded acceptance and the longer-attempt failures are maintained in [Linux evaluation](../GUIDES/LINUX_EVAL.md#authorized-live-attempt) and [live control metadata](../../../packages/eval/harbor/live-control.json). Integration acceptance does not imply that Fatcat solved the task or that the broader KAI-23 budget work is complete.

## Future work boundaries

[KAI-23](https://linear.app/kailtian/issue/KAI-23) completes whole-run budgets, retry/delegation usage and cost coverage before scaling real evaluations; its harness accounting can be developed with synthetic responses. [KAI-24](https://linear.app/kailtian/issue/KAI-24) (LongMemEval), [KAI-25](https://linear.app/kailtian/issue/KAI-25) (BEIR), [KAI-26](https://linear.app/kailtian/issue/KAI-26) (Context quality comparisons) and [KAI-27](https://linear.app/kailtian/issue/KAI-27) (quality commands/CI/results) remain deferred and do not block harness reliability work. [KAI-42](https://linear.app/kailtian/issue/KAI-42) considers Langfuse only if local evidence is insufficient; no automatic uploads. [KAI-52](https://linear.app/kailtian/issue/KAI-52) remains a future Harbor/Terminal-Bench route, paused until explicit funded resumption and full budget controls: check GPU/resources, run a small authorized cost pilot, then consider the fixed official set and comparisons with the matching Codex leaderboard entry. A subset is never a full leaderboard result. None of these retained plans resumes paid execution automatically.

Offline tests neither read `.env`, call real models nor authorize spending. Native Windows interaction, Linux task execution, public benchmarks and real-model quality require separate acceptance; injected success demonstrates integration contracts only. Generic experiment budgets remain declarative; the specific DeepSeek attempt gate above does not implement KAI-23 or authorize larger runs.
