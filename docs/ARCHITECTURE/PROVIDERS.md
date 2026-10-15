# Providers：模型协议与能力边界

[架构总览](README.md) · [供应商配置](../REFERENCE/CONFIGURATION.md#providers)

配置在启动时选择一个供应商，父子 Agent 使用同一 Config。当前实现是固定 profile 与共享 OpenAI-compatible Chat Completions 客户端，没有动态注册、运行时切换、路由或故障转移。

## 模块职责

| 源码 | 职责 |
| --- | --- |
| `src/providers.ts` | 配置描述、固定 endpoint、专有字段及精确模型能力 |
| `src/config.ts` | 所选凭据/模型/区域与共享预算校验 |
| `src/model.ts` | createModel、完整请求准备、SDK、响应校验、期限和安全错误 |
| `src/model-usage.ts` | token 与缓存计数合法性 |
| `src/documents/vision.ts` | 已获准图片的临时辅助请求 |
| `webui/context-usage.ts` | 界面已知模型容量与最近父请求观察，不改变 API |

原 createDeepSeekModel 保留程序化兼容入口。注入 transport 用于测试，生产不开放任意 base URL；模型协议差异不散入 Loop、Session 或各工具。

## 请求约定与设计理由

环境变量、默认模型及区域选择集中在配置参考。运行时仅使用所选 Key，不回退 OPENAI_API_KEY 或其他供应商，不继承 OpenAI organization/project。

| Profile | 固定服务地址 | 生成参数差异 |
| --- | --- | --- |
| DeepSeek | https://api.deepseek.com | thinking disabled，max_completion_tokens |
| Kimi | https://api.moonshot.cn/v1 或 https://api.moonshot.ai/v1 | thinking disabled，max_completion_tokens |
| MiMo | https://api.xiaomimimo.com/v1 | thinking disabled，max_completion_tokens；使用 Bearer |
| Qwen | https://dashscope.aliyuncs.com/compatible-mode/v1 或 https://dashscope-intl.aliyuncs.com/compatible-mode/v1 | enable_thinking=false，max_tokens |

共同使用 stream=false，输出上限 2048；普通工具选择 auto。文字收尾时 DeepSeek/Kimi/Qwen 使用 none，MiMo 省略 tools/tool_choice，因为其协议不可靠支持非 auto 选择。即便服务返回违规工具，Loop 仍拒绝超出额度执行。

使用非思考路径是因为当前历史不管理 reasoning_content；可配置模型名不代表任意模型都兼容。Qwen 参数单独构造，不能把其他家的 thinking/max_completion_tokens 原样复制。SDK 禁自动重试、关闭原始日志，期限与外部 AbortSignal 共同控制；响应截断、未知/矛盾 finish_reason、非法工具结构不得当成完成。

purpose=compaction/document 是内部选项，不发送给供应商；这些辅助请求均省略 tools/tool_choice并拒绝返回工具。摘要复用当前模型，图像请求只含所选材料与问题，不承接完整会话历史。完整厂商 JSON（包括 base64）先通过共同字节预算。

## 图片能力

当前 getModelInputCapabilities 使用精确名称白名单：

| 供应商 | 图片模型 |
| --- | --- |
| Kimi | kimi-k2.6 |
| MiMo | mimo-v2.6-flash、mimo-v2.6-pro、mimo-v2.6-pro-ultraspeed、mimo-v2.5 |
| Qwen | qwen3-vl-plus、qwen3-vl-flash |
| DeepSeek | 无 |

未知别名/日期后缀不猜测支持，发送前返回 DOCUMENT_VISION_UNAVAILABLE，保留原生文本读取。所有 profile 的 nativeFileInput 均为 false；图片适配不代表 PDF/Office 原生输入、音频或多模态检索。

图片仅构造临时 image_url data URL，Session 保存文字和固定来源，不保存 base64 或凭据。不自动切换供应商，也不增加隐藏视觉 Key。请求预算、逐页部分成功与缓存归 [Documents](DOCUMENTS.md)。

## 用量校验

prompt_tokens、completion_tokens、total_tokens 必须为非负安全整数且相加一致。缓存独立校验标准 cached_tokens 和 DeepSeek hit/miss 字段，不能超过相应输入；多字段冲突时缓存未知但基础用量可仍有效。

缺失不是零，累计只包含合法报告并保留覆盖数量，溢出保持未知。缓存率按有效缓存请求的总命中/同批输入计算，不平均百分比；零分母不显示比例。不能推算 KV 容量、显存、价格或账单。统计消费边界见 [执行报告](EXECUTION_REPORT.md)和 [TUI](TUI.md)。

## 维护与验证要求

修改 profile 时核对官方地址、认证、工具/非思考能力、请求字段、停止原因和用量，保留实际 SDK JSON 的离线合约测试。使用假凭据及注入传输检查 URL/头/正文、工具关联、超限不传输、取消、超时与错误脱敏；不凭兼容标签添加 strict、并行、温度或缓存字段。

当前协议依据保留为：[DeepSeek](https://api-docs.deepseek.com/api/create-chat-completion/)、[Kimi](https://platform.kimi.com/docs/api/chat)、[MiMo](https://mimo.mi.com/docs/en-US/api/chat/openai-api)、[Qwen](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions)。这是实现选择的来源，后续修改仍需重新核对，不能据链接存在宣称已在线验证。

Kimi/MiMo/Qwen 的现有证据为离线合约；视觉也未调用真实 API，账号可用性、图表理解和转写质量未验收。已有 live 脚本保持 DeepSeek 专用范围，仅在明确请求时运行。新增供应商不必默认产生真实调用。

独立 OCR、Embedding、音频、流式/思考历史或故障转移尚未接入；按具体需求新增窄适配，不预建插件框架。
