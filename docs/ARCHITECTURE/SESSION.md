# Session：历史、执行领取与持久化

[架构总览](README.md) · [会话操作指南](../GUIDES/SESSIONS.md)

Session 系统区分成功对话、当前持久记录、宿主选择和存储。工作区文件与工具副作用不属于会话事务。

## 状态所有者

| 源码 | 职责 |
| --- | --- |
| `packages/runtime/src/session/session.ts` | 内存成功历史、上下文投影与顺序运行；成功后才替换历史 |
| `packages/runtime/src/session/agent-session.ts` | 单个活动 record 的唯一所有者；运行领取、检查点、提交/失败收尾和恢复提示 |
| `packages/runtime/src/session/manager.ts` | 会话选择、宿主操作互斥、目录准备、项目管理协调与后台目标路由 |
| `packages/runtime/src/session/models.ts` | 无活动状态的保存模型恢复适配；不可用选择保持可读，执行明确失败 |
| `packages/runtime/src/session/attachments.ts` | 无会话选择状态的附件访问适配：传输与清理、清单/下载/移除/删除、文档授权包装及执行身份绑定 |
| `packages/runtime/src/session/projects.ts` | 无活动状态的完整迁入预览组装和项目草稿投影，复用 Project 领域规则 |
| `packages/runtime/src/session/memory.ts` | 无活动会话状态的 Memory 接入规则：作用域、变更、请求转换及迁入统计；在 Manager 的身份/owner 校验边界内使用 |
| `packages/runtime/src/session/store.ts` | 查询规则、项目有效状态投影、桶锁、修订和活动 owner 校验，协调跨文件提交 |
| `packages/runtime/src/session/snapshots.ts` | 无状态的桶路径与发现、有界快照读取、原子发布和文件删除；不解析项目有效状态、不取得事务锁 |
| `packages/runtime/src/session/record.ts`、`history.ts` | 格式解码、记录约束、完整回合及工具关联校验 |
| `packages/runtime/src/session/execution.ts` | 捕获 Session、Project、归属代次与有效工作目录 |
| `packages/runtime/src/session/automations.ts` | 任务列表投影、触发资格与截止信号准备、变更校验及待保存记录，不持有第二份活动状态 |
| `packages/commands/src/session/commands.ts`、`labels.ts` | 本地会话命令和成功切换后的确认失效通知；会话标签与列表格式化 |

程序化普通 Session 保留内存入口；日常界面使用 SessionManager.open 和 run。Manager 通过 AgentSession 的防御性快照读取 record，不维护第二份可变副本。跨目录切换先准备目标 Agent，失败则保留当前状态；目录级 Tools/journals 由 `packages/runtime/src/agent.ts` 的 workspaceAgentFactory 缓存，会话身份及资料访问按运行目标重新绑定，具体边界见 [Agent Loop](AGENT_LOOP.md)。

## 宿主命令边界

`packages/commands/src/commands.ts` 提供 `runInteractiveCommand` 和 `interactiveCommandHelp`，直接组合 Memory、Context、Cron、Skills、Project、Attachment 和会话命令；其中只有显式 compact 会在命令处理中请求模型摘要。自然语言 `/cron` 由入口先转换成普通模型请求，转换本身不执行调度操作。

命令实现按能力归属：Project 的解析、列表、加入预览和确认在 `packages/commands/src/project/commands.ts`，附件列表、导入、移除关联与删除确认在 `packages/commands/src/attachments/commands.ts`，Cron 本地管理及提示转换在 `packages/commands/src/automation/commands.ts`。Context 和 Memory 沿用各自模块。`packages/commands/src/utils/command.ts` 只提供无状态的参数文本解析与输出转义；`packages/commands/src/session/labels.ts` 提供会话标签和列表，避免领域处理器反向依赖分发器的运行时代码。

`runSessionCommand` 与 `sessionCommandHelp` 只覆盖会话命令，完整交互入口和帮助由 `packages/commands/src/commands.ts` 组合。包外从 `@fatcat/commands` 导入统一分发，`Conversation` 与会话命令从 `/session` 导入；`sessionLabel`、`sessionScopeLabel`、`formatSessionList` 从 `/session/labels` 导入，`automationCommandPrompt` 从 `/automation` 导入。包内维持相对导入，共享同一个 Project 确认 WeakMap 和 runtime 的 SessionManager 类身份。内部路径迁移不保留历史转导出。未匹配命令仍返回 undefined，用户参数、校验顺序、错误、输出和 switched 语义不变。

