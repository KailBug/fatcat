# Eval: experiment protocol and result statistics

English | [简体中文](../../zh-CN/ARCHITECTURE/EVAL.md)

[Architecture](README.md) · [Checks and evidence requirements](../DEVELOPMENT.md#evaluation-evidence-requirements)

`packages/eval` is an independent development package for experiment definitions, injected Session execution, result records and statistics. It calls runtime's Session, Loop, Context, tools and stores through existing package exports; runtime retains their ownership. Product packages do not depend on it; eval and verification do not depend on each other. Live model execution, public-data downloads, whole-experiment budget scheduling and an evaluation CLI remain unimplemented.

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
| [KAI-21](https://linear.app/kailtian/issue/KAI-21), [KAI-22](https://linear.app/kailtian/issue/KAI-22) | Existing protocol and injected Session/promptfoo foundation; KAI-22 is locally implemented and awaits review/publication, not a mandatory Harbor layer |
| [KAI-43](https://linear.app/kailtian/issue/KAI-43) | Linux task environment and headless core execution; the following plan is unimplemented |
| [KAI-44](https://linear.app/kailtian/issue/KAI-44) | After KAI-43, integrate directly with Harbor, inject the model first, then run one explicitly authorized DeepSeek attempt and preserve official evidence |

The current code addition is only the offline Harbor result reader above. It does not complete KAI-43 or KAI-44. Native Windows remains the product path; Linux/container support is an additional evaluation path. No TUI/Web UI port, new sandbox, local replacement task set or Context/RAG redesign belongs in this increment.

## KAI-43 execution plan

This section is a proposal, not implemented Linux support or a record of successful execution. Plan against the current checkout, including the uncommitted KAI-22 work. Before later implementation, review that work and capture the actual code commit; a dirty checkout is diagnostic evidence only.

### Source audit and intended boundaries

| Current source or behavior | Planned change and owner |
| --- | --- |
| `runtime/src/tools/shell.ts` rejects non-Windows platforms and describes PowerShell | Runtime selects a concrete platform executor and accurate tool description; preserve shell authorization, operation locks, cwd recheck, command journal and cleanup lockout |
| `runtime/src/permissions/process.ts` encodes PowerShell, filters Windows environment variables and uses `taskkill` | Keep the Windows path; add a Bash executor with the same `ProcessResult` contract, explicit environment allowlist, output cap, deadlines and bounded process-group cancellation |
| `runtime/src/system-prompt.ts` states that shell means PowerShell; `permissions/command-risk.ts` classifies PowerShell syntax | Supply platform-accurate guidance. Do not reuse PowerShell risk classification for Bash or silently make Free to go auto-approve Bash. The first headless entry uses an explicit bounded task policy; unsupported approval requests fail without waiting for a terminal |
| `permissions/workspace.ts` applies ordinary portable-name/link checks; `agent.ts` and `session/record.ts` fold case only on Windows | Verify Linux case sensitivity, absolute task cwd, traversal, symlinks and file identity. Keep Windows rules; change only restrictions proven incompatible with the chosen task. No host/container path translation inside file tools |
| KAI-22 `session-runner.ts` creates a temporary fixture workspace, denies shell and uses exact-match answers | Preserve this fixture runner. A separate eval headless driver will call public runtime exports in Harbor's actual task cwd, with private temporary Session storage outside task inputs; it must not copy the task into another workspace |
| Runtime owns Session, Loop, Context, model SDK and delegation | Reuse `createAgent`/`SessionManager`/`SessionStore` and their cancellation/budget contracts. Keep benchmark selection, installation, logging and Harbor glue in eval; product regressions stay in verification, with no mutual development-package imports |

Before coding, review pi's `core/tools/bash.ts`, `utils/shell.ts` and explicit SDK assembly at commit `3daa20280f6a7c7cbe0935680c9a38fdc3863005`. Prefer concrete functions and dependencies, preserve Fatcat contracts, and avoid a general executor plugin system. A process group is a cleanup mechanism, not a sandbox: escaped descendants need Harbor environment teardown, and unconfirmed cleanup must remain visible.

### Ordered implementation and acceptance

1. **Freeze the official environment before porting.** Use dataset `terminal-bench/terminal-bench@4.0.0`. Start evaluation of Harbor at the inspected 0.23.0 source revision; record the installed package/revision and resolved dependency lock, rather than assuming it supports the chosen task. Read the official manifest and one task's configuration, environment, reference solution and verifier. Select exactly one CPU, single-step task; record its exact name/revision/checksum, image digest, CPU/RAM/disk, network needs and timeouts. The exact CPU task and image are deliberately pending this inspection; no task has been downloaded or certified by this plan. Check the complete manifest before describing subset/full coverage.
2. **Resolve resources, then establish Oracle evidence.** Before installation or execution, confirm local Docker availability/resources or an explicitly capped cloud choice and costs. Preserve native Windows development without requiring WSL/Docker for ordinary use. Run the pinned task's official Oracle and verifier once, concurrency one and retries zero. Save configuration, reward, verifier logs and environment identity. Stop and diagnose environment/verifier failures or an unexpected Oracle result before attributing anything to Fatcat. The full benchmark includes GPU tasks; one CPU selection does not validate full-suite infrastructure.
3. **Implement the minimal runtime platform support.** Add Bash execution and platform guidance in runtime; keep the Windows executor and policy semantics. Launch foreground Bash without user profiles or interactive stdin, sanitize environment, propagate exit status, cap output and handle spawn failure, timeout and cancellation. Send termination to the owned process group, escalate after a bounded grace period, await stream/process settlement and report unconfirmed cleanup honestly. Keep file and shell operations inside the same task environment and cwd. Audit child-process entry/resources and dependency installation on Linux; do not change the model SDK solely for this evaluation.
4. **Add the eval headless entry with injected execution first.** Accept explicit task cwd, instruction input, result directory, permission policy and request/deadline limits. Imports have no host effects. Assemble a real isolated Session and the existing model adapter with an injected transport; no promptfoo or answer grader is involved. Signal handlers belong to the entry; forward abort, await Session/tool settlement, write observed requests/history/usage and then clean only owned session resources. Never delete Harbor's task workspace. Keep verifier/reference files out of model inputs; missing approval/configuration fails explicitly. Apply the same permissions/cancellation to delegated work.
5. **Verify both operating systems and document reruns.** In the real Linux task container, the injected model must read, create, edit and reread a file, execute Bash against that same file, report a nonzero command, and cancel a long-running command with a child. Also check timeout, output overflow, denied operations, case-distinct paths, symlink escape, paths with spaces and already-aborted input. Verify parent/child termination, durable interrupted evidence and absence of owned temporary state after settlement. Run Windows typecheck, boundaries and the full offline suite; rerun injected Windows terminal checks if entry/input/lifecycle code changes. Save commands and fresh logs separately from Linux and model-quality evidence.
6. **Hand off the pinned task to KAI-44.** Prefer a Harbor installed agent so Fatcat and all tools run inside the task environment. Harbor owns environment setup/teardown and the official verifier. A thin Python integration may be needed by Harbor's installed-agent API; it must not reimplement Session/Loop or introduce a second TypeScript model client. Its exact packaging and runtime export needs are reviewed against real consumers during KAI-44. First use injection; only then request the concrete single-task/single-attempt authorization, request/time limits and API/cloud allowance for `deepseek-flash`. Record actual model version, thinking settings, date and code/task identities, not just the changing alias. Missing model execution or missing official grading cannot satisfy acceptance.

### Proposed rerun commands and exit criteria

The commands below are preparation templates for the later authorized environment run, not commands executed by this change. Python/uv belongs to the external Harbor harness; all Fatcat JavaScript dependencies continue to use pnpm. Replace placeholders only after checking the pinned release's CLI and selecting the task; use the approved cloud environment instead of Docker only when that choice has been made.

```text
uv tool install "harbor==0.23.0"
harbor --version
harbor run --help
harbor run -d terminal-bench/terminal-bench@4.0.0 -i "<EXACT_CPU_TASK_NAME>" -l 1 -a oracle -e docker -k 1 -n 1 -r 0 -o "<LOCAL_RESULTS>" --job-name kai43-oracle
pnpm install --frozen-lockfile
pnpm --filter @fatcat/runtime --filter @fatcat/eval -r build
pnpm run typecheck
pnpm test
```

Inspect and save the resolved Harbor config before executing; require exactly the intended one task. No `--upload`, full benchmark, real model or cloud launch is authorized by this plan. Add the final headless/injected invocation once its entry exists, and rerun it in the task container. Do not present a proposed filename or placeholder as an existing runnable command. Dependency installation failure or an unavailable immutable task/version is a preparation blocker, not permission to silently switch to another benchmark release.

KAI-43 is complete only with a pinned CPU task and environment, successful Oracle/verifier control, real injected read/write/Bash/cancellation evidence in that environment, passing Windows regression checks and reproducible installation/rerun instructions. None of those Linux/environment acceptance conditions is claimed here. KAI-44 separately requires real authorized model execution, normally finished official verification, numeric reward (including zero), logs/trajectory and available usage/cost. Keep every attempt and failure; report only the selected task's result.

References: [Terminal-Bench running instructions](https://www.tbench.ai/run), [Harbor custom agents](https://docs.harborframework.com/agents/custom-agents), [Harbor job commands](https://docs.harborframework.com/jobs/run-a-job), [task configuration](https://docs.harborframework.com/tasks/configuration). References were checked on 2026-10-22; recheck the pinned implementation before execution.

## Future work boundaries

[KAI-23](https://linear.app/kailtian/issue/KAI-23) completes whole-run budgets, retry/delegation usage and cost coverage before scaling real evaluations. [KAI-24](https://linear.app/kailtian/issue/KAI-24) (LongMemEval), [KAI-25](https://linear.app/kailtian/issue/KAI-25) (BEIR), [KAI-26](https://linear.app/kailtian/issue/KAI-26) (Context comparisons) and [KAI-27](https://linear.app/kailtian/issue/KAI-27) (commands/CI/results) are deferred and do not block the first official task. [KAI-42](https://linear.app/kailtian/issue/KAI-42) considers Langfuse only if local evidence is insufficient; no automatic uploads. [KAI-52](https://linear.app/kailtian/issue/KAI-52) follows the single-task path and full budget controls: check GPU/resources, run a small authorized cost pilot, then evaluate the fixed official set and compare model-plus-agent combinations with the matching Codex leaderboard entry. A subset is never a full leaderboard result.

Offline tests neither read `.env`, call real models nor authorize spending. Native Windows interaction, Linux task execution, public benchmarks and real-model quality require separate acceptance; injected success demonstrates integration contracts only. Current token, money and whole-experiment budgets remain declarative as described above; adding a result reader does not enforce them.
