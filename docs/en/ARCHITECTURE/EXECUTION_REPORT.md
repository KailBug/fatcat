# Execution reports: turn facts and usage

English | [简体中文](../../zh-CN/ARCHITECTURE/EXECUTION_REPORT.md)

[Architecture](README.md) · [Result review](../GUIDES/CODING.md#review-results-and-recover-from-failures)

createTurnReporter in `packages/runtime/src/execution-report.ts` only consumes and aggregates events. It does not access files, call tools or request models. Reports are observations, not acceptance certificates; taskVerification is currently always not_assessed.

## Event boundaries

Entries create an observer per user turn, forward LoopEvent and emit one execution_report after root completed/stopped. Child termination is forwarded without ending the parent report. CLI/chat write to stderr; TUI/Web UI display it. Reports enter neither model history nor persistent sessions.

Persistent entries use AgentSession/Manager to defer root completion until saving succeeds. A model answer followed by save failure is stopped/SESSION_STORAGE. Failure to record startup can produce a failed report with zero model requests. Programmatic ordinary Loop/Session events retain their in-memory timing semantics.

Automatic compaction belongs to the original turn and only adds activity/request events; manual compaction is a separate operation. Summary and vision requests count toward usage without increasing completed chat turns or posing as chat-context token observations.

## Aggregation definitions

| Field or fact | Meaning and limits |
| --- | --- |
| outcome / stopCode | answered or stopped with root error code; answered does not mean task success |
| modelRequests | Parent/child attempts, including local budget rejection; not actual HTTP count or billing confirmation |
| toolResults | Returned successes/errors; cancellation may leave operation records without result events |
| writes | Latest status, path, hash and size by ID, never inferred from answers |
| commands | Complete exit/cleanup metadata by ID, deduplicating shared journals |
| browserChecks | Status, time, step/diagnostic counts and JSON/PNG paths, without embedded images or page bodies |
| requestBytes | checked/rejected/maxBytes for final request bodies, including attempts still too large after reduction |
| tokenUsage | Valid server counters and request coverage, parent/child separately; unknown is not zero |
| contextReduction | Per-request omissions and byte differences; repeated omissions count repeatedly, not token or cost savings |

Command succeeded requires completed, exitCode=0, no output truncation and cleanup other than unconfirmed. Journal-summary truncation differs from execution collection overflow.

New or changed write_record marks earlier commands/browser checks as laterWriteAttempt, including failed or uncertain writes. Repeated identical records do not trigger it. This cannot detect changes by shell, editors or external processes; false does not prove unchanged files.

## Usage and privacy

Only nonnegative safe-integer token counters passing consistency checks are aggregated. Partial reports mean known subtotals; overflow remains unknown. Usage observed before errors/cancellation remains, without estimating provider charges.

[Providers](PROVIDERS.md) validates cache statistics; TUI calculates coverage and cumulative rates from raw events. Basic report totals do not mix cache fields. Interfaces must not add report totals again and double-count.

Reports exclude command bodies, stdout/stderr, file bodies, task text and model answers. Paths/hashes are still task data; tool results and saved history may contain sensitive content. Metadata reports are not a global redaction system. Crashes, forced termination or throwing event callbacks do not guarantee a final report.

## Verification and unimplemented scope

Check that model claims cannot populate empty journals, denial is not execution, facts survive failure, parent/child records deduplicate, turns stay isolated, missing request/usage values remain missing, truncation/cleanup are accurate and save failure controls final events. Fixed coding scripts independently rerun tests and inspect files; ordinary reports cannot replace them.

There is no journal recovery across restarts, complete binding between file versions and tests, sentence-by-sentence answer certification, Task gates or cost billing. Future acceptance capabilities need independently checkable task outcomes.
