# 架构总览

[文档首页](../README.md) · [项目边界](../PROJECT.md) · [开发与验证](../DEVELOPMENT.md)

Fatcat 是面向本地编码任务的 TypeScript Agent Harness。CLI、chat、TUI 和本地 Web UI 共用运行核心；界面负责输入、审批展示和结果呈现，核心负责执行、持久化、权限、预算与取消。本文描述当前源码职责，具体操作见使用指南。

## 调用链与状态归属

一次任务由入口交给 SessionManager，AgentSession 先保存执行领取，再让 Session 在历史副本上调用 Loop。Loop 请求 Model、执行关联工具调用并继续请求，直到最终回答或明确终止。AgentSession 持久提交或记录中断后，入口展示结果与执行报告。

| 层次 | 当前源码 | 唯一职责 |
| --- | --- | --- |
| 入口与交互 | `src/cli.ts`、`src/chat.ts`、`src/terminal.ts`、`tui/`、`webui/` | 输入、宿主命令、审批交互、取消与呈现 |
| 装配 | `src/agent.ts` | 按工作目录准备 Tools/Skills，按实际 Session 绑定父子执行身份与资料访问；装配与缓存边界见 [Agent Loop](AGENT_LOOP.md) |
| 会话 | `src/session/` | 成功历史、当前记录、运行领取、会话选择和持久存储 |
| 回合 | `src/loop.ts`、`src/subagent.ts` | 模型与工具循环、有界委派、请求余额与事件 |
| 模型与上下文 | `src/model.ts`、`src/providers.ts`、`src/context/` | 协议转换、请求投影、完整请求预算和上下文压缩 |
| 工具与安全 | `src/tools.ts`、`src/tools/`、`src/permissions/` | 工具参数/执行事实与权限/资源边界 |
| 项目与资料 | `src/project/`、`src/attachments/`、`src/documents/`、`src/memory/` | 项目目录、资料关联、不可变原件、派生内容与当前记忆 |
| 调度与证据 | `src/automation/`、`src/execution-report.ts` | 有界激活与本回合观察结果，不拥有另一份对话历史 |

以下状态不能混为一体：

- **成功历史与中断记录**由 Session / AgentSession 保存；恢复不重放工具或恢复旧授权。
- **目录级工具日志**记录进程内已发生的写入、命令和浏览器检查；新建会话不撤销副作用，也不清空这些日志。
- **请求上下文**是历史与当前指导的有界投影，不能代替完整历史或当前文件。
- **Project、附件与 Memory 作用域**依实际执行身份校验，不能从同目录、UI 选择或模型提供的 ID 推断。
- **执行报告**说明观察到的事实，不认证模型答案正确，也不是完整 Task 验收系统。

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
| 模型协议与能力适配 | [Providers](PROVIDERS.md) |
| 本地指导发现与按需读取 | [Skills](SKILLS.md) |
| 项目目录、迁入和管理 | [Projects](PROJECTS.md) |
| 原件、关联、pin 与元数据恢复 | [Attachments](ATTACHMENTS.md) |
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

后续 runtime 重构先核对实际装配、状态所有权和生命周期，保留持久化、权限、预算、取消与副作用契约；尚未确定新的模块布局或存储格式。Web UI/TUI 的后续要求由各自专题维护。已有资料与 Memory 继续作为兼容基线，质量缺口不因开发重心变化而视为完成。

Graph、Channel/App、远程服务、并行或递归委派、文件恢复检查点和完整 Task 验收系统尚未实现。检索与音频方案暂缓；成本优化须先建立代表性任务、成功率门槛与成本基线。具体顺序由当前任务决定。
