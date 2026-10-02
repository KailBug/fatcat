# Providers：模型协议与开发规范

## 范围与实现边界

阶段 2D-10 在现有 DeepSeek 接入上增加 Kimi、MiMo 和 Qwen，复用 `openai@7.18.0` 的 Chat Completions 兼容客户端。配置在进程启动时选择一个供应商，父子 Agent 使用同一 Config；Session 内不切换、路由或故障转移。没有动态插件注册表，也不引入新的 SDK。

默认继续使用 DeepSeek。新增三家按官方协议实现，以虚构凭据和注入 SDK 传输完成离线合约检查；依用户要求，本轮不执行三家的 API 在线验证。账号权限、实际连通性和真实任务表现均未因此获得验证。具体已执行检查以 [PROGRESS.md](../PROGRESS.md) 为准。

## 模块职责

Web UI 的后续上下文指示器在独立 webui/context-usage.ts 中维护六个已核对精确模型的窗口数字，未知名称不猜测；只观察既有父 model_usage，不新增供应商请求字段、远程发现或配置。容量依据及时间见 [WEBUI.md](WEBUI.md)，本地 maxRequestBytes 仍是独立完整 JSON 字节预算。

`src/providers.ts` 定义小型供应商 profile：配置字段、固定地址、默认模型和厂商专用请求字段。`src/config.ts` 只读取所选供应商的凭据/模型/区域与共享预算。`src/model.ts` 的 `createModel(config, transport?, tools?)` 创建共享客户端，负责请求容量、deadline、取消、SDK 调用、响应校验、用量观察和安全错误。原 `createDeepSeekModel` 保留兼容入口；CLI/createAgent 使用通用入口。

`Model`、Loop、Session、Tools、执行报告和上下文投影继续使用共同协议。供应商差异保持在配置和完整请求体构造处，不把特定厂商字段散入业务循环或各工具。注入 transport 只用于测试，不开放任意生产 base URL。

2D-11 的 TUI 复用这些非流式协议，模型完成响应后才有完整答案和服务端 usage；界面的运行状态更新不代表 token 流式输出。缓存用量也是响应元数据，不新增缓存控制请求参数。界面只展示选定 profile 的非秘密配置，不显示凭据。

## 配置与当前请求约定

`HARNESS_PROVIDER` 可为 deepseek、kimi、mimo、qwen，省略时使用 deepseek。只读取被选中的配置：

| 供应商 | Key / Model 环境变量 | 默认模型 | 区域与固定 base URL |
| --- | --- | --- | --- |
| DeepSeek | DEEPSEEK_API_KEY / DEEPSEEK_MODEL | deepseek-flash | https://api.deepseek.com |
| Kimi | MOONSHOT_API_KEY / KIMI_MODEL | kimi-k2.6 | KIMI_REGION=cn（默认）：https://api.moonshot.cn/v1；global：https://api.moonshot.ai/v1 |
| MiMo | MIMO_API_KEY / MIMO_MODEL | mimo-v2.6-flash | https://api.xiaomimimo.com/v1 |
| Qwen | DASHSCOPE_API_KEY / QWEN_MODEL | qwen-plus | QWEN_REGION=cn（默认）：https://dashscope.aliyuncs.com/compatible-mode/v1；intl：https://dashscope-intl.aliyuncs.com/compatible-mode/v1 |

区域和 Key 必须对应用户实际账号；这些是厂商 API 平台地址，不是订阅或 Coding Plan 地址，本地校验不验证可用性。模型覆盖值必须支持工具调用及本项目的非思考模式。当前不管理 reasoning_content 等历史，因此只提供非流式、非思考路径；不能据模型名可配置推断所有该厂商模型均受支持。

| 请求字段 | DeepSeek / Kimi / MiMo | Qwen |
| --- | --- | --- |
| stream | false | false |
| tool_choice | 通常 auto；收尾时 DeepSeek/Kimi 为 none，MiMo 省略 tools 和 tool_choice | 通常 auto；收尾时 none |
| 非思考控制 | thinking: { type: "disabled" } | enable_thinking: false |
| 输出上限 | max_completion_tokens: 2048 | max_tokens: 2048 |

Qwen 使用 max_tokens，是因为所选 qwen-plus 的兼容范围不统一支持较新的 max_completion_tokens；不将 DeepSeek/Kimi/MiMo 的 thinking 参数发送给 Qwen。Kimi 默认选用文档明确支持关闭思考的 kimi-k2.6，不能切换到只能思考的模型后期待当前协议继续成立。MiMo 文档支持 Bearer 和 api-key，本项目统一使用 SDK Bearer。