项目加入令牌保存在 Project 命令模块的 WeakMap，仍按 SessionManager 实例绑定预览，不进入历史或持久记录。匹配确认先消费令牌，再校验活动会话并调用 joinProject；失败也不能重用已消费的令牌。取消、成功 project use，以及成功 new/clear/reset/resume/fork 命令清除待确认状态；列表、无参数 resume、workspace 命令和失败的选择操作不清除。切换后的清理由会话入口显式通知项目处理器，不把该交互状态移入 Manager，也不改变程序化 Manager 方法的行为。

领域命令调用既有 SessionManager API；业务状态、权限、互斥和持久提交仍由原模块负责。Web UI 继续使用自己的管理接口，不接入完整终端命令集。开发和测试规则见[开发说明](../DEVELOPMENT.md)，用户语法见[命令参考](../REFERENCE/COMMANDS.md)。

## 持久格式与兼容

存储根见[配置参考](../REFERENCE/CONFIGURATION.md)。Session 位于规范工作目录哈希桶内的 UUID JSON；storageWorkspace 固定原桶，改变有效目录不会移动历史文件。Project 目录单独保存，Session 的 location 只能是独立目录或项目 ID，不能保存可覆盖的项目目录副本。

记录包含版本、身份、名称/时间、修订、完整成功 history、最近未完成 attempt、compaction、自动任务、归属代次/待通知变更及可选 activeOperation。配置凭据、审批、权限和进程遥测不持久化。用户提示、工具参数/结果、网页/文件正文和已加载 Skill 则是明文历史。

- 带 modelSelection 或供应商思考历史的新写入使用 v3，已是 v3 的记录不降级；无模型身份的注入 Session 仍可写 v2。旧 v1/v2 保持可读，v1 只读映射为独立会话，不按路径推断 Project。
- 首次成功持久写入原子升级，保留原 ID、历史、attempt、任务、摘要和存储桶；模型随后失败不降回 v1。
- 旧程序不能安全写入新格式或恢复协议。升级前停止旧实例，不支持混用版本并发写同一存储根。
- 单快照上限 64 MiB。解码校验身份、修订、消息与工具关联；成功 history 必须由完整回合构成，attempt 不能混入。
- Project 缺失、损坏或目录不可用时允许查看历史，但拒绝执行，不回退启动目录或独立作用域。

## 快照文件与存储协调边界

`snapshots.ts` 接收明确的存储根、桶目录、记录或 ID，只处理文件机制。读取核对大小、UTF-8、JSON 和物理桶归属，再交给 `record.ts` 解码；文件句柄关闭后，SessionStore 才通过 `projectProjection` 读取项目当前状态。磁盘记录中的项目 ID 与运行时的有效目录、名称、revision 或 projectError 分开，不缓存项目解析结果，也不因读取而改写旧记录。

快照发布沿用固定 storageWorkspace 桶、64 MiB 上限及临时文件写入 → sync → close → rename → 临时文件清理。删除只处理指定文件，缺失文件仍视为已删除。文件辅助函数不检查业务修订或取得锁，不能代替 SessionStore 的保存/删除入口；Attachment 事务继续通过 Store 注入的发布/删除回调完成既有提交与恢复，不改变日志格式或另建事务层。

SessionStore 保留桶内文件筛选、查询排序、名称/ID 匹配、重复身份检测和各操作的错误处理。普通列表跳过损坏记录；直接按 ID 读取提供明确诊断；项目管理扫描遇到可能隐藏成员的损坏记录必须拒绝操作。不能为复用列表而把项目成员发现改为宽松扫描。桶锁、活动 owner 与 revision 校验、草稿准备、Memory 身份门禁及项目管理编排也继续留在原协调路径。

