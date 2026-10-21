# Context: request projection and bounded compaction

English | [简体中文](../../zh-CN/ARCHITECTURE/CONTEXT.md)

[Architecture](README.md) · [Context operations](../GUIDES/SESSIONS.md#context-management)

Context selects request content without owning original history, files, materials or long-term Memory. Session always retains complete successful history.

## Module responsibilities

| Source | Responsibility |
| --- | --- |
| `packages/runtime/src/context/manager.ts` | CompactionState validation, projectHistory and byte/message statistics |
| `packages/runtime/src/context/request.ts` | Full request measurement/older-read omission, without persistent state/I/O |
| `packages/runtime/src/context/compaction.ts` | Bounded summary planning, chunks and candidates |
| `packages/runtime/src/context/usage.ts` | Current estimates, reported observations, two headroom contracts and pure calculations |
| `packages/runtime/src/context/turn-request.ts`, `model-preparation.ts` | Shared Loop/preview projection and conversion |
| `packages/runtime/src/context/estimate.ts` | Matching local counters, approximations, unknown states and limits |
| `packages/runtime/src/context/accounting.ts` | Accumulation, cache coverage, overflow and persistent observation validation |
| `packages/commands/src/context/commands.ts` | Local statistics and explicit compact |
| `packages/runtime/src/session/session.ts`, `agent-session.ts` | Projection, in-turn recovery and durable summary commits |

## Older-read omission

Model builds full JSON with system/dynamic guidance, tools, protocol fields and history, then prepareRequestContext measures UTF-8 bytes. Within-budget requests pass unchanged; overflow replaces eligible results oldest-first and remeasures before transport.

Protect the current and latest complete turn. Only older successful file/directory/search/document results correctly associated with read calls are eligible. Errors, unknown protocols, write/shell/delegate_task results, user requests and assistant messages remain. kind=skill bodies are excluded; referenced resources may follow ordinary reads.

Replacements use kind=context_omitted and retain original kind, fixed path and parserVersion, requiring rereads when needed. Arguments/call IDs remain; repeated IDs across turns associate within local batches. Markers mean an original successful call, not retained content or unchanged files. Replace only when bytes shrink. Remaining overflow raises MODEL_CONTEXT_LIMIT before transport.

Only request copies change; every request prepares again. No summary, automatic file read or disk-history deletion occurs. Rereads use current permissions/version checks.

## Manual and automatic compact

Manual compact lossily summarizes older complete turns while retaining the latest complete turn and all originals. Before sending, chunk planning checks feasibility within min(maxIterations, 8) summary requests; focus and bodies are bounded. Summaries use no tools and are not new user turns.

Automatic compact tries once only after omission still causes local MODEL_CONTEXT_LIMIT. Rejected attempts, summaries and continuation share the original allowance, reserving one ordinary continuation request. Current messages/results/latest complete turn are not replayed. Insufficient allowance, no eligible history, summary failure or another overflow stops. HTTP errors, server token limits and timeouts do not trigger recovery.

Persist summaries before resuming Loop; later failure/cancellation retains them. Summary failure/cancellation/commit conflict retains the old projection. [Session](SESSION.md) defines manual claims, automatic attempt reuse, pendingSettlement and cross-process exclusion.

## Usage and provenance

/context counts full/projected conversation JSON bytes/messages, excluding guidance, tools and journals. It is neither final request size nor token count. model_input observes actual bytes; context_reduction reports before/after sizes and omissions without bodies, paths or queries.

History bytes include providerReplay. Final requests first project provider assistant data for current identity, strip internal provenance, measure actual JSON and omit old reads; sizes need not match. Summary chunks serialize canonical text/tool facts only, excluding private thinking/opaque replay to prevent cross-model transfer. [Providers](PROVIDERS.md) owns thinking replay.

Summary/vision count toward requests/usage without replacing ordinary main-request observations. Compaction invalidates occupancy; historical observations retain identity/time. Repeated omission counts repeatedly, not directly as cost savings. Web uses runtime snapshots; compaction does not clear reported history.

Attachments retain immutable sources/parser versions; unknown versions cannot redirect. Memory reassembles each request; old summaries are not authoritative. See [Memory](MEMORY.md).

## Verification and unimplemented scope

### Current input estimation: implemented phase-three runtime API

`SessionManager.contextUsage` separates `consumption`, `estimate` and `lastReportedInput`; injected Agents without usable identity return null. `previewContext(signal?)` remeasures current sources; `invalidateContext()` lets hosts invalidate after permission/configuration changes. Getters do no disk/network work. Preview updates only process-local cache/contextRevision, not persistent records/history/consumption.

`ContextEstimate` (estimated) carries full identity, contextRevision, time and ready/pending/unknown. Only ready has values, method, approximate flag and limits; pending/unknown have null/reasons. `ContextObservation` (reported) carries requestId, identity and observedAt for an ordinary parent response. Latest-response missing/invalid usage sets inputTokens=null/reason instead of retaining earlier numbers. No response means no new observation. Delegated/summary/image responses do not replace it. Later compaction/switching cannot rewrite identity or make it a current estimate.

`ContextUsageSnapshot` exposes consumption, estimate, observation, capacity, window remaining and input headroom. contextHeadroom accepts current estimates only, never cumulative/last-reported input. Window remaining is W−E; input headroom is min(W−R, I)−E. R comes from actual generation policy, I from a verified independent input limit; without I use W−R. Unknown capacity/count/reservation semantics yield null. Keep negative raw headroom; clamp only graphics to 0–100%. Cache hits are not subtracted from E.

Preview reuses `prepareTurnMessages`/real `Model.prepare`: system/budget guidance, current Memory, identity, permissions/time, recovery/directory notices, tools, compacted history, latest answer/results, journals, thinking replay and omission follow one chain. `mapModelMessages` shares generation/preparation conversions. Missing prepare returns unknown, never calls generation. Preview defaults to the next ordinary turn's first request and accepts no draft. Without an unsent user message it protects the latest complete turn; execution protects current plus latest complete turn. Draft bytes may cause additional omission, so this is current-context preview, not a promise for arbitrary future requests.

Preparation returns exact serialized `json`, not SDK body types. Omission edits internal messages and each candidate is remeasured through the encoder with tools, wrappers and permitted thinking, never against smaller internal JSON. Local counters receive the same preparation; DeepSeek approximation understands only the known format.

Preview does not generate, call tools.forTurn/execute, compact or save. Memory uses its preview entry with actual identity and metadata → Memory locks, creating only temporary synchronization locks, never missing stores, journal recovery or stale-lock cleanup. Pending recovery, changed scopes and read errors make estimates unknown, not unauthorized/partial. Counters run after obtaining request copies and outside locks. CANCELLED propagates normally.

Prefer host-injected local `inputCounter` exactly matching model/request format; it forbids network, generation, tools and writes. No default network counting or mismatched tokenizer is used. Catalog DeepSeek text uses [official rough guidance](https://api-docs.deepseek.com/quick_start/token_usage/): ASCII×0.3 + Han×0.6, rounded up over final messages/tools JSON character proxies. Other Unicode (Chinese punctuation, emoji, combining text) uses a conservative local fallback of about one token per UTF-8 byte instead of making everything unknown. This is Fatcat approximation, not an official Chinese coefficient or exact tokenizer, and may overestimate. method/limitations disclose error; approximate stays true. JSON bytes are not exact tokens; templates, code, tools and thinking can differ. Structured multimodal, unknown models and other providers without matched counters remain unknown. Official tokenizer examples do not establish exact current API/template matching, so no dependency/default download was added. Count actual replayed thinking, without adding output-billed thinking again.

Dynamic guidance samples preview time; future results, time, automation and compaction are unpredictable and disclosed. Byte-overflow requests may still yield limited estimates without sending/compacting. Local UTF-8 budgets and token limits remain independent.

Refresh binds active runtime, complete selection and monotonic contextRevision. Answer/tool checkpoints, compact commits, model/thinking changes, switching/resume and host management set pending. During execution/compaction, remain pending until stable explicit previewContext; partial tool batches are not complete requests. Late old-runtime/revision/preview results cannot overwrite new state. Explicit previews reread Memory, permissions and guidance. Cache does not watch external changes; hosts request fresh previews on display/refresh. Auxiliary summaries/results enter subsequent estimates. Old observations remain identified history; capacities/headroom use new-model estimates only.

`consumption` aggregates valid response usage from ordinary, delegated, summary and image requests, including valid usage before failure/truncation. requests counts attempts including local rejects; reportedRequests counts valid reports. Their difference is uncovered attempts, not necessarily billing. tokens=null means no reports/overflow; overflow remains unknown, valid zero remains zero. cache aggregates requests/inputTokens/hitTokens for valid cache reports only, using the same covered hit/input set. Zero denominator/overflow has no rate. completeHistory=false marks unfillable history; true still needs report coverage and is not a complete bill.

`cacheHitRate` is runtime-derived 0–1 over covered consumption, not separately persisted or ring occupancy. [DeepSeek usage](https://api-docs.deepseek.com/api/create-chat-completion/) defines prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens; cached_tokens and hit are the same quantity. Explicit miss can derive missing hit as prompt−miss. All present counters must be valid/consistent; missing is not zero. Absent counters, conflicts or zero denominator yield no rate. Use Σhit/Σinput: inputs 100/300 and hits 0/240 yield 60%, not average 40%. [Cache guidance](https://api-docs.deepseek.com/guides/kv_cache/) describes prefix reuse without guaranteed hits. Hits remain input and cannot be deducted from context.

**Display and Codex comparison:** [Codex status-line documentation](https://learn.chatgpt.com/docs/developer-commands?surface=cli#configure-footer-items-with-statusline) separates context statistics and token counters; [OpenAI context windows](https://developers.openai.com/api/docs/guides/conversation-state#managing-the-context-window) cover a request's input/output/reasoning, not session accumulation. Public docs do not specify the desktop ring's exact baseline deduction; this implementation claims no exact clone or fixed token baseline. Empty unstarted sessions show Not started / capacity and — percentage. Prepared system/tool overhead stays in estimates, not zeroed because home has no messages. Started conversations show full input estimates; history-bearing forks are not empty.

Consumption/observations save as optional fields through existing checkpoints, settlement and compact commits; estimates do not persist. Usage cannot be inferred from old history or recovered if not persisted before a crash. Forks create new billing attribution, copying history/model but resetting accumulation/observations. Resume/model switches retain accumulation; compaction never lowers it.

`context-preview.test.ts` and rebinding workflows check independent accumulation/occupancy; answers/results/Memory/recovery in fresh previews; lower projection with increased usage after compaction; switching/resume invalidation; stale async rejection; draft exclusion; unknown/overflow not zero; preparation matching SDK bodies; no send/execute/save/recovery during preview; auxiliary consumption and returned content entering later estimates. No ring-driven auto-compaction was added.

**Phase-four Web integration is implemented:** model menu, discrete slider, estimated ring and compact summary use runtime snapshots. Summary shows estimate/capacity, percentage and bar; full consumption, observations, both headrooms and limitations remain in runtime data. [Web UI](WEBUI.md#model-thinking-and-context-controls) defines refresh, local preview on opening, stale-selection rejection and browser coverage. Real-model counting accuracy/summary quality remain unverified; UI does not remove approximation/unknown limits.

### Existing request and compaction checks

Check exact JSON bytes, protected scope, IDs, document versions, immutable input, cancellation, storage conflicts, continuation allowance, no replay, resume/fork and entry display. verify:context's fixed three-turn case checks omission/rereading, not real-model long-task summary quality.

Full history still consumes memory/disk and the Session 64 MiB limit. JSON serialization is not a hard memory cap. Oversized recent turns, journals or tool definitions can fill requests. Summaries are lossy; proactive token-threshold compaction, server-overflow recovery, semantic selection, retrieval and full hierarchical context are absent.
