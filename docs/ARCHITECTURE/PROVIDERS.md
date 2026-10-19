# Providers：模型协议与能力边界

[架构总览](README.md) · [供应商配置](../REFERENCE/CONFIGURATION.md#providers)

配置在启动时提供默认供应商及连接快照；会话保存自己的模型与思考选择，父子 Agent、摘要及图片适配从同一选择构造。固定能力目录、协议映射、runtime 会话切换和思考历史回传已实现。客户端模型菜单、思考滑条及 Web 切换路由仍属于后续 UI 阶段。没有动态注册、路由或故障转移。

## 模块职责

| 源码 | 职责 |
| --- | --- |
| `packages/runtime/src/providers.ts` | 供应商配置描述、固定服务域名及 Qwen 业务空间 endpoint |
| `packages/runtime/src/model-catalog.ts` | 精确模型能力、ModelSelection 解码与能力校验 |
| `packages/runtime/src/model-protocol.ts` | 按模型和请求目的映射思考参数、生成预留与历史回传规则 |
| `packages/runtime/src/model-connections.ts` | 主机侧凭据隔离、公开选择目录及按供应商/区域/业务空间解析凭据 |
| `packages/runtime/src/model-history.ts` | 私有助手消息解码与来源校验、按模型身份投影及摘要剥离 |
| `packages/runtime/src/config.ts` | 所选凭据/模型/区域与共享预算校验 |
| `packages/runtime/src/model.ts` | createModel、完整请求准备、SDK、响应校验、期限和安全错误 |
| `packages/runtime/src/model-usage.ts` | token 与缓存计数合法性 |
| `packages/runtime/src/documents/vision.ts` | 已获准图片的临时辅助请求 |
| `packages/webui/src/context-usage.ts` | 最近父请求观察；容量读取 runtime 目录，不在客户端维护第二份表 |

原 createDeepSeekModel 保留程序化兼容入口。注入 transport 用于测试，生产不开放任意 base URL；模型协议差异不散入 Loop、Session 或各工具。

## 请求约定与设计理由

环境变量、默认模型及区域选择集中在配置参考。运行时仅使用所选 Key，不回退 OPENAI_API_KEY 或其他供应商，不继承 OpenAI organization/project。

| Profile | 固定服务地址 | 生成参数差异 |
| --- | --- | --- |
| DeepSeek | https://api.deepseek.com | thinking disabled，max_tokens |
| Kimi | https://api.moonshot.cn/v1 或 https://api.moonshot.ai/v1 | thinking disabled，max_completion_tokens |
| MiMo | https://api.xiaomimimo.com/v1 | thinking disabled，max_completion_tokens；使用 Bearer |
| Qwen | 原 cn/intl DashScope 地址，或业务空间区域域名（下表） | enable_thinking=false；旧版 max_tokens，新版 max_completion_tokens + preserve_thinking=false |

共同使用 OpenAI-compatible Chat Completions、Bearer 认证与 stream=false，普通非思考输出上限 2048；普通工具选择 auto。文字收尾时 DeepSeek/Kimi/Qwen 使用 none，MiMo 省略 tools/tool_choice，因为其协议只保证 auto。MiMo 同时支持 api-key 头，Fatcat 继续采用 Bearer。即便服务返回违规工具，Loop 仍拒绝超出额度执行。供应商另有 Responses/Anthropic 等接入协议，本轮不新增适配或 SDK。

Qwen 的可选 QWEN_WORKSPACE_ID 只允许安全的单个 DNS label；不接受任意 URL。存在该字段时拼接 `https://{workspaceId}.{regionHost}.maas.aliyuncs.com/compatible-mode/v1`，缺省时 cn/intl 保留旧 endpoint，其他区域拒绝缺少 workspaceId 的配置。

| QWEN_REGION | regionHost |
| --- | --- |
| cn | cn-beijing |
| intl | ap-southeast-1 |
| us | us-east-1 |
| eu | eu-central-1 |
| jp | ap-northeast-1 |
| hk | cn-hongkong |

可选思考模型仍默认 off，强制思考模型采用目录默认档位；会话切换可以显式改变有效档位。可配置模型名不代表任意模型都兼容。Qwen 参数单独构造，不能把其他家的 thinking/max_completion_tokens 原样复制。SDK 禁自动重试、关闭原始日志，期限与外部 AbortSignal 共同控制；响应截断、未知/矛盾 finish_reason、非法工具结构不得当成完成。

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
| qwen3.8-max、qwen3.8-flash | off/low/medium/xhigh；兼容 high/max | enable_thinking、preserve_thinking、reasoning_effort、max_completion_tokens=16384 | high/max→xhigh；共用 16384，不同时发送 thinking_budget；开启时回传历史 |
| qwen3.7-plus | off/on | enable_thinking、preserve_thinking、max_completion_tokens=16384 | 共用 16384，不另加思考预留；开启时回传历史 |
| qwen-plus | off/on | enable_thinking=true、thinking_budget=8192、max_tokens=2048 | 思考与回答分别预留，总计 10240；不回传思考历史 |
| qwen3-vl-plus/flash | 当前适配 off | enable_thinking=false、max_tokens=2048 | 仅接入辅助图片请求，不用于工具 Agent |
| 未知自定义名称 | off | 保留原供应商非思考字段 | 不猜测额外思考能力，预留语义未知 |

这些上限是 Fatcat 的显式策略，不是供应商最大输出容量。off 保持 2048；compaction/document 在模型支持时关思考，否则保留强制思考并使用包含推理的 16384。辅助请求不修改父选择。K3/K2.7 普通 Agent 请求已开放，K3 完整消息经过工具往返、保存和恢复的离线回传验证；不等于真实账户与模型服务验收。默认启动型号继续保留 DeepSeek Flash、Kimi K2.6、MiMo V2.6 Flash、Qwen Plus。

思考响应在规范助手消息旁保存 modelContext 来源与完整厂商消息，读取时核对角色、文本和工具调用事实。只有 provider、region、workspaceId、model 全部匹配且当前协议允许回传时才使用私有消息；思考档位可以在同一模型内改变，但 off 会剥离私有历史。跨模型、跨区域和跨业务空间只发送规范文本与工具事实，内部 modelContext 永不直接上网。DeepSeek 在启用思考且请求带工具定义时回传；Kimi/MiMo/新版 Qwen 按上表处理，旧 Qwen 不回传。摘要序列化也剥离私有数据。该投影先于最终 JSON 字节检查和旧读裁剪，不重复加入规范消息。

ThinkingLevel 保留 medium/ultra，增加 Qwen 原生 xhigh；它是应用层选项集合，不是所有模型通用的档位。wire reasoning_effort 从 SDK 的请求类型派生，只写入归一化后的合法值。model.ts 原 TS2375 的根因是把 ultra 放入所有供应商共用的 wire 联合类型，赋给 SDK 不接受 ultra 的 ReasoningEffort；exactOptionalPropertyTypes 出现在诊断中，但不是关闭该检查或加类型断言的理由。Kimi/Qwen 不接受的档位显式拒绝，不跨供应商猜测 ultra 的含义。

| 模型组 | 窗口 token | 独立输入上限 off / thinking |
| --- | --- | --- |
| DeepSeek 两个当前 ID | 1048576 | 未核定 |
| Kimi K2.6、K2.7 Code/Highspeed | 262144 | 未核定 |
| Kimi K3 | null（官方写 1M，未据该缩写猜测精确整数） | 未核定 |
| MiMo V2.6 三个 ID | 1048576 | 未核定 |
| MiMo V2.5/Pro | null（保留精确窗口未核定） | 未核定 |
| Qwen3.8 Max/Flash、3.7 Plus | 1000000 | 991808 / 983616 |
| Qwen Plus | 1000000 | 997952 / 995904 |
| Qwen3 VL Plus/Flash | 262144 | 260096 / 258048 |

Qwen 独立输入限制与窗口、输出预留分开；计算取可用限制的最小值，不能把限制差额再扣一次。厂商提示参数组合可影响限额，容量用于参考和估算，不代替真实服务端验证。effort 不是额外 token 预算。null 表示未核定，不通过差值反推；字节上限继续与 token 上限分开。

精确快照 qwen3.8-max-0902、qwen3.8-max-2026-09-02、qwen3.7-plus-2026-05-26 可继承已核对的能力，但请求保留用户指定 ID。其他后缀不猜测。MiMo V2.5/Pro 已公告于 2026-10-21 10:00（北京时间）下线，目录保留迁移提示信息；不会按时偷偷替换模型。Ultraspeed 需要厂商单独开放账户权限。Kimi 旧 K2/K2.5、Moonshot V1 不列为当前推荐型号。

协议来源于 2026-10-19 核对的 [DeepSeek 思考与历史](https://api-docs.deepseek.com/guides/thinking_mode/)、[DeepSeek 模型窗口](https://api-docs.deepseek.com/api/list-models/)、[Kimi API](https://platform.kimi.com/docs/api/chat)、[Kimi 模型](https://platform.kimi.com/docs/models)、[Kimi K2.6 配置](https://huggingface.co/moonshotai/Kimi-K2.6/blob/main/generation_config.json)、[MiMo 思考](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/other/deep-thinking)、[MiMo 容量](https://mimo.mi.com/docs/en-US/tokenplan/integration/openclaw)、[Qwen API](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)、[Qwen Plus 输入限制](https://www.alibabacloud.com/help/en/model-studio/qwen-plus)及[非流式思考说明](https://help.aliyun.com/zh/model-studio/deep-thinking/)。历史回传已通过注入模型的工具往返及持久化检查；未调用真实模型，线上行为仍须另行验收。

purpose=compaction/document 是内部选项，不发送给供应商；这些辅助请求均省略 tools/tool_choice并拒绝返回工具。摘要复用当前模型，图像请求只含所选材料与问题，不承接完整会话历史。完整厂商 JSON（包括 base64）先通过共同字节预算。

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

## 按量 API 与订阅入口

本轮只实现按量 API。订阅 Key、专用模型 ID、额度和端点不混用，不新增订阅 provider 或环境变量。

| 服务 | 官方入口与区别 |
| --- | --- |
| Kimi Code | [接入说明](https://www.kimi.com/code/docs/)：国内 OpenAI base 为 https://api.kimi.com/coding/v1，海外为 https://api.kimi.ai/coding/v1；使用独立会员 Key 与订阅模型 ID，非 Moonshot 按量平台 |
| Qwen Coding Plan | [官方说明](https://help.aliyun.com/zh/model-studio/coding-plan-faq)：国内 OpenAI base 为 https://coding.dashscope.aliyuncs.com/v1；国际套餐使用专属国际端点。Key 与按量 API 不互通 |
| MiMo Token Plan | [订阅与接入说明](https://mimo.mi.com/docs/tokenplan/subscription)：订阅专用 Key 和协议地址以控制台为准，不能把按量 API profile 当作已接入套餐 |
| DeepSeek | 本轮维护开放平台按量 API，不新增未经核定的订阅入口 |

本轮目录刷新核对日期为 2026-10-19。除上面的既有协议来源，新增型号与限制参见 [DeepSeek 模型列表](https://api-docs.deepseek.com/api/list-models/)、[Kimi K3](https://platform.kimi.com/docs/guide/kimi-k3-quickstart)、[Kimi K2.7 Code](https://platform.kimi.com/docs/guide/kimi-k2-7-code-quickstart)、[MiMo 模型及下线说明](https://mimo.mi.com/docs/quick-start/model)、[Qwen3.8 Max](https://help.aliyun.com/zh/model-studio/qwen3-8-max)、[Qwen3.8 Flash](https://help.aliyun.com/zh/model-studio/qwen3-8-flash)、[Qwen3.7 Plus](https://help.aliyun.com/zh/model-studio/qwen3-7-plus)、[Qwen VL Plus](https://help.aliyun.com/zh/model-studio/qwen3-vl-plus)、[Qwen VL Flash](https://help.aliyun.com/zh/model-studio/qwen3-vl-flash)。模型目录没有远程自动更新；未来更新必须核对具体协议和实际序列化请求。

## 用量校验

prompt_tokens、completion_tokens、total_tokens 必须为非负安全整数且相加一致。缓存独立校验标准 cached_tokens 和 DeepSeek hit/miss 字段，不能超过相应输入；多字段冲突时缓存未知但基础用量可仍有效。

缺失不是零，累计只包含合法报告并保留覆盖数量，溢出保持未知。缓存率按有效缓存请求的总命中/同批输入计算，不平均百分比；零分母不显示比例。不能推算 KV 容量、显存、价格或账单。统计消费边界见 [执行报告](EXECUTION_REPORT.md)和 [TUI](TUI.md)。

## 维护与验证要求

修改 profile 时核对官方地址、认证、工具/非思考能力、请求字段、停止原因和用量，保留实际 SDK JSON 的离线合约测试。使用假凭据及注入传输检查 URL/头/正文、工具关联、超限不传输、取消、超时与错误脱敏；不凭兼容标签添加 strict、并行、温度或缓存字段。

当前协议依据保留为：[DeepSeek](https://api-docs.deepseek.com/api/create-chat-completion/)、[Kimi](https://platform.kimi.com/docs/api/chat)、[MiMo](https://mimo.mi.com/docs/en-US/api/chat/openai-api)、[Qwen](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)。这是实现选择的来源，后续修改仍需重新核对，不能据链接存在宣称已在线验证。

Kimi/MiMo/Qwen 的现有证据为离线合约；视觉也未调用真实 API，账号可用性、图表理解和转写质量未验收。已有 live 脚本保持 DeepSeek 专用范围，仅在明确请求时运行。新增供应商不必默认产生真实调用。

第二阶段的注入检查覆盖会话独立选择、v1/v2 读取及 v3 写入、保存失败/忙碌/并发冲突、不可信历史、完整 K3 消息回传、跨模型隔离，以及换目录后的父子/图片/摘要模型绑定。真实 Edge 专项的两处失败均定位为测试时序：弹窗入场位移尚未完成，以及会话刷新后的延迟聚焦覆盖了测试提前执行的失焦。等待实际动画/聚焦完成并加入受控帧延迟回归后通过；保持原居中与折叠断言。没有运行真实模型或原生交互终端专项。

独立 OCR、Embedding、音频、流式或故障转移尚未接入；按具体需求新增窄适配，不预建插件框架。
