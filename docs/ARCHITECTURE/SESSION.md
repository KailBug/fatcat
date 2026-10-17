# Session：历史、执行领取与持久化

[架构总览](README.md) · [会话操作指南](../GUIDES/SESSIONS.md)

Session 系统区分成功对话、当前持久记录、宿主选择和存储。工作区文件与工具副作用不属于会话事务。

## 状态所有者

| 源码 | 职责 |
| --- | --- |
| `src/session/session.ts` | 内存成功历史、上下文投影与顺序运行；成功后才替换历史 |
| `src/session/agent-session.ts` | 单个活动 record 的唯一所有者；运行领取、检查点、提交/失败收尾和恢复提示 |
| `src/session/manager.ts` | 会话选择、宿主操作互斥、目录准备、项目管理协调与后台目标路由 |
| `src/session/attachments.ts` | 无会话选择状态的附件访问适配：传输与清理、清单/下载/移除/删除、文档授权包装及执行身份绑定 |
| `src/session/memory.ts` | 无活动会话状态的 Memory 接入规则：作用域、变更、请求转换及迁入统计；在 Manager 的身份/owner 校验边界内使用 |
| `src/session/store.ts` | 有界磁盘读写、桶锁、修订和活动 owner 校验，协调跨文件提交 |
| `src/session/record.ts`、`history.ts` | 格式解码、记录约束、完整回合及工具关联校验 |
| `src/session/execution.ts` | 捕获 Session、Project、归属代次与有效工作目录 |
| `src/session/automations.ts` | 任务列表投影、触发资格与截止信号准备、变更校验及待保存记录，不持有第二份活动状态 |
| `src/session/commands.ts`、`labels.ts` | 本地会话命令和成功切换后的确认失效通知；会话标签与列表格式化 |

程序化普通 Session 保留内存入口；日常界面使用 SessionManager.open 和 run。Manager 通过 AgentSession 的防御性快照读取 record，不维护第二份可变副本。跨目录切换先准备目标 Agent，失败则保留当前状态；目录级 Tools/journals 由 `src/agent.ts` 的 workspaceAgentFactory 缓存，会话身份及资料访问按运行目标重新绑定，具体边界见 [Agent Loop](AGENT_LOOP.md)。

## 宿主命令边界

`src/commands.ts` 提供 `runInteractiveCommand` 和 `interactiveCommandHelp`，直接组合 Memory、Context、Cron、Skills、Project、Attachment 和会话命令；其中只有显式 compact 会在命令处理中请求模型摘要。自然语言 `/cron` 由入口先转换成普通模型请求，转换本身不执行调度操作。

命令实现按能力归属：Project 的解析、列表、加入预览和确认在 `src/project/commands.ts`，附件列表、导入、移除关联与删除确认在 `src/attachments/commands.ts`，Cron 本地管理及提示转换在 `src/automation/commands.ts`。Context 和 Memory 沿用各自模块。`src/utils/command.ts` 只提供无状态的参数文本解析与输出转义；`src/session/labels.ts` 提供会话标签和列表，避免领域处理器反向依赖分发器的运行时代码。

`runSessionCommand` 与 `sessionCommandHelp` 只覆盖会话命令，完整交互入口和帮助由 `src/commands.ts` 组合。`Conversation` 类型仍在会话命令模块；`sessionLabel`、`sessionScopeLabel`、`formatSessionList` 直接从 `session/labels.ts` 导入，`automationCommandPrompt` 直接从 `automation/commands.ts` 导入。内部路径迁移不保留历史转导出。未匹配命令仍返回 undefined，用户参数、校验顺序、错误、输出和 switched 语义不变。

项目加入令牌保存在 Project 命令模块的 WeakMap，仍按 SessionManager 实例绑定预览，不进入历史或持久记录。匹配确认先消费令牌，再校验活动会话并调用 joinProject；失败也不能重用已消费的令牌。取消、成功 project use，以及成功 new/clear/reset/resume/fork 命令清除待确认状态；列表、无参数 resume、workspace 命令和失败的选择操作不清除。切换后的清理由会话入口显式通知项目处理器，不把该交互状态移入 Manager，也不改变程序化 Manager 方法的行为。

领域命令调用既有 SessionManager API；业务状态、权限、互斥和持久提交仍由原模块负责。Web UI 继续使用自己的管理接口，不接入完整终端命令集。开发和测试规则见[开发说明](../DEVELOPMENT.md)，用户语法见[命令参考](../REFERENCE/COMMANDS.md)。

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

附件宿主操作由 SessionManager 提供，AttachmentUploadTarget 直接从 `session/attachments.ts` 导入。Manager 负责解析目标快照、捕获上传身份、持有草稿 scope token、排队发布、重试待收尾操作，并在发布结果属于当前会话时激活该记录；非持久附件仓库也仍由 Manager 创建和持有。`session/attachments.ts` 只接收明确的仓库、快照或执行身份，不保存当前选择、不持有操作锁、不负责激活或持久化 Session。流式接收、大小核对和 stage 清理由该模块处理，发布回调仍进入 Manager 的原有互斥区。后续扩展沿此边界，不能把整个 Manager 传给访问适配函数，也不能为便利另存一份活动 record。

跨文件元数据锁序、提交决定和向前恢复由 [Attachments](ATTACHMENTS.md#元数据提交与恢复) 维护；项目成员与迁入规则归 [Projects](PROJECTS.md)。Context 保存投影参数而不删除完整历史。Tools 的写入、命令和浏览器日志不由 resume 恢复，旧工具结果不证明当前状态。

Memory 的业务规则集中在 `session/memory.ts`，Manager 保留 MemoryStore 的创建/持有、宿主操作互斥、草稿保存和激活，以及 memoryOperation 的身份与 owner 校验；MemoryChange 直接从 `session/memory.ts` 导入。activate 仍按原会话身份绑定动态访问，每次调用重新校验，不把活动 record 或授权结果交给辅助模块长期持有。AgentSession 继续管理当前用户证据、写入额度和 callId 复用；SessionStore 的元数据锁和持久身份重验不迁移。详细规则见 [Memory](MEMORY.md)。

Automation 接入沿同一边界：`session/automations.ts` 接收记录快照，生成独立任务投影并校验触发资格、组合取消与到期信号；它不加载或激活会话，也不领取任务。Manager 保留当前记录刷新、owner 检查、后台目标装配及宿主互斥，AgentSession 保留任务变更提交、领取计数和回合收尾。调度队列、租约和文件基线仍归 ConversationAutomations。具体顺序与约束见 [Automation](AUTOMATION.md#session-接入边界)。

## 验证与未实现范围

检查应覆盖保存/恢复、v1 升级、非法历史、修订冲突、真实第二进程 run/compact 互斥、领取释放失败、恢复提示、跨目录准备失败及三入口行为。固定存储与注入模型检查不代表真实长任务质量；浏览器会话检查不代表模型连通性。

没有历史加密、自动保留期、导出/备份承诺、文件撤销或自动重放。对话提交无法撤销已写文件、命令副作用、已发送数据或费用。新建会话也不清空目录级进程日志。
