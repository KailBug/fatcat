# Context：请求投影与有界压缩

[架构总览](README.md) · [上下文操作](../GUIDES/SESSIONS.md#context-management)

Context 决定本次发送什么，不拥有原始历史、文件、资料或长期 Memory。完整成功历史始终由 Session 保存。

## 模块职责

| 源码 | 职责 |
| --- | --- |
| `src/context/manager.ts` | CompactionState 校验、projectHistory 与上下文字节/消息统计 |
| `src/context/request.ts` | 完整请求计量与旧 read 省略，无持久状态或 I/O |
| `src/context/compaction.ts` | 规划有界摘要、分块调用及候选结果 |
| `src/context/commands.ts` | 本地统计和显式 compact 入口 |
| `src/session/session.ts`、`agent-session.ts` | 应用投影、回合内自动恢复及摘要持久提交 |

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

摘要及视觉辅助请求计入真实请求/用量；它们不更新界面的聊天上下文 token 容量。压缩后旧的 token 观察清空，等待下一次普通请求。请求多次省略同一结果会多次计入统计，不能据此直接估算费用节省。

附件结果保留不可变来源与解析版本；未知旧版本不能重新指向新版。当前 Memory 在每次请求重新装配，旧摘要中的记忆不是权威状态，见 [Memory](MEMORY.md)。

## 验证与未实现范围

检查精确 JSON 字节、保护范围、关联 ID、文档版本保留、输入不可变、取消、存储冲突、续跑预算、工具不重放、恢复/fork 和入口展示。verify:context 的固定三回合样例验证旧读取省略及重新读取；真实模型长任务摘要质量尚未验证，不能把该样例当作摘要质量证明。

完整历史仍占内存和磁盘并受 Session 64 MiB 上限约束；JSON 序列化不是内存硬限制。一个过大的近期回合、动态日志或工具定义仍可塞满请求。摘要有损，当前没有主动 token 阈值压缩、服务端上下文溢出恢复、语义最优选取、检索或完整分层上下文系统。
