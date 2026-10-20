# 架构总览

[文档首页](../README.md) · [项目边界](../PROJECT.md) · [开发与验证](../DEVELOPMENT.md)

Fatcat 是面向本地编码任务的 TypeScript Agent Harness。CLI、chat、TUI 和本地 Web UI 共用运行核心；界面负责输入、审批展示和结果呈现，核心负责执行、持久化、权限、预算与取消。本文描述当前源码职责，具体操作见使用指南。

## Workspace 包边界

当前 workspace 包含根应用、私有 `@fatcat/runtime`、`@fatcat/commands`、`@fatcat/tui`、`@fatcat/webui`、`@fatcat/cli`，以及开发专用的 `@fatcat/verification`、`@fatcat/eval`。共享执行、能力与持久状态位于 `packages/runtime/src/`，独立编译为该包的 `dist/`，并通过明确的子路径导出 JavaScript 和声明。CLI、TUI、Web UI、测试与验证脚本按包名导入；runtime 不依赖这些调用者。包内仍按领域组织，没有把每个领域强行拆成独立包。

`packages/commands/src/` 持有共享命令、会话标签、参数工具和交互确认状态，通过 `@fatcat/commands` 及明确子路径导出。客户端可依赖 commands 与 runtime，commands 只依赖 runtime；runtime 不反向依赖命令。`packages/cli/src/` 持有 CLI/chat、终端输入与审批展示，以及应用版本读取；CLI 依赖共享核心、commands 和两个可选界面包，界面不反向依赖 CLI；`packages/tui/src/` 通过 `@fatcat/tui` 提供惰性启动入口，保留 App、视图、遥测和终端生命周期；`packages/webui/src/` 通过 `@fatcat/webui` 提供惰性启动入口，持有 HTTP、Controller、浏览器视图和资源；两个客户端包彼此独立。`packages/verification/tests/` 和 `packages/verification/verify/` 集中保留离线契约与环境验证，由 verification 包独立编译；根 `scripts/start.ts` 保留 pnpm 调用目录适配，根命令继续编排构建与验证。验证包只向产品包单向依赖，不暴露库接口，任何产品包都不能导入它。原运行核心路径已移除，不提供兼容转发；运行命令、持久格式、锁与状态所有权不变。构建、导出与依赖规则见[开发规范](../DEVELOPMENT.md#workspace-package-boundaries)。

独立开发包 `@fatcat/eval` 在 `packages/eval/` 维护实验协议、结果校验、统计及自己的离线测试。产品包不得依赖 eval；eval 与 verification 互不依赖。当前 eval 没有产品依赖或公共导出，不执行 Session 或模型；后续适配保持产品运行状态所有权。详见 [Eval](EVAL.md)。

## 调用链与状态归属

一次任务由入口交给 SessionManager，AgentSession 先保存执行领取，再让 Session 在历史副本上调用 Loop。Loop 请求 Model、执行关联工具调用并继续请求，直到最终回答或明确终止。AgentSession 持久提交或记录中断后，入口展示结果与执行报告。

| 层次 | 当前源码 | 唯一职责 |
| --- | --- | --- |
| 入口与交互 | `packages/cli/src/cli.ts`、`packages/cli/src/cli/`、`packages/cli/src/chat.ts`、`packages/cli/src/terminal.ts`、`packages/tui/src/`、`packages/webui/src/` | 启动参数与编排、输入、宿主命令、审批交互、取消与呈现 |
| 宿主命令 | `packages/commands/src/commands.ts`、各能力的 `commands.ts` | 统一分发与按能力归属的解析、帮助和输出；分发与确认生命周期见 [Session](SESSION.md) |
| 装配 | `packages/runtime/src/agent.ts` | 按工作目录准备 Tools/Skills，按实际 Session 绑定父子执行身份与资料访问；装配与缓存边界见 [Agent Loop](AGENT_LOOP.md) |
| 会话 | `packages/runtime/src/session/` | 成功历史、当前记录、运行领取、会话选择和持久存储 |
| 回合 | `packages/runtime/src/loop.ts`、`packages/runtime/src/subagent.ts` | 模型与工具循环、有界委派、请求余额与事件 |
| 模型与上下文 | `packages/runtime/src/model.ts`、`packages/runtime/src/providers.ts`、`packages/runtime/src/context/` | 协议转换、请求投影、完整请求预算和上下文压缩 |
| 工具与安全 | `packages/runtime/src/tools.ts`、`packages/runtime/src/tools/`、`packages/runtime/src/permissions/` | 工具参数/执行事实与权限/资源边界 |
| 项目与资料 | `packages/runtime/src/project/`、`packages/runtime/src/attachments/`、`packages/runtime/src/documents/`、`packages/runtime/src/memory/` | 项目目录、资料关联、不可变原件、派生内容与当前记忆 |
| 调度与证据 | `packages/runtime/src/automation/`、`packages/runtime/src/execution-report.ts` | 有界激活与本回合观察结果，不拥有另一份对话历史 |

以下状态不能混为一体：

- **成功历史与中断记录**由 Session / AgentSession 保存；恢复不重放工具或恢复旧授权。
- **目录级工具日志**记录进程内已发生的写入、命令和浏览器检查；新建会话不撤销副作用，也不清空这些日志。
- **请求上下文**是历史与当前指导的有界投影，不能代替完整历史或当前文件。
- **Project、附件与 Memory 作用域**依实际执行身份校验，不能从同目录、UI 选择或模型提供的 ID 推断。
- **执行报告**说明观察到的事实，不认证模型答案正确，也不是完整 Task 验收系统。

## CLI 启动边界

`packages/cli/src/cli.ts` 是进程入口，仅读取 argv、调用 `runCli()` 并设置退出码。`packages/cli/src/cli/options.ts` 维护参数定义、帮助文本、可选 `--resume` 值的规范化、隐式 chat 选择及组合校验，返回 Node parseArgs 推断的类型化结果；不访问配置、存储或终端。`packages/cli/src/cli/run.ts` 负责本地检查、交互式会话选择、配置/权限装配、客户端分流、输出和宿主清理，导入本身不启动 CLI。包根 `@fatcat/cli` 直接映射到可调用的 runCli，`@fatcat/cli/entry` 映射到执行 argv 的入口；测试/原生验证的内部访问使用 `@fatcat/cli/internal/*`。根启动适配器恢复 pnpm 调用目录后导入 /entry。VERSION 从 CLI 自身清单读取，构建边界检查要求 CLI 与根应用版本一致；旧根 src 路径已删除。可执行入口是实际启动契约，不是旧导入路径的兼容转导出。

组合校验先于帮助/版本等提前返回；非交互的无选择值 `--resume` 先列出会话，再考虑提示为空、TTY 和模型配置检查。自动化配置及监视路径检查也先于模型配置读取。交互选择器在 chat 中复用原 TerminalInput，进入 TUI/Web UI 前关闭；各客户端继续持有自己的运行生命周期，权限决策仍由 PermissionPolicy 负责。参数错误、配置错误及取消的退出码和 stdout/stderr 分工保持现有契约。

`scripts/start.ts` 继续独占 pnpm 的 `INIT_CWD` 恢复；直接执行 CLI 不解释该变量。启动规则见[命令参考](../REFERENCE/COMMANDS.md)，维护约束与注入模型终端检查见[开发说明](../DEVELOPMENT.md)。

## 专题索引

| 责任域 | 文档 |
| --- | --- |
| 回合控制、装配与终止 | [Agent Loop](AGENT_LOOP.md) |
| 会话记录、运行领取与恢复 | [Session](SESSION.md) |
| 历史投影、旧读取省略与 compact | [Context](CONTEXT.md) |
| 通用工具协议、文件操作与执行日志 | [Tools](TOOLS.md) |
| 权限模式、审批和共享执行防护 | [Permissions](PERMISSIONS.md) |
| 独立历史的有界子任务 | [Subagent](SUBAGENT.md) |
| 请求、用量及操作事实的汇总 | [Execution reports](EXECUTION_REPORT.md) |
| 实验协议、评分记录与完整性统计 | [Eval](EVAL.md) |
| 模型协议与能力适配 | [Providers](PROVIDERS.md) |
| 本地指导发现与按需读取 | [Skills](SKILLS.md) |
| 项目目录、迁入和管理 | [Projects](PROJECTS.md) |
| 跨领域元数据提交、锁与恢复 | [Metadata](METADATA.md) |
| 原件、关联、pin 与发布 | [Attachments](ATTACHMENTS.md) |
| 本地解析、视觉请求与来源 | [Documents](DOCUMENTS.md) |
| 用户事实、作用域与修订 | [Memory](MEMORY.md) |
| 会话绑定及独立配置调度 | [Automation](AUTOMATION.md) |
| HTTP(S) 搜索与页面读取 | [Web](WEB.md) |
| 工作区页面执行与证据 | [Browser](BROWSER.md) |
| 终端交互与遥测 | [TUI](TUI.md) |
| 本地 HTTP、界面与预览 | [Web UI](WEBUI.md) |
| 尚未实现的检索、音频和多模态方案 | [RAG 与后续资料能力](RAG.md) |

## 跨模块约束与设计决策

1. 保持简单 Loop 和少量通用工具。能力通过实际任务演进，不为未来系统预建 Graph、插件框架或空接口。
2. 目录级 Tools 可以缓存，Session/Project 身份必须在执行时绑定。后台任务与子任务继承实际目标，不能借用 UI 当前范围。
3. 操作先校验权限、预算和取消；提示词、Skills、资料、Memory 与保存历史均不能提升授权。shell 和命令风险分类不是 OS 沙箱。
4. 副作用与会话提交不是同一事务。失败、取消或存储错误后，必须保留已发生事实；不得声称文件或外部请求自动回滚。
5. 互斥和持久领取保护执行，短锁保护元数据提交。跨文件资料变更使用恢复日志，不能在等待用户、模型或上传网络时持有磁盘锁。
6. 原件、派生内容、Memory 和请求投影分别管理。固定来源不会因重新解析或重建而偷偷指向新版。
7. 核心不依赖终端或 HTTP 展示。新增入口复用现有 Session、Loop、Tools 和 Permissions。

工具链采用 Node.js 24.x、pnpm 11.21.0、ESM/NodeNext 和先编译再运行；精确依赖版本以 [package.json](../../package.json) 与锁文件为准。沿用 Node 的环境文件加载和测试运行器，避免增加无实际需求的打包器或运行时。专用依赖的选择理由放在其所属专题，版本策略与命令见[开发说明](../DEVELOPMENT.md)。

TypeScript 维护参考 pi agent 的相关实际源码和状态所有权，工程规则见 [AGENTS](../../AGENTS.md)。参考项目不构成 Fatcat 依赖或可用能力证明；不维护架构 Excalidraw 文件。

## 验证与演进边界

各专题列出应保持的检查边界与已知缺口，具体命令集中在[开发与验证](../DEVELOPMENT.md)。离线合约、真实 Windows/Edge、公共网络和真实模型分别验证；已有固定样例结果不能代替当前改动的检查。

后续重构沿 workspace 包边界推进，先核对实际装配、状态所有权和生命周期，保留持久化、权限、预算、取消与副作用契约；本次迁包不改变存储格式。Web UI/TUI 的后续要求由各自专题维护。已有资料与 Memory 继续作为兼容基线，质量缺口不因开发重心变化而视为完成。

Graph、Channel/App、远程服务、并行或递归委派、文件恢复检查点和完整 Task 验收系统尚未实现。检索与音频方案暂缓；成本优化须先建立代表性任务、成功率门槛与成本基线。具体顺序由当前任务决定。
