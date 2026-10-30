

<a id="context-request-projection-and-bounded-compaction"></a>

# Context：请求投影与有界压缩

[English](../../en/ARCHITECTURE/CONTEXT.md) | 简体中文

[架构总览](README.md) · [上下文操作](../GUIDES/SESSIONS.md#context-management)

Context 决定本次发送什么，不拥有原始历史、文件、资料或长期 Memory。完整成功历史始终由 Session 保存。

<a id="module-responsibilities"></a>

## 模块职责

| 源码 | 职责 |
| --- | --- |
| `packages/runtime/src/context/manager.ts` | CompactionState 校验、projectHistory 与上下文字节/消息统计 |
| `packages/runtime/src/context/request.ts` | 完整请求计量与旧 read 省略，无持久状态或 I/O |
| `packages/runtime/src/context/compaction.ts` | 规划有界摘要、分块调用及候选结果 |
| `packages/runtime/src/context/usage.ts` | 当前输入估算、最近实测观察与两种余量的数据契约和纯计算 |
| `packages/runtime/src/context/turn-request.ts`、`model-preparation.ts` | Loop 与预览共用的请求投影及消息转换链 |
| `packages/runtime/src/context/estimate.ts` | 匹配本地计数器、受限近似、未知状态与计量限制 |
| `packages/runtime/src/context/accounting.ts` | 会话累计、缓存覆盖、溢出处理及持久观察校验 |
| `packages/commands/src/context/commands.ts` | 本地统计和显式 compact 入口 |
| `packages/runtime/src/session/session.ts`、`agent-session.ts` | 应用投影、回合内自动恢复及摘要持久提交 |

<a id="older-read-omission"></a>

## 旧读取省略

Model 先构造含 system、动态指导、工具定义、专有参数与历史的完整 JSON，再调用 prepareRequestContext 测量 UTF-8 字节。未超限原样返回；超限时按最旧优先替换可省略结果，重新测量后才发送。

当前回合与最近一个完整回合受保护。只替换更早、正确关联到 read/grep/glob/output_read 调用且成功返回的 file/directory/search/document/glob/output 结果；错误、未知协议、write/edit/shell/delegate_task 结果、用户要求及 assistant 消息保留。Skill 正文的 kind=skill 不参加省略，引用资源可按普通 read 处理。

替换结果使用 kind=context_omitted，保留原类型、路径及文档 parserVersion，或命令输出的 outputId/stream，并明确要求需要时重读。原参数和调用 ID 保留，跨回合重复 ID 按局部工具批次关联。标记表示原调用曾成功，不表示正文仍在或文件当前未变。仅实际节省字节才替换；仍超限则本次传输前报 MODEL_CONTEXT_LIMIT。

该操作只修改请求副本，下一次请求重新准备。它不执行模型摘要、不自动读取文件、不删磁盘历史；重读重新经过当前权限与版本校验。工作区搜索重新扫描当前文件；输出引用指向不可变的进程内日志，随所属 Tools 实例或进程失效，不随历史恢复。

<a id="manual-and-automatic-compact"></a>

## 手动与自动 compact

手动 compact 对较早完整回合生成有损摘要，保留最新完整回合和全部原始历史。分块计划在请求前检查是否能在最多 min(maxIterations, 8) 次摘要请求中完成；focus 与请求体均有界。摘要不调用工具，不把生成摘要当作新的用户回合。

自动 compact 仅在旧读省略后仍触发本地 MODEL_CONTEXT_LIMIT 时尝试一次。拒绝的请求尝试、摘要和续跑共用原回合额度，并预留一次正常继续请求。当前消息、工具结果和最新完整回合不重放；余额不足、无可压缩历史、摘要失败或再次超限即结束。HTTP 错误、服务端 token 上限和超时不触发该恢复。

成功摘要先持久保存，再继续原 Loop；续跑失败或取消也保留新投影。摘要失败、取消或提交冲突不替换旧投影。手动摘要的独立领取、自动摘要复用 attempt、pendingSettlement 与跨进程互斥见 [Session](SESSION.md)。

<a id="usage-and-provenance"></a>

## 用量与来源

/context 统计完整历史和投影对话的 JSON 字节及消息数，排除动态指导、工具定义和执行日志；不能当作最终请求大小或 token 数。model_input 观察实际请求字节。context_reduction 记录整理前后大小与省略数量，不含正文、路径或查询。

历史字节包含持久化的 providerReplay，而最终请求先按当前模型身份投影厂商助手消息、剥离内部来源字段，再计算实际 JSON 字节并执行旧读裁剪；两者不必相等。摘要片段仅序列化规范对话文本及工具事实，不包含 providerReplay 内的私有思考或不透明数据，避免通过摘要跨模型传播。思考字段的实际回传由 [Providers](PROVIDERS.md) 管理。

摘要及视觉辅助请求计入真实请求/用量；它们不覆盖 runtime 的普通主请求观察。压缩后当前占用失效，历史实测观察保留身份和时间。请求多次省略同一结果会多次计入统计，不能据此直接估算费用节省。Web 直接展示下述 runtime 快照，压缩不会清空历史实测。

附件结果保留不可变来源与解析版本；未知旧版本不能重新指向新版。当前 Memory 在每次请求重新装配，旧摘要中的记忆不是权威状态，见 [Memory](MEMORY.md)。

<a id="verification-and-unimplemented-scope"></a>

## 验证与未实现范围

<a id="current-input-estimation-implemented-phase-three-runtime-api"></a>

### 当前输入估算：第三阶段已实现的 runtime 接口

`SessionManager.contextUsage` 返回独立的 `consumption`、`estimate`、`lastReportedInput`，没有可用模型身份的注入 Agent 返回 null。`previewContext(signal?)` 按当前来源重新计量，`invalidateContext()` 供宿主在修改动态权限等请求配置后主动失效；getter 不读取磁盘、不发请求。预览只更新进程内展示缓存和 contextRevision，不修改持久 SessionRecord、历史或消费数据。

`ContextEstimate`（estimated）带完整模型身份、contextRevision、计量时间及 ready/pending/unknown；只有 ready 携带数值、方法、近似标记和限制说明。pending/unknown 使用 null 并给出原因。`ContextObservation`（reported）带 requestId、完整模型身份及 observedAt，表示一次普通父请求响应的输入事实。最近普通响应缺失或包含无效用量时改为 inputTokens=null 并记录原因，不继续展示更早的数字；没有收到响应则没有新的观察。委派、摘要、图片辅助响应不覆盖它。它不会因后续压缩或模型切换改写身份，也不会冒充当前估算。

`ContextUsageSnapshot` 为 Web 快照提供消费、估算、实测观察、窗口容量、窗口剩余和可用输入余量。纯函数 contextHeadroom 只接受当前估算，不接收累计消耗或最近实测输入：窗口剩余是 W−E 的参考值；可用输入余量是 min(W−R, I)−E，R 来自真实协议生成策略，I 为已核定的独立输入限制。没有独立限制时只使用 W−R；窗口、计数或预留语义未知时相应值为 null。原始负余量保留，仅圆环与柱条绘制限制在 0–100%。缓存命中不会从 E 中扣除。

预览复用 `prepareTurnMessages` 和真实 `Model.prepare`：系统提示、预算指导、当前 Memory、会话身份、动态权限/时间、恢复和目录变更提示、工具定义、压缩历史投影、最新回答与工具结果、执行日志、当前模型思考回传及旧 read 裁剪均经过同一转换链。`mapModelMessages` 让生成与准备共享转换；没有 prepare 的注入模型不调用生成函数替代，而是返回未知。默认预览下一普通回合的第一请求，不接受草稿参数；没有未发送用户消息时保护最近一个完整回合，真实执行则保护当前回合和最近完整回合。新草稿的字节可能使真实请求进一步裁剪，因此这是当前有效上下文的预览，不是对未来任意请求大小的承诺。

准备结果提供最终序列化请求 `json`，不提供 SDK 类型的 body。旧 read 省略在内部消息上进行，每次候选修改由当前协议编码器重新测量完整请求，包含工具定义、协议封装与允许回传的思考历史；不按内部消息的较小 JSON 判断线上字节预算。本地计数器接收同一准备结果，DeepSeek 近似仅解释当前已知请求格式。

预览不调用 model 生成、tools.forTurn/execute、compact 或 Session 保存。Memory 使用单独的 preview 读取入口，仍经过实际执行身份校验和 metadata → Memory 锁；只产生短暂同步锁，不创建缺失存储、不恢复日志、不清理陈旧锁。待恢复事务、作用域改变或读错误使计量未知，不绕过授权或返回不完整估算。估算器在取得请求副本后运行，锁不跨计数器；取消按既有 CANCELLED 传播。

计量优先使用宿主注入、精确匹配模型及请求格式的本地 `inputCounter`；其契约禁止网络、生成、工具和状态写入。默认没有网络计数调用，也没有把不匹配的 tokenizer 套到其他模型。目录内 DeepSeek 文本请求采用 [DeepSeek 官方粗略文本说明](https://api-docs.deepseek.com/quick_start/token_usage/) 的 ASCII×0.3 + Han×0.6，对最终 messages/tools 的 JSON 字符代理向上取整。中文标点、emoji、组合字符等其他 Unicode 不再导致整段未知，改用每 UTF-8 字节约一个 token 的保守本地后备估算；这是 Fatcat 的近似策略，不是官方中文系数或精确 tokenizer，会高估部分文本。method/limitations 明示算法和误差，approximate 始终为 true。JSON 字节不是精确 token，聊天模板、代码、工具包装和思考序列化仍可能造成偏差；结构化多模态、未知型号及其他供应商无匹配计数器时仍未知。官方 tokenizer 示例未证明与当前 API 型号及聊天模板精确匹配，因此未增加依赖或默认下载。计量包含实际回传的思考内容；输出计费中的思考 token 不另外累加。

动态提示仅取预览时的样本，未来工具结果、时间变化、自动化触发及自动压缩不可预知；limitations 明示这些边界。超过本地字节上限也可以返回带限制的估算，但不尝试发送或压缩。本地 UTF-8 请求字节上限与模型 token 上限始终独立。

刷新绑定活动运行实例、完整模型选择和单调 contextRevision。回答/工具结果的检查点、压缩提交、模型/思考设置、会话切换/恢复及宿主管理操作后置 pending。运行或压缩期间返回 pending，待状态稳定后显式 previewContext 重算，不把未完成工具批次计成完整请求。较晚返回的旧实例、旧 revision 或旧预览结果不能覆盖新状态。每次显式预览重新读当前 Memory、权限和动态提示；外部修改不会被展示缓存主动监视，宿主应在展示/刷新时请求新预览。辅助请求写回的摘要和工具结果参与下一次估算。旧模型实测值仅是带身份的历史事实，容量和余量只取新模型估算。

`consumption` 只累加合法响应用量，包含普通、委派、摘要、图片辅助及失败/截断前已收到的合法用量。requests 是请求尝试数（含本地拒绝），reportedRequests 是有合法报告的请求数；差值是未覆盖尝试，不能推断均已计费。tokens=null 表示没有报告或累加溢出；溢出后保持未知，合法的零用量仍可为零。cache 只对有效缓存报告累计其 requests/inputTokens/hitTokens，命中率用同批 hitTokens/inputTokens，零分母或溢出不显示比例。completeHistory=false 表示旧记录存在无法回填的历史；即使为 true 也须结合报告覆盖数量，不能声称供应商账单完整。

快照的 `cacheHitRate` 是 runtime 从消费覆盖范围计算的 0–1 比例，不另行持久化，也不是圆环百分比。按 [DeepSeek API usage 定义](https://api-docs.deepseek.com/api/create-chat-completion/)，prompt_tokens = prompt_cache_hit_tokens + prompt_cache_miss_tokens，标准 cached_tokens 与 hit 是同一个量。显式 miss 可用 prompt−miss 补出缺失 hit；所有存在的计数必须有效且互相一致，不能把缺失字段补零。没有任何缓存计数、字段冲突或零分母则无法给出比例。累计按 Σhit/Σinput 加权，例如两次输入 100/300、命中 0/240 得到 60%，不是逐请求比例的平均 40%。[缓存文档](https://api-docs.deepseek.com/guides/kv_cache/) 说明缓存复用输入前缀，不保证命中；命中部分仍是当前输入，不能从上下文中扣除。

**展示与 Codex 文档对照**：[Codex 的状态栏文档](https://learn.chatgpt.com/docs/developer-commands?surface=cli#configure-footer-items-with-statusline) 分列 context stats 和 token counters；[OpenAI context window 定义](https://developers.openai.com/api/docs/guides/conversation-state#managing-the-context-window) 指单次请求可容纳的输入、输出和推理，不能用会话累计替代。公开文档未给出 Codex 桌面圆环的精确基线扣除公式，本实现不声称逐字复刻，也不套用某个固定 token 基数。空白未运行会话显示 Not started / 容量、比例 —；准备阶段的系统/工具开销仍在 runtime 估算中，不能因首页没有用户消息就改为零。开始对话后显示完整当前输入估算，已复制历史的 fork 也不能当作空会话。

消费和实测观察随既有检查点/回合收尾/压缩提交保存为当前会话格式的可选字段；预览估算不持久化。旧会话不从历史反推消费，崩溃前尚未持久化的报告也无法补回。fork 是新计费归属，复制历史和模型但重置累计/观察；恢复和换模型保留原会话累计，压缩不会减少它。

`context-preview.test.ts` 与模型重绑定工作流验证：累计和占用独立增长；回答/工具结果/Memory/恢复提示参与新预览；压缩降低投影而累计增加；模型/思考切换和恢复使旧估算失效；异步旧结果被丢弃；未发送草稿排除；未知/溢出不显示零；请求准备与真实 SDK body 一致；预览不发送、不执行、不保存、不恢复事务；委派/图片/摘要只增加消费，其写回内容进入估算。没有新增圆环驱动自动压缩。

**第四阶段 Web 接入已实现**：模型菜单、离散思考滑条、当前估算圆环及紧凑上下文摘要直接使用上述 runtime 快照。摘要仅显示当前估算/窗口容量、占比与进度条，完整累计、实测观察、窗口余量、输入余量及计量限制仍保留在 runtime 快照中。生命周期刷新、打开摘要的本地预览、过期选择拒绝与浏览器验证范围见 [Web UI](WEBUI.md#model-thinking-and-context-controls)。没有真实模型计数精度或摘要质量验证，近似/未知限制不因接入 UI 而消失。

<a id="existing-request-and-compaction-checks"></a>

### 已有请求与压缩验证

检查精确 JSON 字节、保护范围、关联 ID、文档版本保留、输入不可变、取消、存储冲突、续跑预算、工具不重放、恢复/fork 和入口展示。verify:context 的固定三回合样例验证旧读取省略及重新读取；真实模型长任务摘要质量尚未验证，不能把该样例当作摘要质量证明。

完整历史仍占内存和磁盘并受 Session 64 MiB 上限约束；JSON 序列化不是内存硬限制。一个过大的近期回合、动态日志或工具定义仍可塞满请求。摘要有损，当前没有主动 token 阈值压缩、服务端上下文溢出恢复、语义最优选取、检索或完整分层上下文系统。
