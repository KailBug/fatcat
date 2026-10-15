# Session：历史、执行领取与持久化

[架构总览](README.md) · [会话操作指南](../GUIDES/SESSIONS.md)

Session 系统区分成功对话、当前持久记录、宿主选择和存储。工作区文件与工具副作用不属于会话事务。

## 状态所有者

| 源码 | 职责 |
| --- | --- |
| `src/session/session.ts` | 内存成功历史、上下文投影与顺序运行；成功后才替换历史 |
| `src/session/agent-session.ts` | 单个活动 record 的唯一所有者；运行领取、检查点、提交/失败收尾和恢复提示 |
| `src/session/manager.ts` | 会话选择、宿主操作互斥、目录准备、项目管理协调与后台目标路由 |
| `src/session/store.ts` | 有界磁盘读写、桶锁、修订和活动 owner 校验，协调跨文件提交 |
| `src/session/record.ts`、`history.ts` | 格式解码、记录约束、完整回合及工具关联校验 |
| `src/session/execution.ts` | 捕获 Session、Project、归属代次与有效工作目录 |
| `src/session/automations.ts` | 任务变更校验与待保存记录，不持有第二份活动状态 |
| `src/session/commands.ts` | chat/TUI 的本地管理命令 |

程序化普通 Session 保留内存入口；日常界面使用 SessionManager.open 和 run。Manager 通过 AgentSession 的防御性快照读取 record，不维护第二份可变副本。跨目录切换先准备目标 Agent，失败则保留当前状态；目录级 Tools/journals 由 workspaceAgentFactory 缓存。

## 持久格式与兼容

存储根见[配置参考](../REFERENCE/CONFIGURATION.md)。Session 位于规范工作目录哈希桶内的 UUID JSON；storageWorkspace 固定原桶，改变有效目录不会移动历史文件。Project 目录单独保存，Session 的 location 只能是独立目录或项目 ID，不能保存可覆盖的项目目录副本。

记录包含版本、身份、名称/时间、修订、完整成功 history、最近未完成 attempt、compaction、自动任务、归属代次/待通知变更及可选 activeOperation。配置凭据、审批、权限和进程遥测不持久化。用户提示、工具参数/结果、网页/文件正文和已加载 Skill 则是明文历史。

- 新写入使用 v2；旧 v1 只读映射为独立会话，不按路径推断 Project。
- 首次成功持久写入原子升级，保留原 ID、历史、attempt、任务、摘要和存储桶；模型随后失败不降回 v1。
- 旧程序不能安全写入新格式或恢复协议。升级前停止旧实例，不支持混用版本并发写同一存储根。
- 单快照上限 64 MiB。解码校验身份、修订、消息与工具关联；成功 history 必须由完整回合构成，attempt 不能混入。
- Project 缺失、损坏或目录不可用时允许查看历史，但拒绝执行，不回退启动目录或独立作用域。

## 执行、提交与中断

开始前持久保存 attempt 和 ownerPid，然后才调用模型/工具；消息检查点更新 attempt。成功时提交完整 history 并清除未完成状态。失败或取消保留原成功历史，另存停止原因与已经发生的消息。只保留最近一次未完成回合，不是永久失败审计日志。

手动 compact 在外部请求前保存带唯一 ID/PID 的 activeOperation；普通回合中的自动 compact 使用已有 attempt。存活 owner 的领取阻止其他进程迁入、删除或覆盖；锁内重验修订，不能只靠界面空闲判断。

收尾写盘失败时 AgentSession 保留 pendingSettlement，后续运行、切换或管理必须先重试同一收尾。强制退出后仅在确认 owner 已退出时允许恢复，不恢复模型调用或旧审批。PID 重用、不完整锁和恢复锁残留可能保守报忙；不是 OS 进程出生身份保证。

恢复在请求副本中添加有界中断说明，要求检查当前文件和进程；不把孤立 tool 消息拼入合法对话。目录/归属变更说明也只投影到下一轮，成功提交后才确认已通知，失败不丢失通知。

AgentSession 延迟根 completed 事件，Manager 释放操作锁后再通知观察器。模型完成但最终保存失败报告 SESSION_STORAGE/stopped，保留用量与副作用；程序化普通 Loop/Session 不承担这一持久事件时序。回调异常或进程崩溃不保证最终报告。

## 管理与跨模块关系

新建保留旧会话；fork 复制完整已完成历史并获得新 ID，自动任务不复制。附件关联/pin 与 Memory 的分支规则分别见 [Attachments](ATTACHMENTS.md) 和 [Memory](MEMORY.md)。

Web UI 未命名新会话可以是 revision 0 草稿。普通回合开始前、成功附件发布、显式命名/fork、创建自动任务都会保存会话；主机 Memory 变更先保存来源会话，再执行修改，因此后续 Memory 错误不撤销已保存草稿。仅浏览资料、查询 Memory/context 或改变空草稿目录/项目绑定不保存。无持久化模式仍只写内存。

同一 Manager 同时只允许一个活动操作，不在运行中切换、清空、命名或管理。后台调度解析任务绑定的 Session，不能依赖 UI 当前选择。目录缓存只复用文件工具与日志，资料访问按真实执行身份装配。

跨文件元数据锁序、提交决定和向前恢复由 [Attachments](ATTACHMENTS.md#元数据提交与恢复) 维护；项目成员与迁入规则归 [Projects](PROJECTS.md)。Context 保存投影参数而不删除完整历史。Tools 的写入、命令和浏览器日志不由 resume 恢复，旧工具结果不证明当前状态。

## 验证与未实现范围

检查应覆盖保存/恢复、v1 升级、非法历史、修订冲突、真实第二进程 run/compact 互斥、领取释放失败、恢复提示、跨目录准备失败及三入口行为。固定存储与注入模型检查不代表真实长任务质量；浏览器会话检查不代表模型连通性。

没有历史加密、自动保留期、导出/备份承诺、文件撤销或自动重放。对话提交无法撤销已写文件、命令副作用、已发送数据或费用。新建会话也不清空目录级进程日志。
