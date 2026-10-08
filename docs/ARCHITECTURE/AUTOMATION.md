# 会话绑定的定时任务与文件事件（2D-15）

## 当前交互与范围

用户在普通 chat、TUI 或 Web UI 会话中描述自动任务，父模型通过 `automation` 工具提交结构化触发器，Harness 校验后绑定当前持久 Session。之后每次触发继续该 Session 的历史并保存结果。模型工具成功返回才表示任务已保存；自然语言理解依赖所选模型。

- chat/TUI 支持 `/cron <任务描述>`；无参数列出当前任务，`pause/resume/delete <id>` 本地管理。描述进入模型回合。
- Web UI 侧栏 **Cron tasks** 提供 cron、interval、at、file_changed 表单，选择既有 Session 或新建并绑定；卡片可以跳转会话、暂停、恢复和删除。
- TUI 页脚、会话列表和自动回合有 `[clock]` 标记。Web UI 会话标题最右端显示时钟，自动回合显示来源。标记表示存在绑定，包括暂停或耗尽的任务。
- 后台目标不是当前选中 Session 时，保存到目标会话且不切换用户正在查看的会话。前台和后台串行使用原模型、工具、审批、取消与报告。

Node 24、pnpm 11.21.0、TypeScript、模型 SDK 不变，没有新依赖、Graph 或第二套 Loop。原 `--automation` / `--check-automation` 保留为高级独立 JSON runner；它仍每次创建新的保存会话，其进程预算与会话绑定模式不同。

