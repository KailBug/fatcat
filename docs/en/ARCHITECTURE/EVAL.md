# Eval: experiment protocol and result statistics

English | [简体中文](../../zh-CN/ARCHITECTURE/EVAL.md)

[Architecture](README.md) · [Checks and evidence requirements](../DEVELOPMENT.md#evaluation-evidence-requirements)

`packages/eval` is an independent development package for experiment definitions, result records and statistics. It owns no Session, Loop, permissions or persistent sessions. It currently provides offline protocol functions only, without model execution, public-data downloads, budget scheduling or an evaluation CLI. Product packages do not depend on it; eval and verification do not depend on each other.

## Modules and references

| Module | Responsibility |
| --- | --- |
| `src/experiment.ts` | `Experiment`, strict configuration parsing, versioned provenance references and experiment SHA-256 digests |
| `src/result.ts` | `EvalResult`, execution/grading states, usage coverage and JSON serialization/reading |
| `src/summary.ts` | Configuration binding, per-attempt completeness and statistics; JSON-serializable summaries and all records |
| `src/validation.ts` | Shared scalar, object and digest-encoding validation |
| `tests/`, `scripts/test.ts` | Package synthetic data, file round trips, statistics and integration regressions; source-inventory-driven offline entry |

Organization references Maka `packages/eval` experiment/result separation and strict decoding (commit `8686793e5d051018c61e53350e542992d19d5311`); types and explicit functions reference pi `usage-totals.ts` (commit `3daa20280f6a7c7cbe0935680c9a38fdc3863005`). This independent implementation follows Fatcat contracts without importing Maka Harbor, Fleet, proxy networks or retry selection, or adding third-party dependencies.

## Experiment definitions

`schemaVersion` is `fatcat.eval.v1`. Parsers reject missing/extra fields, invalid numbers, duplicate samples and unknown versions, and copy nested data. Experiments contain:

- `id`, complete Git SHA, `dirty` and specific OS/Node/pnpm environment identities.
- `evidence`: `synthetic`, `injected` or `live`; `level`: `contract`, `model_quality` or `task_acceptance`. They are independent: synthetic task-acceptance results remain synthetic evidence.
- Provider, model ID and nonsecret generation parameters. Parameters accept only finite JSON scalars and reject common credential fields. This is not general redaction; callers must not supply real keys, private bodies or complete runtime configuration.
- Data ID/version, manifest provenance and SHA-256. Manifests should locate fixed inputs, reference answers and sample identities. `sampleIds` is the complete declared-version inventory; development/holdout are disjoint subsets, and selection must come from one declared split.
- `coverage`: `subset` or `full`, with `full` allowed only when selection equals all `sampleIds`. This checks consistency with the declared inventory, not agreement with an official benchmark or unchanged official environment. Integrators still verify version, license, full inventory and corpus reductions.
- Separate prompt, policy and grader versions, sources and content SHA-256; repetitions; per-attempt/whole-run request, token, time and optional USD caps. `costUsd: null` means no declared money limit, not free execution.

Sources may be recoverable repository-relative paths or fixed external resources. The parser reads no files, accesses no network and verifies neither Git objects nor actual content. Future execution adapters resolve/verify references, collect actual environment data and keep effective parameters aligned with manifests. Model aliases/services may change; locatable configuration does not guarantee identical output. Formal comparisons first use clean commits. `dirty: true` can record diagnostics, but v1 stores no uncommitted patch or untracked files and cannot claim reproducibility.

`experimentDigest()` SHA-256 hashes the complete parsed result with sorted object keys and declared array order. Results bind both experiment ID and digest. Changes to code, model parameters, samples, prompts, policy, budgets or graders prevent mixing old results.

## Results and grading

Each `fatcat.eval.result.v1` record is located by experiment ID/digest, sample ID and one-based repetition. Repetitions differ from infrastructure retries. v1 accepts one terminal record per planned position without overwrite, retry selection or resume. Execution adapters are unimplemented.

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

## Future work boundaries

KAI-22 integrates real Session/promptfoo; KAI-23 execution budgets/cost collection; KAI-24/25 public samples/grading; KAI-26 actual baselines/paired reports; KAI-27 quality execution/archiving. Current budget fields provide no interception, cancellation or money-limit guarantee. Protocol tests neither read `.env`, launch models nor authorize spending. Native Windows interaction, public benchmarks and real-model quality require separate acceptance.
