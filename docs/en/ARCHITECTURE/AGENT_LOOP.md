# Agent Loop: assembly, requests and termination

English | [简体中文](../../zh-CN/ARCHITECTURE/AGENT_LOOP.md)

[Architecture](README.md)

Loop executes one user turn, preserves associations between model messages and tool results, and enforces request allowances and cancellation. It does not select sessions, save disk records or own interfaces or individual tools' execution rules.

## Module responsibilities

| Source | Responsibility |
| --- | --- |
| `packages/runtime/src/agent.ts` | workspaceAgentFactory prepares workspace resources; createAgent assembles parent/child Models, Tools, Skills, dynamic guidance and actual Session identity |
| `packages/runtime/src/loop.ts` | runAgentTurn requests models on a history copy, executes tools sequentially and emits events; runAgent supplies single-call execution |
| `packages/runtime/src/system-prompt.ts` | Shared systemPrompt, delegation/automation/material guidance and pure workspace/permission formatting |
| `packages/runtime/src/model-types.ts`, `model.ts`, `model-adapters/chat-completions.ts`, `model-usage.ts` | Internal message contracts, SDK boundary, response validation, safe errors and usage observations; see [Providers](PROVIDERS.md) |
| `packages/runtime/src/errors.ts` | Stable HarnessError codes and cancellation checks |
| `packages/cli/src/cli.ts`, `scripts/start.ts` | Startup options/entry selection and invocation-directory restoration; see [Commands](../REFERENCE/COMMANDS.md) |

[Session](SESSION.md) owns commits and recovery; [Context](CONTEXT.md) owns request omission and compaction; [Tools](TOOLS.md) owns tool execution.

## Agent assembly boundaries

`packages/runtime/src/agent.ts` owns assembly. CLI, TUI and Web UI prepare workspace resources through `@fatcat/runtime/agent`. `createAgent` and `workspaceAgentFactory` retain their argument/return contracts. Neither the old workspace-agent module nor former root src runtime paths provide compatibility forwarding.

- **Workspace resources.** Each workspaceAgentFactory caches base Tools by canonical directory, with case-insensitive Windows keys, preserving permission callbacks and journals. It caches only after successful construction. Every selection rediscovers Skills and assembles an Agent. The cache holds no session-bound tools, models, attachment/Memory accessors or active Session.
- **Parent/child assembly.** createAgent wraps base tools with attachment access, Memory reads and Skills to form shared capabilities. The child Model uses this set; the parent set additionally gets bounded delegation, automation and available Memory writes. Assembly sends no model request. Summary models are created separately without parent tools or dynamic guidance.
- **Session binding.** forSession rebuilds components from base resources with actual identity and material access, replacing tools/model only if they are still the original assembly results. Caller overrides of tools, models and other Session options remain. Custom models still receive execution identity and available Memory request context. The session layer retains records, selection and persistence.
- **Request guidance.** sharedAgentGuidance reads current permissions per request and only selects/combines guidance. system-prompt.ts formats text, directories and permissions without reading mutable policy or owning Tools. Parent requests add delegation and current-time guidance. bindSessionModel preserves identity/Memory wrapper order. withGuidance modifies only request copies and forwards cancellation, observers and options without rewriting history. Delegation guidance still favors directly handling simple tasks, focused independent subtasks, bounded context, sequential execution and evidence review. Wording changes do not change permissions or budgets; offline checks cannot establish real-model delegation-selection quality.

Keep these three lifecycles distinct in future changes: reusable workspace resources, identity-bound sessions and current-policy requests. Do not put Session state or material authorization in workspace caches or invent configuration/state owners just to split files. Assembly regressions belong in `packages/verification/tests/agent/`; the responsible domains retain cross-session Memory, attachment and workspace-switching contracts.

## Turn flow

1. Copy completed history and append the current user message. Dynamic system, workspace, permission, Skill, Memory, delegation and execution facts enter only the request copy.
2. Construct the model request and measure the full JSON, including tool definitions and provider-specific fields. Try older-read omission on overflow; Session coordinates automatic compaction when eligible.
3. A nonempty final answer without tool calls ends the turn and returns the answer and full messages. A normal return does not mean task acceptance.
4. For tool calls, Model validates call type, nonempty name/ID and argument strings. Loop records the assistant batch, rejects duplicate IDs and executes tools sequentially. Tools parse/validate argument JSON; results append as tool messages under the original IDs.
5. Return observed content at message checkpoints and continue requesting. Storage may use checkpoints to save incomplete attempts; Loop itself performs no file I/O.

Call IDs cannot repeat within one user turn; results cannot attach to other batches. Arguments must be valid objects. Unknown tools and recoverable tool errors return associated results for model correction. Protocol errors, cancellation and unrecoverable model errors stop explicitly; a partial tool batch is not successful history.

## Budgets and failure semantics

Each model attempt consumes the turn request allowance. The final request is reserved for text delivery with tools disabled; a model that still calls tools is stopped. Visual auxiliary requests and automatic summaries consume the owning turn's allowance without bypassing final-delivery reservation. Children have separate narrow allowances; see [Subagent](SUBAGENT.md).

Every request has a deadline and full-body byte limit. SDK automatic retries are disabled; only validated server usage counters are accepted. The byte limit is neither a token limit nor a hard process-memory cap.

Cancellation propagates through Loop, model and tool boundaries. Timeout, iteration exhaustion, protocol errors and cancellation retain observed operations and usage. They do not rerun tools, roll back files or revoke external requests. AgentSession coordinates full-history commits and final event timing so a model answer is not misreported as a saved session.

## Guidance and events

systemPrompt asks the model to inspect relevant code, complete authorized work, report actual checks and respect read-only review requests. It is guidance, not runtime permission enforcement or a correctness guarantee. Current launch rules apply rather than old system messages in restored history.

Model observations include request size, usage, older-read omission and auxiliary request type. Loop adds turn/iteration and parent/child identity; tools supply operation facts. See [Execution reports](EXECUTION_REPORT.md) for aggregation. Ordinary events do not expose keys or raw provider errors; tool bodies may still enter plaintext history.

## Verification and unimplemented scope

Key checks cover multi-tool association, duplicate IDs, invalid arguments, empty responses, final text requests, deadlines, cancellation, budget rejection, retained effects after failure and commit/event ordering. Automated checks use injected models/transports. Historical fixed DeepSeek scenarios covered direct answers, tool cycles and coding tasks, not open-ended task success rates.

Graph execution, parallel tool scheduling, automatic retry transactions, file-restoration checkpoints and answer correctness certification are unimplemented. Concrete execution needs must drive new abstractions.
