# Providers: model protocols and capability boundaries

English | [简体中文](../../zh-CN/ARCHITECTURE/PROVIDERS.md)

[Architecture](README.md) · [Provider configuration](../REFERENCE/CONFIGURATION.md#providers)

Startup configuration supplies defaults and connection snapshots; each session saves model/thinking choices used to construct parent/child Agents, summaries and image adapters. Fixed capabilities, protocol mapping, runtime switching and thinking-history replay are implemented. Web controls call the same contracts; see [Web UI](WEBUI.md). No dynamic registration, routing or failover exists.

## Module responsibilities

| Source | Responsibility |
| --- | --- |
| `packages/runtime/src/providers.ts` | Configuration descriptors, fixed hosts and Qwen workspace endpoints |
| `packages/runtime/src/model-catalog.ts` | Exact capabilities, ModelSelection decoding, identity comparison and capability validation |
| `packages/runtime/src/model-protocol.ts` | Thinking fields, generation reservation and replay by model/purpose |
| `packages/runtime/src/model-connections.ts` | Host credential isolation, public choices and provider/region/workspace resolution |
| `packages/runtime/src/provider-replay.ts` | Replay API/source validation, adapter dispatch and summary stripping |
| `packages/runtime/src/config.ts` | Selected credentials/model/region and shared budgets |
| `packages/runtime/src/model-types.ts` | SDK-independent Message, ToolCall, ModelTurn, Model and observation contracts |
| `packages/runtime/src/model-adapters/chat-completions.ts` | Message/tool encoding, response/call decoding and Chat Completions replay validation |
| `packages/runtime/src/model.ts` | createModel, full request preparation, SDK, deadlines and safe errors |
| `packages/runtime/src/model-usage.ts` | Token/cache validation |
| `packages/runtime/src/documents/vision.ts` | Temporary authorized image requests |
| `packages/webui/src/client/model-controls.ts` | Runtime catalog and consumption/reported/estimated display, without client capacity tables or usage observers |

createDeepSeekModel retains its programmatic compatibility entry. Tests inject transport; production does not expose arbitrary base URLs. Protocol differences stay out of Loop, Session and tools.

## Internal messages and API boundaries

`packages/runtime/src/model-adapters/` organizes message/tool adapters by API, currently only `chat-completions.ts`. `model-types.ts` owns internal types; `model.ts` retains SDK client, transport and deadlines.

Following local pi `3daa20280` message/encoding boundaries, Fatcat defines its own `Message` union: text messages, text/image user content, assistant messages and associated results. assistant `toolCalls` use `{id,name,arguments}`, results use `callId`; `tools/types.ts` owns ToolDefinition name/description/parameters/optional strict. Loop, Skills, Memory, attachments and clients consume these types, never SDK message/tool types. Import from `@fatcat/runtime/model-types`; `model` constructs models without old type re-exports.

arguments remains raw JSON. Tools parse/validate it; malformed JSON remains an associated INVALID_ARGUMENTS result rather than a model protocol failure. Internal images use `{type:"image",url,detail?}`, encoded as image_url. Images remain temporary auxiliary inputs without expanding durable history support.

`ModelTurn` contains only `message`. `AssistantMessage.toolCalls` is the sole call list used by Loop, summaries and image requests.

`AssistantMessage.providerReplay` uses `ProviderReplayData = {api,selection,data}` for provider extras needed on later requests, such as reasoning_content. Only `chat-completions` is supported. provider-replay.ts checks API/source and delegates to decodeChatReplayData for JSON, reasoning and call-ID checks; Session does not interpret private fields. The adapter extracts canonical answers/calls; `data.messageFields` retains remaining message fields and `data.toolFields` retains call/function extras keyed by ID, without duplicated roles, answers, names or arguments. Encoding merges extras back into canonical messages as the sole facts; extras cannot override canonical fields. data is validated private payload, not executable Loop calls. No old-field migration/forwarding, Responses, Anthropic, streaming or dynamic registry was added.

`Model.prepare` returns exact serialized `json` and byte/reduction statistics without SDK body types. Reduction edits internal messages and measures final full JSON through the encoder. Transport/preview share preparation. DeepSeek approximation only interprets known Chat Completions JSON, not future protocols. Session directly saves internal messages in v4 without legacy conversion; see [Session](SESSION.md).

## Request conventions and rationale

Configuration reference owns environment variables/default models/regions. Runtime uses only selected keys, never OPENAI_API_KEY/other-provider fallback or inherited OpenAI organization/project.

The following table describes requests with thinking disabled. Model-specific thinking choices and protocol fields are listed in the capability catalog below.

| Profile | Fixed service | Generation differences |
| --- | --- | --- |
| DeepSeek | https://api.deepseek.com | thinking disabled, max_tokens |
| Kimi | https://api.moonshot.cn/v1 or https://api.moonshot.ai/v1 | thinking disabled, max_completion_tokens |
| MiMo | https://api.xiaomimimo.com/v1 | thinking disabled, max_completion_tokens; Bearer |
| GLM | https://open.bigmodel.cn/api/paas/v4 | max_tokens; thinking disabled only for models that support off |
| Qwen | Existing cn/intl DashScope or workspace regional hosts below | enable_thinking=false; older max_tokens, newer max_completion_tokens + preserve_thinking=false |

All use OpenAI-compatible Chat Completions, Bearer and stream=false. Ordinary nonthinking output caps at 2048; tool choice is auto. Final text uses none on DeepSeek/Kimi/Qwen; MiMo/GLM omit tools/tool_choice because only auto is guaranteed. MiMo also supports api-key headers; Fatcat retains Bearer. Loop refuses over-budget execution even if a provider returns forbidden calls. Providers offer other protocols such as Responses/Anthropic; this implementation adds no adapters/SDKs for them.

Optional QWEN_WORKSPACE_ID accepts one safe DNS label, not arbitrary URLs. It constructs `https://{workspaceId}.{regionHost}.maas.aliyuncs.com/compatible-mode/v1`. Without it cn/intl retain old endpoints; other regions reject missing workspaceId.

| QWEN_REGION | regionHost |
| --- | --- |
| cn | cn-beijing |
| intl | ap-southeast-1 |
| us | us-east-1 |
| eu | eu-central-1 |
| jp | ap-northeast-1 |
| hk | cn-hongkong |

Thinking selection follows the catalog default policy described below, with explicit Config.thinking and saved choices taking precedence. Configurable names do not imply universal compatibility. Construct Qwen fields separately rather than copying other providers' thinking/max_completion_tokens. SDK retries/raw logs are disabled; deadlines and AbortSignal both apply. Truncation, unknown/conflicting finish_reason or invalid calls cannot count as completion.

## Capability catalog and session contract

Phase one defines `ModelSelection = { provider, region, workspaceId?, model, thinking }`. workspaceId identifies Qwen PAYG connections without keys, arbitrary URLs or private provider bodies. Shape/region decoding is separate from thinking capability validation so saved but no-longer-supported choices remain readable. Unknown custom startup models retain compatibility with off only and unknown window/input limits; capabilities are never inferred from name prefixes.

Exact-model entries define protocol, window, input limits, images, default thinking and supported options. thinkingAliases separates aliases from actual levels; chatUnavailableReason records execution restrictions; retirementAt records announced retirement without silent substitution. Returned catalogs are independent copies. Scope is text tool conversations and auxiliary images, not all provider products: no ASR/TTS, Omni audio, Embeddings, hosted third-party models or streaming-only models are implied.

`ModelConnections` keeps configuration in private fields and defaults to explicitly supplied startup credentials. CLI/TUI/Web UI explicitly pass environment for additional providers. Public list contains identity, description, local availability and fixed reasons. available requires credentials and no known chat restriction, not account access or regional availability. Invalid unselected-provider configuration does not break valid startup. resolve strictly matches provider/region/workspaceId and returns independent identity/credentials. Missing/unsupported entries raise MODEL_UNAVAILABLE without key/workspace/region/provider fallback or network probing. Resolution never enters snapshots/logs/browser. [Session](SESSION.md) owns save/activation order.

These mappings are wired into execution and supported by injected-transport offline evidence:

| Exact model | Thinking choices | Enabled fields | Reservation and history |
| --- | --- | --- | --- |
| deepseek-flash (currently V4.1 Flash), deepseek-v4-pro | off/low/medium/high/max/ultra | thinking enabled, reasoning_effort, max_tokens=16384 | medium→high, ultra→max; shared 16384; replay reasoning_content with tools |
| kimi-k2.6 | off/on | thinking enabled, keep=all, max_completion_tokens=16384 | Shared 16384; retain reasoning to align accounting with server retention |
| kimi-k3 | low/high/max, default max, no off | reasoning_effort, max_completion_tokens=16384; no old thinking object | Shared 16384; reconstruct full assistant message |
| kimi-k2.7-code, kimi-k2.7-code-highspeed | on, no off | thinking enabled, keep=all, max_completion_tokens=16384 | Shared 16384; replay thinking |
| MiMo V2.6 Flash/Pro/Pro Ultraspeed, V2.5/Pro | off/on | thinking enabled, max_completion_tokens=16384 | Shared 16384; full thinking replay, especially tool calls |
| glm-5.3 | low/high/max, default max, no off | thinking enabled, clear_thinking=false, reasoning_effort, max_tokens=16384 | Shared 16384; preserve original reasoning_content |
| glm-5.2 | off/high/max, default max | Same enabled fields as GLM 5.3 | Shared 16384; preserve original reasoning_content |
| glm-5.1, glm-5, glm-4.7 | off/on, default on | thinking enabled, clear_thinking=false, max_tokens=16384 | Shared 16384; no reasoning_effort; preserve original reasoning_content |
| qwen3.8-max, qwen3.8-flash | off/low/medium/xhigh; compatible high/max | enable_thinking, preserve_thinking, reasoning_effort, max_completion_tokens=16384 | high/max→xhigh; shared 16384, no simultaneous thinking_budget; replay when enabled |
| qwen3.7-plus | off/on | enable_thinking, preserve_thinking, max_completion_tokens=16384 | Shared 16384 without extra thinking reservation; replay when enabled |
| qwen-plus | off/on | enable_thinking=true, thinking_budget=8192, max_tokens=2048 | Separate thinking/answer reservation, total 10240; no thinking replay |
| qwen3-vl-plus/flash | Current adapter off | enable_thinking=false, max_tokens=2048 | Auxiliary images only, not tool Agents |
| Unknown custom names | off | Existing provider nonthinking fields | No guessed thinking capabilities; reservation semantics unknown |

These caps are Fatcat policy, not provider maximum output. off retains 2048; compaction/document disable thinking when possible, otherwise retain mandatory reasoning within 16384. Auxiliary requests do not change parent choices. K3/K2.7 Agent execution is enabled; K3 full-message reconstruction has offline tool-roundtrip/save/resume evidence, not real-account/service acceptance. Startup model defaults are DeepSeek Flash, Kimi K2.6, MiMo V2.6 Flash, Qwen Plus and GLM 5.3.

Catalog default thinking prefers medium where supported, on for off/on models, otherwise explicit catalog defaults (K3 max, K2.7 Code on). Unknown/unadapted models stay off. This affects new default sessions and direct clients; explicit Config.thinking/saved choices win, with no migration of existing off records. Web offers only enabled thinking levels; see [Web UI](WEBUI.md#model-thinking-and-context-controls).

Replay stores provenance/extras beside canonical assistant data, validating formats/call IDs without another copy of answers/arguments. Merge only when API, provider, region, workspaceId and model match and current protocol permits it. Levels may change within the model, but off strips private history. Cross-model/region/workspace sends only canonical text/tool facts; internal providerReplay never goes directly on the wire. DeepSeek replays with enabled thinking and tool definitions; Kimi/MiMo/GLM/new Qwen follow the table; old Qwen does not. Summaries strip private data. Projection precedes final byte checks/omission without duplicate canonical messages.

ThinkingLevel retains medium/ultra and adds Qwen-native xhigh. It is an application option set, not universal levels. Wire reasoning_effort derives from SDK request types and receives normalized legal values only. The original model.ts TS2375 came from putting ultra in a shared wire union that SDK ReasoningEffort rejects. exactOptionalPropertyTypes appeared in diagnostics but did not justify disabling it or adding casts. Unsupported Kimi/Qwen levels reject explicitly; never guess ultra across providers.

| Model group | Window tokens | Independent input limit off / thinking |
| --- | --- | --- |
| Two current DeepSeek IDs | 1048576 | Unverified |
| Kimi K2.6, K2.7 Code/Highspeed | 262144 | Unverified |
| Kimi K3 | null (official 1M is not assumed to be an exact integer) | Unverified |
| Three MiMo V2.6 IDs | 1048576 | Unverified |
| MiMo V2.5/Pro | null (exact capacity unverified) | Unverified |
| GLM 5.3 / 5.2 | 1048576 | Unverified |
| GLM 5.1 / 5 / 4.7 | 202752 | Unverified |
| Qwen3.8 Max/Flash, 3.7 Plus | 1000000 | 991808 / 983616 |
| Qwen Plus | 1000000 | 997952 / 995904 |
| Qwen3 VL Plus/Flash | 262144 | 260096 / 258048 |

Qwen input limits are separate from windows/output reservations. Use the minimum applicable limit without subtracting the difference twice. Provider parameter combinations may affect limits; capacities guide estimates, not server acceptance. effort is not an extra token budget. null means unverified, never reverse-inferred; bytes and tokens remain separate.

Exact snapshots qwen3.8-max-0902, qwen3.8-max-2026-09-02 and qwen3.7-plus-2026-05-26 inherit verified capabilities but preserve requested IDs. Other suffixes are not guessed. MiMo announced V2.5/Pro retirement at 2026-10-21 10:00 Beijing time; catalog migration notices remain without timed substitution. Ultraspeed requires separate account enablement. Older Kimi K2/K2.5 and Moonshot V1 are not current recommendations.

Protocols were checked on 2026-10-19 against [DeepSeek thinking/history](https://api-docs.deepseek.com/guides/thinking_mode/), [DeepSeek windows](https://api-docs.deepseek.com/api/list-models/), [Kimi API](https://platform.kimi.com/docs/api/chat), [Kimi models](https://platform.kimi.com/docs/models), [K2.6 configuration](https://huggingface.co/moonshotai/Kimi-K2.6/blob/main/generation_config.json), [MiMo thinking](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/other/deep-thinking), [MiMo capacity](https://mimo.mi.com/docs/en-US/tokenplan/integration/openclaw), [Qwen API](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions), [Qwen Plus limits](https://www.alibabacloud.com/help/en/model-studio/qwen-plus) and [nonstreaming thinking](https://help.aliyun.com/zh/model-studio/deep-thinking/). Replay has injected roundtrip/persistence checks, not real model calls; online behavior needs separate acceptance.

purpose=compaction/document is internal and never sent. Auxiliary requests omit tools/tool_choice and reject returned tools. Summaries reuse current models; images contain selected materials/questions, not full conversation history. Full provider JSON, including base64, first passes shared byte budgets.

## Image capabilities

getModelInputCapabilities uses exact names:

| Provider | Image models |
| --- | --- |
| Kimi | kimi-k2.6, kimi-k3, kimi-k2.7-code, kimi-k2.7-code-highspeed |
| MiMo | mimo-v2.6-flash, mimo-v2.6-pro, mimo-v2.6-pro-ultraspeed, mimo-v2.5 |
| Qwen | qwen3.8-max, qwen3.8-flash, qwen3.7-plus and explicit snapshots; qwen3-vl-plus, qwen3-vl-flash |
| DeepSeek | deepseek-flash (V4.1 Flash); V4 Pro remains text-only |

Unknown aliases/date suffixes return DOCUMENT_VISION_UNAVAILABLE before sending, retaining native text reads. All profiles have nativeFileInput=false. Images do not imply native PDF/Office, audio or multimodal retrieval.

Temporary image_url data URLs are not saved. Session retains text/fixed sources, never base64/credentials. No provider switch or hidden vision key occurs. [Documents](DOCUMENTS.md) owns budgets, per-page partial success and caches.

MiMo V2.5 Pro's overview and image guide differ; the specific [image support list](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/multimodal-understanding/image-understanding) does not enable it here. Qwen Coder regional/snapshot tool tables also differ, so it is absent from verified Agent capabilities; the [Coder guide](https://www.alibabacloud.com/help/en/model-studio/qwen-coder) currently recommends newer general models. OpenAI compatibility does not establish tool-loop support everywhere.

## PAYG APIs and subscriptions

Only PAYG APIs are implemented. Subscription keys, model IDs, allowances and endpoints are not interchangeable; no subscription provider/environment variables are added.

| Service | Official entry and distinction |
| --- | --- |
| Kimi Code | [Integration](https://www.kimi.com/code/docs/): domestic OpenAI base https://api.kimi.com/coding/v1, international https://api.kimi.ai/coding/v1; separate membership keys/subscription models, not Moonshot PAYG |
| Qwen Coding Plan | [FAQ](https://help.aliyun.com/zh/model-studio/coding-plan-faq): domestic OpenAI base https://coding.dashscope.aliyuncs.com/v1; international plans have dedicated endpoints; keys are not PAYG keys |
| MiMo Token Plan | [Subscription/integration](https://mimo.mi.com/docs/tokenplan/subscription): console defines dedicated keys/protocol addresses; PAYG profile does not mean plan support |
| DeepSeek | Maintain platform PAYG only, without unverified subscription entries |

The catalog refresh was checked on 2026-10-19. Additional sources: [DeepSeek models](https://api-docs.deepseek.com/api/list-models/), [Kimi K3](https://platform.kimi.com/docs/guide/kimi-k3-quickstart), [K2.7 Code](https://platform.kimi.com/docs/guide/kimi-k2-7-code-quickstart), [MiMo models/retirement](https://mimo.mi.com/docs/quick-start/model), [Qwen3.8 Max](https://help.aliyun.com/zh/model-studio/qwen3-8-max), [Qwen3.8 Flash](https://help.aliyun.com/zh/model-studio/qwen3-8-flash), [Qwen3.7 Plus](https://help.aliyun.com/zh/model-studio/qwen3-7-plus), [VL Plus](https://help.aliyun.com/zh/model-studio/qwen3-vl-plus), [VL Flash](https://help.aliyun.com/zh/model-studio/qwen3-vl-flash). There is no remote catalog auto-update; future changes must check protocols and actual serialized requests.

## GLM standard API scope

GLM uses domestic BigModel standard API credentials only. Coding Plan and Z.ai endpoints/keys are not interchangeable and are not configured by this profile. Startup and public connection selection use the same fixed `cn` identity; no arbitrary host or alternate-key fallback is added. See [configuration](../REFERENCE/CONFIGURATION.md#providers).

Following local pi `3daa20280` (`providers/zai.ts` and `api/openai-completions.ts`), the profile, model catalog and typed generation mapping remain separate. Fatcat retains its existing non-streaming SDK and replay adapter. Enabled thinking sets nested `thinking.clear_thinking=false` and replays unchanged reasoning for the same model. Text-only final requests omit tools/tool_choice because the documented selector only guarantees auto. Compaction disables optional thinking; GLM 5.3 keeps its selected mandatory effort. No GLM image capability is advertised. Unknown model names do not inherit known-model thinking or capacity.

Checked on 2026-10-26 against the official [API introduction](https://docs.bigmodel.cn/cn/api/introduction), [Chat Completions schema](https://docs.bigmodel.cn/api-reference/模型-api/对话补全), [thinking parameters](https://docs.bigmodel.cn/cn/guide/capabilities/thinking), [reasoning replay](https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode) and [model overview](https://docs.bigmodel.cn/cn/guide/start/model-overview). GLM 5.2 exposes the native off/high/max choices rather than compatibility effort aliases.

Window references use the official model configurations' `max_position_embeddings`: [GLM 5.3](https://huggingface.co/zai-org/GLM-5.3/blob/main/config.json) and [5.2](https://huggingface.co/zai-org/GLM-5.2/blob/main/config.json) specify 1048576; [5.1](https://huggingface.co/zai-org/GLM-5.1/blob/main/config.json), [5](https://huggingface.co/zai-org/GLM-5/blob/main/config.json) and [4.7](https://huggingface.co/zai-org/GLM-4.7/blob/main/config.json) specify 202752. These provide exact model-window references alongside the domestic guides' 1M/200K labels; they are not a measured guarantee of endpoint acceptance. Independent API input limits remain null. No matching local tokenizer is supplied, so capacity can be displayed while input usage and remaining headroom stay unknown without an injected matching counter. With a valid estimate, shared output is subtracted once and negative headroom is retained. The normal local byte budget still applies.

Injected SDK tests cover credentials, fixed URL, generation fields, tools, exact prepared/sent bytes, request limits, usage, safe failures, cancellation, timeout, session save/resume and reasoning isolation. Durable regressions also cover capacity boundaries, unknown token counts, switching from DeepSeek to GLM for parent/child/compaction requests, and refusal to execute unexpected tools after the iteration budget is exhausted. GLM evidence is offline only; account access, service acceptance and real task quality require a separately authorized model run. Existing DeepSeek live runners retain their provider guard.

## Usage validation

prompt_tokens, completion_tokens and total_tokens must be consistent nonnegative safe integers. Cache validation independently checks standard cached_tokens and DeepSeek hit/miss against input. Explicit miss can derive missing hit using prompt=hit+miss; conflicting fields make cache unknown while basic usage may remain valid. Missing counters are never zero-filled.

Accumulate valid reports with coverage; overflow stays unknown. Cache rate is total hits/covered input, not average percentages; zero denominator has no rate. Do not infer KV capacity, VRAM, prices or bills. See [Execution reports](EXECUTION_REPORT.md)/[TUI](TUI.md).

Session accounting and ordinary observations remain separate from side-effect-free Model.prepare estimates of effective input; see [Context](CONTEXT.md). Built-in counting is labeled DeepSeek ASCII/Han approximation plus conservative Unicode fallback, so common Chinese punctuation no longer invalidates it. Other models without matched counters remain unknown, without borrowed tokenizers/default network calls. Web ring/summary retain unknowns.

## Maintenance and verification

Check official hosts, auth, tool/nonthinking capabilities, fields, finish reasons and usage when changing profiles. Retain offline actual-SDK-JSON contracts. Fake credentials/injected transport check URL/headers/body, associations, overflow without sending, cancellation, timeout and safe errors. Compatibility labels alone do not justify strict, parallel, temperature or cache fields.

Protocol sources remain [DeepSeek](https://api-docs.deepseek.com/api/create-chat-completion/), [Kimi](https://platform.kimi.com/docs/api/chat), [MiMo](https://mimo.mi.com/docs/en-US/api/chat/openai-api) and [Qwen](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions). These explain implementation choices; future changes require renewed checks and links alone are not online evidence.

Kimi/MiMo/Qwen/GLM evidence is offline. Real vision APIs, account access, chart understanding and transcription quality are unverified. Existing live scripts remain DeepSeek-only and run only on explicit request; adding providers need not make live calls.

Phase-two injected checks cover independent selection, current persistence, save/busy/conflict failure, untrusted history, full K3 reconstruction, cross-model isolation and parent/child/image/summary rebinding after directory changes. Two real-Edge failures were fixture timing: modal entry motion and delayed session focus overriding an early blur. Waiting for actual animation/focus and adding controlled delayed-frame regressions passed while retaining centered-modal/collapse assertions. No real models or native interactive terminal checks ran for that work.

Standalone OCR, Embeddings, audio, streaming and failover are absent. Add narrow adapters for concrete needs, not a speculative plugin framework.
