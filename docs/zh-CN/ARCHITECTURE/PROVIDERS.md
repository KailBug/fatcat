

<a id="providers-model-protocols-and-capability-boundaries"></a>

# Providers：模型协议与能力边界

[English](../../en/ARCHITECTURE/PROVIDERS.md) | 简体中文

[架构总览](README.md) · [供应商配置](../REFERENCE/CONFIGURATION.md#providers)

配置在启动时提供默认供应商及连接快照；会话保存自己的模型与思考选择，父子 Agent、摘要及图片适配从同一选择构造。固定能力目录、协议映射、runtime 会话切换和思考历史回传已实现。Web 模型菜单、思考滑条及切换路由调用同一 runtime 契约，详见 [Web UI](WEBUI.md)。没有动态注册、路由或故障转移。

<a id="module-responsibilities"></a>

## 模块职责

| 源码 | 职责 |
| --- | --- |
| `packages/runtime/src/providers.ts` | 供应商配置描述、固定服务域名及 Qwen 业务空间 endpoint |
| `packages/runtime/src/model-catalog.ts` | 精确模型能力、ModelSelection 解码、模型身份比较与能力校验 |
| `packages/runtime/src/model-protocol.ts` | 按模型和请求目的映射思考参数、生成预留与历史回传规则 |
| `packages/runtime/src/model-connections.ts` | 主机侧凭据隔离、公开选择目录及按供应商/区域/业务空间解析凭据 |
| `packages/runtime/src/provider-replay.ts` | 回传数据的 API 标识与来源校验、分派给对应适配器及摘要剥离 |
| `packages/runtime/src/config.ts` | 所选凭据/模型/区域与共享预算校验 |
| `packages/runtime/src/model-types.ts` | 自有 Message、ToolCall、ModelTurn、Model 及观察事件契约，不导入模型 SDK |
| `packages/runtime/src/model-adapters/chat-completions.ts` | 内部消息/工具编码、响应与工具调用解码、Chat Completions 回传消息校验 |
| `packages/runtime/src/model.ts` | createModel、完整请求准备、SDK、期限和安全错误 |
| `packages/runtime/src/model-usage.ts` | token 与缓存计数合法性 |
| `packages/runtime/src/documents/vision.ts` | 已获准图片的临时辅助请求 |
| `packages/webui/src/client/model-controls.ts` | 展示 runtime 模型目录与消费/实测/估算快照，不在客户端维护容量表或用量观察器 |

原 createDeepSeekModel 保留程序化兼容入口。注入 transport 用于测试，生产不开放任意 base URL；模型协议差异不散入 Loop、Session 或各工具。

<a id="internal-messages-and-api-boundaries"></a>

## 内部消息与 API 边界

`packages/runtime/src/model-adapters/` 按 API 组织消息与工具格式适配器，当前只有 `chat-completions.ts`。内部类型由 `model-types.ts` 定义，SDK 客户端、请求发送和超时处理仍由 `model.ts` 持有。

参考本地 pi `3daa20280` 的自有消息类型与 API 编码边界，Fatcat 使用独立 `Message` 联合类型：文字消息、带 text/image 内容的用户消息、assistant 消息和关联工具结果。assistant 的 `toolCalls` 使用 `{id,name,arguments}`，工具结果使用 `callId`；工具定义由 `tools/types.ts` 的 `ToolDefinition` 持有 name、description、parameters 和可选 strict。Loop、Skills、Memory、附件与客户端只消费这些类型，不导入 SDK 消息或工具类型。类型直接从 `@fatcat/runtime/model-types` 导入，`model` 只提供模型构造，不保留旧类型转导出。

arguments 仍为原始 JSON 字符串：工具层继续负责 JSON 解析和参数校验，非法 JSON 仍成为关联的 INVALID_ARGUMENTS 工具结果，不提前升级为模型协议失败。图片在内部表示为 `{type:"image",url,detail?}`，编码器转成现有 image_url；图片仍只用于临时辅助请求，不扩大持久历史支持范围。

`ModelTurn` 只包含 `message`；工具调用只保存在 `AssistantMessage.toolCalls`，Loop 从该消息读取并执行，摘要和图片辅助请求也检查同一字段，不维护第二份调用列表。

`AssistantMessage.providerReplay` 使用 `ProviderReplayData = {api,selection,data}`，管理模型返回、后续请求可能还需要带回去的附加信息，例如 `reasoning_content`。当前 API 标识只有 `chat-completions`。`provider-replay.ts` 校验 API 标识和来源选择，并交给 `model-adapters/chat-completions.ts` 的 `decodeChatReplayData` 检查 JSON、推理字段及工具附加数据的调用 ID 关联；Session 只调用通用入口，不解释 API 私有字段。适配器收到响应时，将回答和工具调用解析为内部消息，`data.messageFields` 只保存剩余消息字段，`data.toolFields` 按调用 ID 保存调用及 function 对象的附加字段，不重复保存角色、回答、工具名称或参数。发送时以内部消息为唯一事实来源，将这些附加字段合回对应位置；附加数据不得覆盖规范字段。`data` 是受校验的 API 私有数据，不是 Loop 可执行的调用。没有旧字段迁移或转导出模块；当前仍只有 Chat Completions 接入，没有新增 Responses、Anthropic、流式事件或动态协议注册器。

`Model.prepare` 返回确切序列化请求 `json` 和字节/裁剪统计，不暴露 SDK body 类型。请求裁剪操作内部消息，并用当前编码器测量最终完整 JSON；实际发送与预览共用该准备过程。DeepSeek 本地近似仍只解释已知 Chat Completions JSON，不能把这个近似套用到未来协议。Session 直接保存内部消息，当前只支持 v4，不维护旧会话格式转换；见 [Session](SESSION.md)。

<a id="request-conventions-and-rationale"></a>

## 请求约定与设计理由

环境变量、默认模型及区域选择集中在配置参考。运行时仅使用所选 Key，不回退 OPENAI_API_KEY 或其他供应商，不继承 OpenAI organization/project。

下表描述关闭思考时的请求；各型号的思考选项及协议字段见下文能力目录。

| Profile | 固定服务地址 | 生成参数差异 |
| --- | --- | --- |
| DeepSeek | https://api.deepseek.com | thinking disabled，max_tokens |
| Kimi | https://api.moonshot.cn/v1 或 https://api.moonshot.ai/v1 | thinking disabled，max_completion_tokens |
| MiMo | https://api.xiaomimimo.com/v1 | thinking disabled，max_completion_tokens；使用 Bearer |
| GLM | https://open.bigmodel.cn/api/paas/v4 | max_tokens；仅对支持 off 的型号禁用思考 |
| Qwen | 原 cn/intl DashScope 地址，或业务空间区域域名（下表） | enable_thinking=false；旧版 max_tokens，新版 max_completion_tokens + preserve_thinking=false |

共同使用 OpenAI-compatible Chat Completions、Bearer 认证与 stream=false，普通非思考输出上限 2048；普通工具选择 auto。文字收尾时 DeepSeek/Kimi/Qwen 使用 none，MiMo/GLM 省略 tools/tool_choice，因为其协议只保证 auto。MiMo 同时支持 api-key 头，Fatcat 继续采用 Bearer。即便服务返回违规工具，Loop 仍拒绝超出额度执行。供应商另有 Responses/Anthropic 等接入协议，本轮不新增适配或 SDK。

Qwen 的可选 QWEN_WORKSPACE_ID 只允许安全的单个 DNS label；不接受任意 URL。存在该字段时拼接 `https://{workspaceId}.{regionHost}.maas.aliyuncs.com/compatible-mode/v1`，缺省时 cn/intl 保留旧 endpoint，其他区域拒绝缺少 workspaceId 的配置。

| QWEN_REGION | regionHost |
| --- | --- |
| cn | cn-beijing |
| intl | ap-southeast-1 |
| us | us-east-1 |
| eu | eu-central-1 |
| jp | ap-northeast-1 |
| hk | cn-hongkong |

思考选择遵循下文的目录默认策略，显式 Config.thinking 和已保存的会话选择优先；会话切换可以显式改变有效档位。可配置模型名不代表任意模型都兼容。Qwen 参数单独构造，不能把其他家的 thinking/max_completion_tokens 原样复制。SDK 禁自动重试、关闭原始日志，期限与外部 AbortSignal 共同控制；响应截断、未知/矛盾 finish_reason、非法工具结构不得当成完成。

<a id="capability-catalog-and-session-contract"></a>

## 能力目录与会话接入契约

第一阶段实现 `ModelSelection = { provider, region, workspaceId?, model, thinking }`。workspaceId 仅用于 Qwen 按量 API 的连接身份，不含 Key、任意 URL 或供应商私有正文。解码检查形状和合法区域，能力校验另行检查思考档位；这两个操作分开，为后续恢复已保存但当前能力不再支持的设置保留读取路径。未知自定义模型保留启动兼容路径，只声明 off，窗口和输入上限未知，不按名称前缀继承能力。

目录按精确型号维护协议种类、窗口、输入限制、图片、默认思考与支持选项。thinkingAliases 明确区分兼容别名和真实档位；chatUnavailableReason 表示当前执行限制；retirementAt 记录已公告的下线时间，不隐式替换模型。返回目录是独立副本。目录面向 Fatcat 的文本工具会话与图片辅助请求，不是厂商全部产品目录；ASR/TTS、Omni 音频、Embedding、托管的第三方模型、需独立流式协议的型号不混入当前执行能力。

`ModelConnections` 用私有字段持有配置快照，默认只包含显式传入的启动凭据；CLI、TUI、Web UI 启动入口显式传入环境以配置其他供应商。公开 list 只返回身份、描述、本地可用性与固定原因。available 要求有凭据且没有已知的主会话执行限制，不保证服务端账户权限或该区域供应该型号。未选供应商配置错误不会破坏有效的启动配置。resolve 严格匹配 provider/region/workspaceId，返回独立身份和凭据；缺失或未支持时报 MODEL_UNAVAILABLE，不回退其他 Key、业务空间、区域或供应商，不探测网络。resolve 结果不写入快照、日志或浏览器。保存与激活顺序见 [Session](SESSION.md)。

以下协议映射已接入会话执行路径，证据来自注入传输的离线验证：

| 精确模型 | 思考选择 | 思考开启时的参数 | 生成预留与历史规则 |
| --- | --- | --- | --- |
| deepseek-flash（现为 V4.1 Flash）、deepseek-v4-pro | off/low/medium/high/max/ultra | thinking enabled、reasoning_effort、max_tokens=16384 | medium→high，ultra→max；共用 16384；含 tools 时回传 reasoning_content |
| kimi-k2.6 | off/on | thinking enabled、keep=all、max_completion_tokens=16384 | 共用 16384；保留思考历史，避免计量与服务端默认删除规则不一致 |
| kimi-k3 | low/high/max，默认 max，无 off | reasoning_effort、max_completion_tokens=16384；不发送旧 thinking 对象 | 共用 16384；回传完整 assistant message |
| kimi-k2.7-code、kimi-k2.7-code-highspeed | on，无 off | thinking enabled、keep=all、max_completion_tokens=16384 | 共用 16384；回传思考历史 |
| MiMo V2.6 Flash/Pro/Pro Ultraspeed、V2.5/Pro | off/on | thinking enabled、max_completion_tokens=16384 | 共用 16384；完整回传思考历史，特别是工具调用 |
| glm-5.3 | low/high/max，默认 max，不支持 off | thinking enabled、clear_thinking=false、reasoning_effort、max_tokens=16384 | 共用 16384；原样回传 reasoning_content |
| glm-5.2 | off/high/max，默认 max | 开启时与 GLM 5.3 字段相同 | 共用 16384；原样回传 reasoning_content |
| glm-5.1、glm-5、glm-4.7 | off/on，默认 on | thinking enabled、clear_thinking=false、max_tokens=16384 | 共用 16384；不发送 reasoning_effort；原样回传 reasoning_content |
| qwen3.8-max、qwen3.8-flash | off/low/medium/xhigh；兼容 high/max | enable_thinking、preserve_thinking、reasoning_effort、max_completion_tokens=16384 | high/max→xhigh；共用 16384，不同时发送 thinking_budget；开启时回传历史 |
| qwen3.7-plus | off/on | enable_thinking、preserve_thinking、max_completion_tokens=16384 | 共用 16384，不另加思考预留；开启时回传历史 |
| qwen-plus | off/on | enable_thinking=true、thinking_budget=8192、max_tokens=2048 | 思考与回答分别预留，总计 10240；不回传思考历史 |
| qwen3-vl-plus/flash | 当前适配 off | enable_thinking=false、max_tokens=2048 | 仅接入辅助图片请求，不用于工具 Agent |
| 未知自定义名称 | off | 保留原供应商非思考字段 | 不猜测额外思考能力，预留语义未知 |

这些上限是 Fatcat 的显式策略，不是供应商最大输出容量。off 保持 2048；compaction/document 在模型支持时关思考，否则保留强制思考并使用包含推理的 16384。辅助请求不修改父选择。K3/K2.7 普通 Agent 请求已开放，K3 完整消息经过工具往返、保存和恢复的离线回传验证；不等于真实账户与模型服务验收。默认启动型号为 DeepSeek Flash、Kimi K2.6、MiMo V2.6 Flash、Qwen Plus 和 GLM 5.3。

共享目录的默认思考策略为：该型号支持 medium 时优先 medium；仅支持 off/on 的型号默认 on；其他采用目录内明确默认档位（K3 为 max、K2.7 Code 为 on）；未知或未接入思考的型号仍为 off。这影响使用启动默认的新会话和直接模型客户端，显式 Config.thinking 及保存的会话选择仍优先，不迁移已有 off 记录。Web 选择器只提供该型号已开启的思考档位，详见 [Web UI](WEBUI.md#model-thinking-and-context-controls)。

思考响应在规范助手消息旁保存 providerReplay 来源与厂商附加字段，读取时校验附加数据的格式及工具调用 ID 关联，不保存或核对第二份回答和工具参数。只有 API 标识以及 provider、region、workspaceId、model 全部匹配且当前协议允许回传时才将附加字段合回规范消息；思考档位可以在同一模型内改变，但 off 会剥离私有历史。跨模型、跨区域和跨业务空间只发送规范文本与工具事实，内部 providerReplay 永不直接上网。DeepSeek 在启用思考且请求带工具定义时回传；Kimi/MiMo/GLM/新版 Qwen 按上表处理，旧 Qwen 不回传。摘要序列化也剥离私有数据。该投影先于最终 JSON 字节检查和旧读裁剪，不重复加入规范消息。

ThinkingLevel 保留 medium/ultra，增加 Qwen 原生 xhigh；它是应用层选项集合，不是所有模型通用的档位。wire reasoning_effort 从 SDK 的请求类型派生，只写入归一化后的合法值。model.ts 原 TS2375 的根因是把 ultra 放入所有供应商共用的 wire 联合类型，赋给 SDK 不接受 ultra 的 ReasoningEffort；exactOptionalPropertyTypes 出现在诊断中，但不是关闭该检查或加类型断言的理由。Kimi/Qwen 不接受的档位显式拒绝，不跨供应商猜测 ultra 的含义。

| 模型组 | 窗口 token | 独立输入上限 off / thinking |
| --- | --- | --- |
| DeepSeek 两个当前 ID | 1048576 | 未核定 |
| Kimi K2.6、K2.7 Code/Highspeed | 262144 | 未核定 |
| Kimi K3 | null（官方写 1M，未据该缩写猜测精确整数） | 未核定 |
| MiMo V2.6 三个 ID | 1048576 | 未核定 |
| MiMo V2.5/Pro | null（保留精确窗口未核定） | 未核定 |
| GLM 5.3 / 5.2 | 1048576 | 未核定 |
| GLM 5.1 / 5 / 4.7 | 202752 | 未核定 |
| Qwen3.8 Max/Flash、3.7 Plus | 1000000 | 991808 / 983616 |
| Qwen Plus | 1000000 | 997952 / 995904 |
| Qwen3 VL Plus/Flash | 262144 | 260096 / 258048 |

Qwen 独立输入限制与窗口、输出预留分开；计算取可用限制的最小值，不能把限制差额再扣一次。厂商提示参数组合可影响限额，容量用于参考和估算，不代替真实服务端验证。effort 不是额外 token 预算。null 表示未核定，不通过差值反推；字节上限继续与 token 上限分开。

精确快照 qwen3.8-max-0902、qwen3.8-max-2026-09-02、qwen3.7-plus-2026-05-26 可继承已核对的能力，但请求保留用户指定 ID。其他后缀不猜测。MiMo V2.5/Pro 已公告于 2026-10-21 10:00（北京时间）下线，目录保留迁移提示信息；不会按时偷偷替换模型。Ultraspeed 需要厂商单独开放账户权限。Kimi 旧 K2/K2.5、Moonshot V1 不列为当前推荐型号。

协议来源于 2026-10-19 核对的 [DeepSeek 思考与历史](https://api-docs.deepseek.com/guides/thinking_mode/)、[DeepSeek 模型窗口](https://api-docs.deepseek.com/api/list-models/)、[Kimi API](https://platform.kimi.com/docs/api/chat)、[Kimi 模型](https://platform.kimi.com/docs/models)、[Kimi K2.6 配置](https://huggingface.co/moonshotai/Kimi-K2.6/blob/main/generation_config.json)、[MiMo 思考](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/other/deep-thinking)、[MiMo 容量](https://mimo.mi.com/docs/en-US/tokenplan/integration/openclaw)、[Qwen API](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)、[Qwen Plus 输入限制](https://www.alibabacloud.com/help/en/model-studio/qwen-plus)及[非流式思考说明](https://help.aliyun.com/zh/model-studio/deep-thinking/)。历史回传已通过注入模型的工具往返及持久化检查；未调用真实模型，线上行为仍须另行验收。

purpose=compaction/document 是内部选项，不发送给供应商；这些辅助请求均省略 tools/tool_choice并拒绝返回工具。摘要复用当前模型，图像请求只含所选材料与问题，不承接完整会话历史。完整厂商 JSON（包括 base64）先通过共同字节预算。

<a id="image-capabilities"></a>

## 图片能力

当前 getModelInputCapabilities 使用精确名称白名单：

| 供应商 | 图片模型 |
| --- | --- |
| Kimi | kimi-k2.6、kimi-k3、kimi-k2.7-code、kimi-k2.7-code-highspeed |
| MiMo | mimo-v2.6-flash、mimo-v2.6-pro、mimo-v2.6-pro-ultraspeed、mimo-v2.5 |
| Qwen | qwen3.8-max、qwen3.8-flash、qwen3.7-plus 及明确记录的快照；qwen3-vl-plus、qwen3-vl-flash |
| DeepSeek | deepseek-flash（V4.1 Flash）；V4 Pro 仍为文本 |

未知别名/日期后缀不猜测支持，发送前返回 DOCUMENT_VISION_UNAVAILABLE，保留原生文本读取。所有 profile 的 nativeFileInput 均为 false；图片适配不代表 PDF/Office 原生输入、音频或多模态检索。

图片仅构造临时 image_url data URL，Session 保存文字和固定来源，不保存 base64 或凭据。不自动切换供应商，也不增加隐藏视觉 Key。请求预算、逐页部分成功与缓存归 [Documents](DOCUMENTS.md)。

MiMo V2.5 Pro 的模型总览与图片指南存在描述差异；按具体 [图片指南](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/multimodal-understanding/image-understanding) 的支持清单，暂不开放 V2.5 Pro 图片输入。Qwen Coder 的不同区域、快照的工具能力表也不一致，尚未加入经过验证的 Agent 能力目录；[官方 Coder 指南](https://www.alibabacloud.com/help/en/model-studio/qwen-coder) 当前建议使用新通用型号。不根据“兼容 OpenAI”标签推断所有接口都能执行工具循环。

<a id="payg-apis-and-subscriptions"></a>

## 按量 API 与订阅入口

本轮只实现按量 API。订阅 Key、专用模型 ID、额度和端点不混用，不新增订阅 provider 或环境变量。

| 服务 | 官方入口与区别 |
| --- | --- |
| Kimi Code | [接入说明](https://www.kimi.com/code/docs/)：国内 OpenAI base 为 https://api.kimi.com/coding/v1，海外为 https://api.kimi.ai/coding/v1；使用独立会员 Key 与订阅模型 ID，非 Moonshot 按量平台 |
| Qwen Coding Plan | [官方说明](https://help.aliyun.com/zh/model-studio/coding-plan-faq)：国内 OpenAI base 为 https://coding.dashscope.aliyuncs.com/v1；国际套餐使用专属国际端点。Key 与按量 API 不互通 |
| MiMo Token Plan | [订阅与接入说明](https://mimo.mi.com/docs/tokenplan/subscription)：订阅专用 Key 和协议地址以控制台为准，不能把按量 API profile 当作已接入套餐 |
| DeepSeek | 本轮维护开放平台按量 API，不新增未经核定的订阅入口 |

本轮目录刷新核对日期为 2026-10-19。除上面的既有协议来源，新增型号与限制参见 [DeepSeek 模型列表](https://api-docs.deepseek.com/api/list-models/)、[Kimi K3](https://platform.kimi.com/docs/guide/kimi-k3-quickstart)、[Kimi K2.7 Code](https://platform.kimi.com/docs/guide/kimi-k2-7-code-quickstart)、[MiMo 模型及下线说明](https://mimo.mi.com/docs/quick-start/model)、[Qwen3.8 Max](https://help.aliyun.com/zh/model-studio/qwen3-8-max)、[Qwen3.8 Flash](https://help.aliyun.com/zh/model-studio/qwen3-8-flash)、[Qwen3.7 Plus](https://help.aliyun.com/zh/model-studio/qwen3-7-plus)、[Qwen VL Plus](https://help.aliyun.com/zh/model-studio/qwen3-vl-plus)、[Qwen VL Flash](https://help.aliyun.com/zh/model-studio/qwen3-vl-flash)。模型目录没有远程自动更新；未来更新必须核对具体协议和实际序列化请求。

<a id="glm-standard-api-scope"></a>

## GLM 标准 API 范围

GLM 仅使用智谱国内 BigModel 标准 API 凭据。Coding Plan、Z.ai 的端点和密钥不可混用，本配置不接入这些服务。启动与公开连接选择共用固定的 `cn` 身份，不新增任意地址或其他密钥回退。见[配置参考](../REFERENCE/CONFIGURATION.md#providers)。

参考本地 pi `3daa20280` 的 `providers/zai.ts` 和 `api/openai-completions.ts`，配置描述、模型目录与类型化生成参数映射保持分离。Fatcat 复用已有非流式 SDK 与回放适配器。启用思考时设置嵌套的 `thinking.clear_thinking=false`，同模型原样回传推理内容。文字收尾省略 tools/tool_choice，因为文档仅保证 auto。压缩请求关闭可选思考；GLM 5.3 保留选定的强制思考档位。不声明 GLM 图片能力，未知模型名不继承已知型号的思考能力或容量。

于 2026-10-26 核对官方 [API 简介](https://docs.bigmodel.cn/cn/api/introduction)、[对话补全结构](https://docs.bigmodel.cn/api-reference/模型-api/对话补全)、[思考参数](https://docs.bigmodel.cn/cn/guide/capabilities/thinking)、[思考回放](https://docs.bigmodel.cn/cn/guide/capabilities/thinking-mode)和[模型概览](https://docs.bigmodel.cn/cn/guide/start/model-overview)。GLM 5.2 仅公开原生 off/high/max 选项，不增加兼容 effort 别名。

窗口参考值采用官方模型配置的 `max_position_embeddings`：[GLM 5.3](https://huggingface.co/zai-org/GLM-5.3/blob/main/config.json) 和 [5.2](https://huggingface.co/zai-org/GLM-5.2/blob/main/config.json) 为 1048576；[5.1](https://huggingface.co/zai-org/GLM-5.1/blob/main/config.json)、[5](https://huggingface.co/zai-org/GLM-5/blob/main/config.json) 和 [4.7](https://huggingface.co/zai-org/GLM-4.7/blob/main/config.json) 为 202752。这些精确模型窗口值与国内指南的 1M/200K 标注对应，不构成端点接受能力的实测保证。独立 API 输入上限仍为 null。未提供匹配的本地 tokenizer，因此可以显示容量，但没有注入匹配计数器时，输入用量与剩余空间仍未知。存在有效估算时，共用输出只扣除一次，并保留负数余量。仍执行本地字节预算。

注入 SDK 测试覆盖凭据、固定地址、生成字段、工具、预览与发送的精确字节、请求限制、用量、安全错误、取消、超时、会话保存/恢复和推理隔离。固化回归还覆盖容量边界、token 计数未知、从 DeepSeek 切换到 GLM 后的父/子/压缩请求绑定，以及迭代预算耗尽后拒绝执行意外工具调用。GLM 证据仅为离线验证；账号权限、服务端接受情况及真实任务质量需另行授权模型调用。已有 DeepSeek live 脚本保留供应商限制。

<a id="usage-validation"></a>

## 用量校验

prompt_tokens、completion_tokens、total_tokens 必须为非负安全整数且相加一致。缓存独立校验标准 cached_tokens 和 DeepSeek hit/miss 字段，不能超过相应输入；显式 miss 可按官方 prompt=hit+miss 恒等式补出缺失 hit，多字段冲突时缓存未知但基础用量可仍有效。没有计数时不补零。

缺失不是零，累计只包含合法报告并保留覆盖数量，溢出保持未知。缓存率按有效缓存请求的总命中/同批输入计算，不平均百分比；零分母不显示比例。不能推算 KV 容量、显存、价格或账单。统计消费边界见 [执行报告](EXECUTION_REPORT.md)和 [TUI](TUI.md)。

Session 保留自己的累计消费与普通请求实测观察，并通过无副作用的 Model.prepare 另行预览当前有效输入；这些数据及计量限制见 [Context](CONTEXT.md)。当前内置计量为标注近似的 DeepSeek ASCII/Han 字符代理加其他 Unicode 保守后备估算，常见中文标点不会使计数失效；其余模型无匹配本地计数器时未知，不套用另一家的 tokenizer、不增加默认网络调用。Web 圆环和摘要使用这些快照，未知保持未知。

<a id="maintenance-and-verification"></a>

## 维护与验证要求

修改 profile 时核对官方地址、认证、工具/非思考能力、请求字段、停止原因和用量，保留实际 SDK JSON 的离线合约测试。使用假凭据及注入传输检查 URL/头/正文、工具关联、超限不传输、取消、超时与错误脱敏；不凭兼容标签添加 strict、并行、温度或缓存字段。

当前协议依据保留为：[DeepSeek](https://api-docs.deepseek.com/api/create-chat-completion/)、[Kimi](https://platform.kimi.com/docs/api/chat)、[MiMo](https://mimo.mi.com/docs/en-US/api/chat/openai-api)、[Qwen](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)。这是实现选择的来源，后续修改仍需重新核对，不能据链接存在宣称已在线验证。

Kimi/MiMo/Qwen/GLM 的现有证据为离线合约；视觉也未调用真实 API，账号可用性、图表理解和转写质量未验收。已有 live 脚本保持 DeepSeek 专用范围，仅在明确请求时运行。新增供应商不必默认产生真实调用。

第二阶段的注入检查覆盖会话独立选择、当前格式持久化、保存失败/忙碌/并发冲突、不可信历史、完整 K3 消息回传、跨模型隔离，以及换目录后的父子/图片/摘要模型绑定。真实 Edge 专项的两处失败均定位为测试时序：弹窗入场位移尚未完成，以及会话刷新后的延迟聚焦覆盖了测试提前执行的失焦。等待实际动画/聚焦完成并加入受控帧延迟回归后通过；保持原居中与折叠断言。没有运行真实模型或原生交互终端专项。

独立 OCR、Embedding、音频、流式或故障转移尚未接入；按具体需求新增窄适配，不预建插件框架。