2026-10-02 核对最后一次请求的工具选择：[DeepSeek Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)、[Kimi Chat API](https://platform.kimi.com/docs/api/chat) 与 [Qwen OpenAI-compatible Chat](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions) 支持 none。[MiMo Chat API](https://mimo.mi.com/docs/en-US/api/chat/openai-api) 说明非 auto 值会被忽略，因此 MiMo 的文字收尾请求省略工具定义及选择字段，不发送不支持的 none。此前工具调用和结果仍保留在消息中；若仍返回工具调用，Loop 硬上限拒绝执行。父子包装透传单次 Model options，不改变其他请求或持久配置。四家离线 SDK 合约覆盖请求字段；真实服务效果须另行验证。

## Provider 开发规范

### 用量与缓存字段

标准 `prompt_tokens`、`completion_tokens`、`total_tokens` 必须为非负安全整数且加和一致，才成为有效 token 用量。缓存字段单独校验：兼容格式的 `prompt_tokens_details.cached_tokens` 与 DeepSeek 的 `prompt_cache_hit_tokens` 可表示输入缓存命中；必须不超过同一响应的 prompt tokens。DeepSeek 同时给出 `prompt_cache_miss_tokens` 时还需与 hit 加和一致；多个已给出的缓存计数若冲突或非法，缓存信息保持未知，不因此抹去有效的基础用量。

没有缓存字段表示未报告，不是零命中；明确的合法零计数才是已知零。每回合和进程累计率只对具有合法缓存数据的请求计算 `sum(cached tokens) / sum(prompt tokens)`，并显示覆盖范围。分母为零时不显示伪造百分比，不平均每个响应的百分比，不把模型输出 tokens 纳入缓存命中分母，也不推算服务内部 KV 占用、缓存容量、价格或费用。实际解析字段与离线验收见 `src/model-usage.ts` 和 PROGRESS.md；UI 口径见 [TUI.md](TUI.md)。

### 开发要求

新增或修改供应商必须同时满足以下要求：

1. **先核对官方协议。** 记录模型是否支持 tool calling、关闭思考、非流式输出，以及地址、认证、输出上限、工具字段、停止原因和用量格式。相同的 OpenAI 兼容标签不代表厂商扩展字段相同。注明资料链接和本项目取舍。
2. **隔离配置与认证。** 只使用所选厂商 Key，禁止回退到其他厂商或 OPENAI_API_KEY；固定允许的 endpoint/region，不继承 OpenAI organization/project。错误信息不能包含 Key、原始服务错误、提示或工具正文。配置检查不发请求。
3. **只发送已支持的参数。** 所有扩展字段由 profile 生成，保留工具定义和 assistant/tool 的 call ID 关联；不凭推测添加 strict、thinking、temperature、并行工具或缓存控制。模型覆盖值由使用者选择兼容能力。
4. **复用确定的响应边界。** 校验响应、finish_reason、文本和函数工具调用的结构，拒绝截断/矛盾/未知结构，不能把部分响应当成完成。工具参数继续由本地 Tools 校验；供应商支持不能替代参数与权限检查。
5. **预算、取消和用量一致。** 完整厂商请求体（含扩展字段）先做字节测量和上下文投影，超限不发送。禁用 SDK 自动重试，沿用 deadline、外部 AbortSignal 和安全错误分类。仅接受非负安全整数、加和一致的标准 token 用量，缺失或非法保持未知；不推算金额或补造用量。
6. **必须离线验证 SDK 边界。** 使用虚构凭据和注入传输捕获实际 URL、认证头和 JSON，验证配置隔离、厂商参数、工具历史、直接回答及工具调用、HTTP/网络错误脱敏、超时/取消、请求超限不传输和用量观察。测试不加载真实 `.env`，不因 SDK 默认行为偷发网络请求。
7. **分开记录实现与在线证据。** 本轮三家新增厂商无需 API 在线验收。若以后用户显式选择在线验证，再建立有界场景并单独报告调用次数与结果；离线通过不能写成在线通过，也不能把 SDK 兼容性当成账号和模型可用性的保证。

这些规范约束当前小型 profile 和共享模型边界，不要求预建抽象基类、插件接口或复杂能力矩阵。

## 官方依据

以下资料用于本轮协议核对（2026-09-27）；模型默认值是实现时的选择，不是自动追踪最新版的别名。

- DeepSeek：[工具调用](https://api-docs.deepseek.com/guides/tool_calls/)、[思考控制](https://api-docs.deepseek.com/guides/thinking_mode/)、[Chat Completions](https://api-docs.deepseek.com/api/create-chat-completion/)。沿用已有已验证 profile。
- Kimi：[模型能力](https://platform.kimi.ai/docs/api/models-overview)、[模型列表](https://platform.kimi.ai/docs/models)、[Chat API](https://platform.kimi.com/docs/api/chat)。依据非思考和工具能力选择默认模型，配置国内与全球 endpoint。
- MiMo：[OpenAI 兼容 Chat API](https://mimo.mi.com/docs/en-US/api/chat/openai-api)。核对固定 endpoint、认证、默认模型、thinking 开关、max_completion_tokens 和工具字段。
- Qwen：[OpenAI 兼容 Chat Completions](https://www.alibabacloud.com/help/en/model-studio/qwen-api-via-openai-chat-completions)、[Function calling](https://www.alibabacloud.com/help/en/model-studio/qwen-function-calling)。核对区域、Bearer、enable_thinking、max_tokens 和 tool_calls。

SDK 行为同时以项目已安装的 `openai@7.18.0` 类型和实现检查，保持原依赖及禁用重试的策略。

已有五个 `verify:*` 在线脚本通过 `scripts/fixtures/live-config.ts` 保持 DeepSeek 专用范围；选择其他 HARNESS_PROVIDER 时在创建模型前拒绝，防止误把现有样例当作新厂商验收。普通 CLI 仍可由用户自行配置所选厂商使用；本轮开发验证没有借此发送 API 请求。
