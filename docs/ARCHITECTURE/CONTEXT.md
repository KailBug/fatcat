# Context：请求投影与有界压缩

[架构总览](README.md) · [上下文操作](../GUIDES/SESSIONS.md#context-management)

Context 决定本次发送什么，不拥有原始历史、文件、资料或长期 Memory。完整成功历史始终由 Session 保存。

## 模块职责

| 源码 | 职责 |
| --- | --- |
| `packages/runtime/src/context/manager.ts` | CompactionState 校验、projectHistory 与上下文字节/消息统计 |
| `packages/runtime/src/context/request.ts` | 完整请求计量与旧 read 省略，无持久状态或 I/O |
| `packages/runtime/src/context/compaction.ts` | 规划有界摘要、分块调用及候选结果 |
| `packages/runtime/src/context/usage.ts` | 当前输入估算、最近实测观察与两种余量的数据契约和纯计算 |
| `packages/commands/src/context/commands.ts` | 本地统计和显式 compact 入口 |
| `packages/runtime/src/session/session.ts`、`agent-session.ts` | 应用投影、回合内自动恢复及摘要持久提交 |

## 旧读取省略

Model 先构造含 system、动态指导、工具定义、专有参数与历史的完整 JSON，再调用 prepareRequestContext 测量 UTF-8 字节。未超限原样返回；超限时按最旧优先替换可省略结果，重新测量后才发送。

当前回合与最近一个完整回合受保护。只替换更早、正确关联到 read 调用且成功返回的 file/directory/search/document 结果；错误、未知协议、write/shell/delegate_task 结果、用户要求及 assistant 消息保留。Skill 正文的 kind=skill 不参加省略，引用资源可按普通 read 处理。

替换结果使用 kind=context_omitted，保留原类型、固定路径及文档 parserVersion，并明确要求需要时重读。原参数和调用 ID 保留，跨回合重复 ID 按局部工具批次关联。标记表示原调用曾成功，不表示正文仍在或文件当前未变。仅实际节省字节才替换；仍超限则本次传输前报 MODEL_CONTEXT_LIMIT。

该操作只修改请求副本，下一次请求重新准备。它不执行模型摘要、不自动读取文件、不删磁盘历史；重读重新经过当前权限与版本校验。

## 手动与自动 compact

手动 compact 对较早完整回合生成有损摘要，保留最新完整回合和全部原始历史。分块计划在请求前检查是否能在最多 min(maxIterations, 8) 次摘要请求中完成；focus 与请求体均有界。摘要不调用工具，不把生成摘要当作新的用户回合。

自动 compact 仅在旧读省略后仍触发本地 MODEL_CONTEXT_LIMIT 时尝试一次。拒绝的请求尝试、摘要和续跑共用原回合额度，并预留一次正常继续请求。当前消息、工具结果和最新完整回合不重放；余额不足、无可压缩历史、摘要失败或再次超限即结束。HTTP 错误、服务端 token 上限和超时不触发该恢复。

成功摘要先持久保存，再继续原 Loop；续跑失败或取消也保留新投影。摘要失败、取消或提交冲突不替换旧投影。手动摘要的独立领取、自动摘要复用 attempt、pendingSettlement 与跨进程互斥见 [Session](SESSION.md)。

## 用量与来源

/context 统计完整历史和投影对话的 JSON 字节及消息数，排除动态指导、工具定义和执行日志；不能当作最终请求大小或 token 数。model_input 观察实际请求字节。context_reduction 记录整理前后大小与省略数量，不含正文、路径或查询。

历史字节包含持久化的 modelContext，而最终请求先按当前模型身份投影厂商助手消息、剥离内部来源字段，再计算实际 JSON 字节并执行旧读裁剪；两者不必相等。摘要片段仅序列化规范对话文本及工具事实，不包含 modelContext 内的私有思考或不透明数据，避免通过摘要跨模型传播。思考字段的实际回传由 [Providers](PROVIDERS.md) 管理。

摘要及视觉辅助请求计入真实请求/用量；它们不更新界面的聊天上下文 token 容量。压缩后旧的 token 观察清空，等待下一次普通请求。请求多次省略同一结果会多次计入统计，不能据此直接估算费用节省。

附件结果保留不可变来源与解析版本；未知旧版本不能重新指向新版。当前 Memory 在每次请求重新装配，旧摘要中的记忆不是权威状态，见 [Memory](MEMORY.md)。

## 验证与未实现范围

### 当前输入估算：第一阶段契约与后续验收

已实现的数据契约明确区分 `ContextEstimate`（estimated）与 `ContextObservation`（reported）。前者带模型身份、独立 contextRevision、计量时间及 ready/pending/unknown 状态；只有 ready 可以携带数值、方法、近似标记和限制说明。pending/unknown 必须使用 null 并给出原因。后者是带 requestId、模型身份、观察时间的单次普通父请求输入事实，不因后续上下文改变而改写或冒充估算。

`ContextUsageSnapshot` 为后续 Web 快照定义 estimate、lastReportedInput、窗口容量、窗口剩余和可用输入余量。纯函数 contextHeadroom 只接受当前估算，不接收累计消耗或最近实测输入：窗口剩余是 W−E 的参考值；可用输入余量是 min(W−R, I)−E，R 来自真实协议生成策略，I 为已核定的独立输入限制。没有独立限制时只使用 W−R；窗口、计数或预留语义未知时相应值为 null。原始负余量保留，仅未来圆环绘制限制在 0–100%。缓存命中不会从 E 中扣除。

**尚未接入的后续阶段**：当前 Web UI 仍显示原有最近请求输入，尚未切换为上述快照；没有新增 tokenizer、token 预估或网络计数。后续须复用真实请求的系统指导、Memory、工具定义、历史投影、最新回答/工具结果、执行日志、思考回传及 read 裁剪规则；默认排除未发送草稿。预览不得生成回答、执行工具、压缩、保存或改变会话状态。没有匹配模型和请求格式的可信计量方法时显示未知；不能把 JSON 字节当精确 token，也不能默认增加网络请求。

刷新绑定会话、模型选择和 contextRevision。回答/工具结果、压缩提交、模型/思考设置、会话切换/恢复和动态请求配置变化后重新计算或置 pending；异步结果若身份或 revision 已过期则丢弃。实测观察只采纳普通父请求，委派/摘要/图片辅助用量不会覆盖它；辅助请求写回的摘要和工具结果参与下一次估算。旧模型实测值仅作为带身份的历史事实，不能套用新模型容量。

后续集成验收至少覆盖：累计消耗增长与占用变化独立；新回答及工具结果进入估算；压缩按新投影重算但累计不减少；切换模型不串用观察和容量；草稿默认排除；未知不显示零；预览与真实准备一致且无执行副作用。累计消费与加权缓存率规则保持，思考计入供应商 output 后不再重复累加。本地字节上限继续独立存在，不新增圆环驱动的自动压缩。

### 已有请求与压缩验证

检查精确 JSON 字节、保护范围、关联 ID、文档版本保留、输入不可变、取消、存储冲突、续跑预算、工具不重放、恢复/fork 和入口展示。verify:context 的固定三回合样例验证旧读取省略及重新读取；真实模型长任务摘要质量尚未验证，不能把该样例当作摘要质量证明。

完整历史仍占内存和磁盘并受 Session 64 MiB 上限约束；JSON 序列化不是内存硬限制。一个过大的近期回合、动态日志或工具定义仍可塞满请求。摘要有损，当前没有主动 token 阈值压缩、服务端上下文溢出恢复、语义最优选取、检索或完整分层上下文系统。