后续开发约束见[开发说明](../DEVELOPMENT.md#session-snapshot-and-storage-boundaries)。文件层不保存活动会话，不增加缓存，不拥有另一份持久记录；记录格式与跨文件恢复协议分别由原领域模块维护。

## 执行、提交与中断

开始前持久保存 attempt 和 ownerPid，然后才调用模型/工具；消息检查点更新 attempt。成功时提交完整 history 并清除未完成状态。失败或取消保留原成功历史，另存停止原因与已经发生的消息。只保留最近一次未完成回合，不是永久失败审计日志。

手动 compact 在外部请求前保存带唯一 ID/PID 的 activeOperation；普通回合中的自动 compact 使用已有 attempt。存活 owner 的领取阻止其他进程迁入、删除或覆盖；锁内重验修订，不能只靠界面空闲判断。

收尾写盘失败时 AgentSession 保留 pendingSettlement，后续运行、切换或管理必须先重试同一收尾。强制退出后仅在确认 owner 已退出时允许恢复，不恢复模型调用或旧审批。PID 重用、不完整锁和恢复锁残留可能保守报忙；不是 OS 进程出生身份保证。

恢复在请求副本中添加有界中断说明，要求检查当前文件和进程；不把孤立 tool 消息拼入合法对话。目录/归属变更说明也只投影到下一轮，成功提交后才确认已通知，失败不丢失通知。

AgentSession 延迟根 completed 事件，Manager 释放操作锁后再通知观察器。模型完成但最终保存失败报告 SESSION_STORAGE/stopped，保留用量与副作用；程序化普通 Loop/Session 不承担这一持久事件时序。回调异常或进程崩溃不保证最终报告。

## 管理与跨模块关系

新建保留旧会话；fork 复制完整已完成历史并获得新 ID，自动任务不复制。附件关联/pin 与 Memory 的分支规则分别见 [Attachments](ATTACHMENTS.md) 和 [Memory](MEMORY.md)。

Web UI 未命名新会话可以是 revision 0 草稿。普通回合开始前、成功附件发布、显式命名/fork、创建自动任务都会保存会话；主机 Memory 变更先保存来源会话，再执行修改，因此后续 Memory 错误不撤销已保存草稿。仅浏览资料、查询 Memory/context、切换草稿模型或改变空草稿目录/项目绑定不保存。无持久化模式仍只写内存。

同一 Manager 同时只允许一个活动操作，不在运行中切换、清空、命名或管理。后台调度解析任务绑定的 Session，不能依赖 UI 当前选择。目录缓存只复用文件工具与日志，资料访问按真实执行身份装配。

附件宿主操作由 SessionManager 提供，AttachmentUploadTarget 直接从 `session/attachments.ts` 导入。Manager 负责解析目标快照、捕获上传身份、持有草稿 scope token、排队发布、重试待收尾操作，并在发布结果属于当前会话时激活该记录；非持久附件仓库也仍由 Manager 创建和持有。`session/attachments.ts` 只接收明确的仓库、快照或执行身份，不保存当前选择、不持有操作锁、不负责激活或持久化 Session。流式接收、大小核对和 stage 清理由该模块处理，发布回调仍进入 Manager 的原有互斥区。后续扩展沿此边界，不能把整个 Manager 传给访问适配函数，也不能为便利另存一份活动 record。

跨文件元数据锁序、提交决定和向前恢复由 [Metadata](METADATA.md) 维护；项目成员与迁入规则归 [Projects](PROJECTS.md)。Context 保存投影参数而不删除完整历史。Tools 的写入、命令和浏览器日志不由 resume 恢复，旧工具结果不证明当前状态。

Memory 的业务规则集中在 `session/memory.ts`，Manager 保留 MemoryStore 的创建/持有、宿主操作互斥、草稿保存和激活，以及 memoryOperation 的身份与 owner 校验；MemoryChange 直接从 `session/memory.ts` 导入。activate 仍按原会话身份绑定动态访问，每次调用重新校验，不把活动 record 或授权结果交给辅助模块长期持有。AgentSession 继续管理当前用户证据、写入额度和 callId 复用；SessionStore 的元数据锁和持久身份重验不迁移。详细规则见 [Memory](MEMORY.md)。

Automation 接入沿同一边界：`session/automations.ts` 接收记录快照，生成独立任务投影并校验触发资格、组合取消与到期信号；它不加载或激活会话，也不领取任务。Manager 保留当前记录刷新、owner 检查、后台目标装配及宿主互斥，AgentSession 保留任务变更提交、领取计数和回合收尾。调度队列、租约和文件基线仍归 ConversationAutomations。具体顺序与约束见 [Automation](AUTOMATION.md#session-接入边界)。

Project 接入规则集中在 `session/projects.ts`：迁入预览和确认每次读取同一组资料来源，Memory 读取仍经过 Manager 的身份/owner 门禁；草稿投影复用 Project 的记录转换。Manager 保留目标选择、持久 owner 检查、操作锁、Agent 准备与激活，Store 保留成员发现、提交和恢复。改目录的草稿转换在提交前准备；重命名后刷新失败不能撤销已提交的项目名称。详细操作顺序和失败边界见 [Projects](PROJECTS.md#session-接入边界)。

## 验证与未实现范围

### 会话模型选择（第二阶段）

`SessionManager.modelChoices` 返回不含凭据的目录；`setModel(ModelSelection)` 是共享核心的切换入口。操作先取得宿主互斥、重试待收尾提交、校验项目/记录新鲜度，再校验能力与凭据并准备目标运行实例，最后按 revision 保存并激活。运行中、其他进程持有执行领取、并发版本冲突、准备或保存失败均不会发布新选择。revision 0 草稿只更新内存，切换本身不调用生成模型、工具、网络探测或压缩。

`modelSelection` 仅保存 provider、region、workspaceId?、model、thinking，随 SessionSummary 返回。新会话采用宿主启动默认；恢复、fork、工作目录变更保留该会话选择。旧记录没有该字段时在内存采用启动默认，读取不会改文件，下一次真实持久写入升级。恢复时对应连接或能力不可用仍能查看历史，执行报错，必须显式切换，不自动使用另一供应商、区域或 Key。

`createAgent.forModel` 按显式连接快照重建父模型、委派子模型、摘要模型和图片适配；目录级工具和执行日志保持原对象。`forSession` 再绑定实际执行会话、附件与 Memory。调用者替换的 model/tools 不擅自覆盖，未提供切换实现的注入 Agent 明确拒绝。后台任务从自己的持久会话恢复选择。

思考响应保存在 assistant.modelContext，包含来源身份和完整厂商 assistant message；解码核对角色、内容及工具事实与规范历史一致。模型请求只在身份匹配且当前协议允许时回传私有数据，跨模型保留普通文本和工具事实。摘要输入剥离该字段；记录仍受既有大小和历史校验约束。该字段不授予权限、恢复审批或重放工具。具体协议见 [Providers](PROVIDERS.md)。

runtime API 与恢复后的客户端模型标签同步已实现。只读请求预览及消费/实测/估算分离见 [Context](CONTEXT.md#当前输入估算第三阶段已实现的-runtime-接口)；第四阶段的模型菜单、思考滑条、Web 切换路由和圆环/详情已接入同一 Manager，交互与注入 Edge 验证范围见 [Web UI](WEBUI.md#模型思考与上下文控件)。

SessionRecord 的可选 v3 字段 consumption、lastReportedInput 保存合法用量累计与最近普通响应观察；它们由 AgentSession 消费执行事件并随现有持久化边界提交。无字段的旧历史无法回填，读取不改写；预览估算和 contextRevision 只在运行实例中，恢复总是 pending。换模型/压缩保留累计，fork 清空新会话消费与观察。AgentSession 保有状态所有权，纯计量/聚合与校验位于 context 模块；SessionManager 保有活动实例及跨实例的预览结果拒绝规则。用量缺失、覆盖和缓存比例语义以 Context 为准。

检查应覆盖保存/恢复、v1 升级与只读不改写、非法历史/UTF-8/超大文件、错误存储桶、文件发布失败清理与重试、项目状态新鲜度及列表/成员扫描的拒绝差异，以及修订冲突、真实第二进程 run/compact 互斥、领取释放失败、恢复提示、跨目录准备失败及三入口行为。快照与存储边界回归放在 `packages/verification/tests/session/`，项目和附件事务恢复继续在各能力测试中验证。固定存储与注入模型检查不代表真实长任务质量；浏览器会话检查不代表模型连通性。

没有历史加密、自动保留期、导出/备份承诺、文件撤销或自动重放。对话提交无法撤销已写文件、命令副作用、已发送数据或费用。新建会话也不清空目录级进程日志。
