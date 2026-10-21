

<a id="automation-session-binding-and-bounded-scheduling"></a>

# Automation：会话绑定与有界调度

[English](../../en/ARCHITECTURE/AUTOMATION.md) | 简体中文

[架构总览](README.md) · [调度操作](../GUIDES/AUTOMATION.md)

自动任务复用 Session/Loop/Tools，不拥有另一套历史或权限。会话绑定模式继续目标历史；高级 JSON runner 每次激活创建新 Session，两者的持久计数语义不同。

<a id="module-responsibilities"></a>

## 模块职责

| 源码 | 职责 |
| --- | --- |
| `packages/runtime/src/automation/config.ts`、`cron.ts` | 触发器/预算和五字段时间匹配 |
| `tasks.ts`、`tool.ts` | 绑定任务结构与父模型工具 |
| `scheduler.ts`、`files.ts` | 有界队列、轮转、去抖与文本快照 |
| `conversations.ts` | 工作区任务发现、基线、租约与宿主生命周期 |
| `lock.ts`、`runner.ts` | 存储根/工作区独占与独立 JSON 模式 |
| `packages/runtime/src/session/automations.ts` | 无活动状态的任务投影、触发资格/截止信号准备与变更校验 |
| `packages/runtime/src/session/agent-session.ts` | 任务变更提交、持久领取/计数及回合提交 |
| `packages/runtime/src/session/manager.ts` | 后台目标解析与宿主互斥，保持前台选择 |
| `packages/commands/src/automation/commands.ts` | Cron 本地管理命令、帮助及自然语言调度请求转换 |
| `packages/commands/src/commands.ts`、`packages/webui/src/client/cron.ts` | 统一命令分发、Web UI 表单入口 |

用户描述/表单 → 校验并保存绑定 → 空闲发现/激活 → 先持久增加尝试数并领取 → 原执行链 → 保存目标历史和状态 → 更新基线。触发元数据只进入请求指导，文件正文仍由 read 取得。

`automationCommandPrompt` 直接从 `packages/commands/src/automation/commands.ts` 导入：自然语言 `/cron <description>` 只转换为待发送的模型请求；`/cron`、list/pause/resume/delete 由命令处理器调用既有 SessionManager 操作，不调用模型或写入对话历史。列表仍仅展示当前会话绑定的任务；持久计数、权限和后台目标选择不属于命令层。

<a id="identity-persistence-and-switching"></a>

## 身份、持久化与切换

任务归 Session，保存 prompt、trigger、enabled、创建/过期时间、maxRuns/runs、lastStatus 和 lastScheduledAt。运行前与 attempt 一起原子领取，同触发时间不能重复领取；失败、取消消耗次数。崩溃后不自动重放模型或工具。

定义和计数持久，pending 队列、cron 水位和文件基线只在进程内。不补跑离线时段，过期 at 跳过，interval 依创建相位恢复。fork 不复制任务，删除 Session 移除绑定，无持久化模式不创建绑定。

发现限当前工作区，不等于全局 Session 列表或 UI 当前 Project。激活绑定实际 sessionId、locationRevision 和 workspace，执行前重验；项目迁入/改目录原子暂停任务并使旧激活失效。重新启用不重置次数或期限。切换目录更换租约，返回不补跑离开事件。

自动回合不切换前台历史，子任务继承后台实际身份。当前模型工具不能由子任务或自动回合新增/修改调度，也不能写 Memory。

<a id="session-integration-boundaries"></a>

## Session 接入边界

`session/automations.ts` 只接收快照和明确参数，不持有 Manager、活动会话或调度缓存。sessionAutomations 从加载后的记录生成深拷贝任务投影，prepareAutomationRun 校验工作目录、可选 locationRevision、任务存在/启用/期限/次数、运行状态和触发时间，再组合调用方取消与任务到期信号；prepareSessionAutomation 继续准备管理变更，提交由 AgentSession 执行。

Manager 的 listAutomations 先排除其他工作区、项目异常和无任务的摘要，再加载记录、复核工作区并投影。当前会话运行前重新加载持久记录并检查 owner、目录和归属代次，必要时激活新修订；后台任务经目标解析打开独立 Manager，沿用工作目录 Agent 装配，不替换前台选择。后台管理也沿原目标路由和操作锁执行。

资格检查完成后，当前目标才释放外层 busy 标志并进入自身 run 的互斥；后台运行期间前台 Manager 持续处于 busy。所有退出路径保留原 finally 释放顺序。准备函数不增加 runs、不保存记录；真正开始时 AgentSession 原子领取并增加次数，运行入口已取消则不领取，领取后失败或取消计数并收尾。任务到期仍中止当前回合。调度器继续拥有租约、队列和文件基线，不把这些状态迁入 Session 接入模块。

<a id="scheduling-and-file-semantics"></a>

## 调度与文件语义

每 Session 最多 32 个任务，每工作区 128 个有效任务、64 个不同监控文件。默认 20 次/24 小时，允许 1–1000 次和 1 秒至七天。串行执行，每任务至多一个 pending，忙时合并、轮转避免独占，前台优先；任务过期取消当前回合。

触发器字段和数值范围见[配置参考](../REFERENCE/CONFIGURATION.md#automation-json)。会话绑定的 at 必须在创建时仍属未来且早于任务过期；独立 JSON runner 可加载已过期 at，但不会执行它。cron 只支持 Node 本地时间/UTC；夏令时跳过不运行，回拨可匹配两次，不重放启动分钟。

文件触发只接受明确工作区文本路径，每任务 1–32 个、单文件 1 MiB，去抖 1–60 秒。拒绝递归/glob、隐藏/依赖/链接/工作区外，即使 Free to go。约一秒比较内容快照，可检测创建、修改、删除和原子替换；期间变回相同字节可能漏检。

自动回合期间暂停轮询，结束后全部任务重建基线，失败也如此；自身写入不触发其他任务，同时发生的外部修改也会忽略。无效/不可读路径暂停对应绑定任务，独立 runner 则明确失败。

<a id="permissions-and-standalone-runner"></a>

## 权限与独立 runner

任务字段不能授予工具权限或改 provider。Manual 仍需审批，Plan/read-only/shell-deny 保持限制；无交互不能批准待批操作。独占锁只协调同存储根/目录的调度者，不阻止编辑器或其他会话修改文件。

JSON runner 配置一次加载，使用全进程预算和新 Session，重启重置计数/基线。schema 归[配置参考](../REFERENCE/CONFIGURATION.md#automation-json)，启动与结果核对归[操作指南](../GUIDES/AUTOMATION.md#standalone-json-runner)；单次回合或会话存储失败不等于 runner 预算耗尽时一定返回非零。

<a id="verification-and-unimplemented-scope"></a>

## 验证与未实现范围

检查注入时钟、持久领取、失败计数、重复激活、身份失效、租约切换、文件自触发抑制及父子取消。真实临时文件与 Edge 表单回归使用注入模型，不证明自然语言调度质量。

进程必须保持运行；没有 OS 常驻服务、Windows Task Scheduler 集成、离线补跑、webhook、任意 hooks、事件链或 DAG。不是跨任意存储根的恰好一次保证，强杀后锁需核查 owner 后处理。
