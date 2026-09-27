---
name: verification-handoff
description: Verify a local code change and hand it back with accurate test outcomes, remaining limitations, and Fatcat execution evidence.
---

# Verification Handoff

Choose a check that exercises the changed behavior using the target project's existing commands. For a reported bug, reproduce the failure first when useful and feasible. After implementation, inspect actual results and resolve failures within scope. Repeat a check after later changes that affect what it tested; do not substitute an earlier turn's success for current verification.

A successful `write` confirms a recorded file operation, not correctness. A `shell` tool returning `ok: true` only means it returned an execution result. Inspect `status`, `exitCode`, `truncated`, and `cleanup`; a timeout, output limit, cancellation, nonzero exit, or unconfirmed cleanup cannot establish a clean passed check. Exit zero still requires understanding what command ran and what its output demonstrated. If authorization is denied or a necessary environment is missing, report that specific verification gap without inventing a pass.

Fatcat emits a per-turn execution report for the user after the turn ends. It is not automatically included in your model context and there is no dedicated report-reading tool. Base your answer on the tool results and execution records actually available to you. If a report is supplied, interpret `answered` as an answer being produced and `taskVerification: not_assessed` as no automatic task certification. A `laterWriteAttempt` flag means a subsequent recorded write attempt occurred; its absence does not prove files stayed unchanged, since shell and external edits are not tracked that way.

Hand back the changed behavior, relevant files, checks actually run and their outcomes, and any remaining limitation. Keep inspection, simulated tests, and live service checks distinct. Do not claim a hash comparison, independent review, or full test suite unless performed. Token usage and request counts need observed statistics; unknown or partial usage is not zero and does not establish a cost saving.