参考资料核对于 2026-10-02：[Claude Code scheduled tasks](https://code.claude.com/docs/en/scheduled-tasks)、[hooks](https://code.claude.com/docs/en/hooks)、[Pi extensions](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/extensions.md)。采用进程内调度、忙时合并、触发与执行分离、生命周期清理和会话内状态可见的思路；未导入其他 Agent 运行时或照搬其完整机制。

## 模块与数据流

| 模块 | 当前职责 |
| --- | --- |
| `src/automation/config.ts`、`cron.ts` | 触发器与预算校验、五段数字 cron 和 local/UTC 匹配 |
| `tasks.ts`、`tool.ts` | 持久任务字段、父模型工具定义及调用包装；未绑定的调用明确拒绝 |
| `scheduler.ts`、`files.ts` | 注入时间的有界队列、去抖与文本文件内容快照 |
| `conversations.ts` | 工作区任务发现、触发、串行轮转、基线、运行锁和生命周期；界面保留渲染及审批所有权 |
| `lock.ts` | 同一存储根和规范工作区的进程独占锁，交互服务与独立 runner 共用 |
| `runner.ts` | 高级独立 JSON runner、独立 Session、日志及进程预算 |
| `src/session/manager.ts`、`store.ts` | 创建绑定、原子保存领取与次数、继续目标历史、失败记录、修订冲突 |
| `src/agent.ts`、`src/commands.ts` | 父模型工具与时间提示；chat/TUI 命令分发 |
| `src/chat.ts`、`tui/app.ts` | 空闲执行、输入与审批协调、自动回合和会话标记 |
| `webui/controller.ts`、`server.ts` | 状态缓存、目标会话执行、认证的 create/manage API |
| `webui/client/cron.ts`、`app.ts` | Cron 表单和管理、会话右端时钟、自动回合显示 |

用户描述或表单 → 校验并保存绑定 → 空闲轮询 → 持久领取并增加尝试数 → 原 SessionManager / Loop / Tools → 答案及状态保存到目标 Session → 刷新界面和文件基线。

触发时间、任务 ID 和变更路径只加入当次模型 system 请求副本，正文仍是任务提示词，不把内部 metadata JSON 作为用户消息展示。文件正文通过普通 read 获取。

## 持久化与恢复边界

Session 可选 `automations` 数组兼容旧记录。任务保存 ID、prompt、trigger、enabled、创建/过期时间、maxRuns/runs、lastStatus 和 lastScheduledAt。summary 的 automationCount 供列表渲染；普通会话不增加该字段。

在模型或工具执行前，任务领取、running 状态、尝试数及触发时间与 Session 一起原子保存。失败和取消消耗一次尝试，同一触发时间不能重复领取。成功答案沿原历史保存；失败保留原中断记录。崩溃遗留 running 不会自动重放，可核查副作用后显式恢复尚未耗尽的周期任务。不是跨任意存储根的恰好一次执行保证。

fork 不复制任务，删除会话同时删除其中绑定；无持久化模式拒绝创建。配置和计数跨进程保存，但 pending 队列、文件基线和 cron 水位不保存。不补跑离线任务，过去的 at 跳过，interval 按创建时刻的周期相位继续。重启 chat/TUI/Web UI 会发现该工作区所有仍有效的保存任务；单次 CLI 任务退出后不会继续调度。

## 调度、预算与权限

- 每 Session 最多 32 条绑定，工作区最多 128 条有效任务、64 个不同监控文件。默认每任务 20 次和 24 小时有效期；可指定 1–1000 次、1 秒至 7 天。恢复不能重置次数或延长过期时间。
- interval 60 秒至 7 天；at 必须是未来、早于过期时间、带秒及 offset 的 ISO 时间。Web 表单把浏览器本地日期时间转换成明确时间。
- cron 支持五段数字、通配符、列表、范围、步长，星期 0/7 为周日；日和星期都受限时 OR。只支持 local（Node 本机）和 UTC，无秒或命名 IANA 时区。local 夏令时跳过时刻不运行，回拨对应的两个实际匹配分钟可能各运行一次。
- 串行执行，每任务最多一个 pending，忙时重复事件合并；轮转任务避免高频任务独占。前台操作优先，界面空闲才启动。任务过期取消当前回合，保留原父子请求预算。
- Manual 写入和命令仍逐项审批；Plan/read-only/shell-deny 保持原上限。任务字段不能授权或指定新 provider。自动回合以及独立 runner 不能通过模型工具新增或修改任务，子 Agent 不暴露该工具。
- 正常关闭取消活动操作并释放锁；强杀可能留下锁，核查记录 PID 已退出后人工移除报错路径。锁只协调相同存储根的调度者，不阻止编辑器或其他交互会话修改文件。

## 文件触发

只监控显式工作区相对文本路径，每任务 1–32 个、每文件最多 1 MiB，父目录必须存在。约一秒轮询 SHA-256，检测创建、内容修改、删除和原子替换；去抖默认一秒，可设 1–60 秒。无目录递归或 glob；隐藏路径、node_modules、链接和工作区外路径均拒绝，包括 Free to go。

自动回合期间不轮询，结束后为全部任务重新建立基线，失败回合也如此；自动写入不会触发自己或其他任务，该时段同时发生的外部修改也会被忽略。轮询间隙恢复成相同内容的变化可能漏检。无效或不可读文件会暂停对应任务并显示错误，用户修复后再恢复。

## 尚未实现与验证边界

本地 chat/TUI/Web UI 进程必须保持打开。没有 OS 常驻服务、Windows Task Scheduler 安装、离线补跑、自动清理陈旧锁、webhook、完成/失败事件链、任意可执行 hook 或 DAG。

离线测试覆盖注入模型、真实临时文件、持久 Session、绑定与历史、TUI 命令、HTTP API、审批与取消。真实 Edge 验证桌面/窄屏表单、时钟、文件事件、同会话输出、新会话绑定及任务管理；使用注入模型，不等于真实供应商自然语言解析已验证。准确结果见 [PROGRESS.md](../PROGRESS.md)。

## 工作区切换

全局会话列表不扩大自动执行范围：ConversationAutomations 仍只发现当前活动工作区内任务。切换目录后释放旧工作区租约、丢弃其队列/文件基线，在新目录重新建立监控；返回时不补跑离开期间事件。任务 workspace 进入监控签名，已有会话修改目录后重新建立基线。后台执行准备期间保持 Manager 忙碌，跨工作区过期激活拒绝执行；持久计数和原权限继续有效。
