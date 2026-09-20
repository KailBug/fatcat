# 架构总览与文档索引

## 文档组织约定

架构文档统一放在 `docs/ARCHITECTURE/` 下，本文件作为总览和索引，记录整体边界、跨系统关系及共享决策。

- 各系统在开始设计或实现时建立独立文档。当前已有 `AGENT_LOOP.md`、`SESSION.md` 和 `TOOLS.md`；其他系统文档在需要时建立。
- 系统文档记录该系统的职责、设计决策、接口与数据流，以及分步实现安排和验收方式；按当前需要展开，不要求提前填满所有内容。
- 每份文档明确区分当前已实现内容和计划设计，具体实现安排也标注状态；验证与完成事实以 [PROGRESS.md](../PROGRESS.md) 为准，避免重复维护进度记录。
- 新增系统文档时更新本文件的索引。项目阶段目标仍放在 [ROADMAP.md](../ROADMAP.md)，系统内部的实现安排放在对应架构文档中。
- 系统文档按实际工作需要新增，不提前建立空文档或复杂目录层级。

## 当前文档索引

| 文档 | 内容 | 状态 |
| --- | --- | --- |
| [README.md](README.md) | 架构总览、共享决策与文档组织约定 | 已建立 |
| [AGENT_LOOP.md](AGENT_LOOP.md) | CLI、配置与最小 Loop 的设计和实现安排 | 最小 Loop 已实现、验证并通过 review |
| [SESSION.md](SESSION.md) | 内存 Session 与连续对话的边界及实现安排 | 已实现、验证并通过用户 review |
| [TOOLS.md](TOOLS.md) | 工具集合与只读工作目录的边界及实现安排 | 已实现并验证，待用户 review |

## 当前实现

当前工程已实现 CLI、配置校验、DeepSeek 模型客户端、内存消息循环、纯计算工具及统一错误处理；阶段 2A 已有独立内存 Session 和终端连续对话；阶段 2B 新增统一异步工具集合与显式开启的工作目录读取。真实运行可从 CLI 输入任务，经历模型调用与工具结果回传，再输出最终结果。Loop 接口、错误行为与数据流见 [AGENT_LOOP.md](AGENT_LOOP.md)，跨用户回合的历史所有权与连续输入见 [SESSION.md](SESSION.md)，内置工具与文件边界见 [TOOLS.md](TOOLS.md)。

`tsconfig.json` 使用严格模式与 NodeNext 模块规则，将 `src/`、`tests/`、`scripts/` 编译到 `dist/` 下对应目录。CLI 入口为 `dist/src/cli.js`；测试使用 Node 内置运行器。唯一生产依赖为 `openai@7.18.0`，用于 DeepSeek 兼容接口。`pnpm run verify:live` 提供显式真实服务验证；自动化测试保持离线。

## 已确定的约束与决策

| 决策 | 理由 |
| --- | --- |
| 使用 TypeScript | 项目已确定的主语言 |
| 首版支持 Windows 原生运行 | 满足本机运行要求，不引入 WSL、Docker 或远端服务器前提 |
| 先实现简单 Loop | 先验证最小闭环，避免同时建设 Graph 引擎 |
| 第一阶段使用内存历史、单一模型和一个无副作用工具 | 控制范围，验证模型与工具的完整交互 |
| 在实际需要出现时形成抽象 | 避免为未来子系统预建大量空接口 |

## 工具链与模型选择

| 选择 | 状态与理由 |
| --- | --- |
| Node.js 24.x | 已使用。本机已有 24.19.0，沿用现有运行环境；24 系列为 LTS，提供所需的环境文件加载和测试能力 |
| pnpm 11.21.0 | 已使用。沿用本机已有版本并在 packageManager 中固定，利用依赖隔离与共享存储；由 pnpm-lock.yaml 和 `pnpm install --frozen-lockfile` 重现依赖 |
| TypeScript 7.0.2、`@types/node` 24.13.5 | 已安装并锁定精确版本。采用当前稳定编译器及与 Node 主版本匹配的类型；以实际 Windows 编译和测试确认兼容性 |
| ESM + NodeNext，先编译再运行 | 已实现。直接用 `tsc` 和 Node，不增加打包器或开发运行器 |
| Node 内置测试运行器 | 已使用。当前测试需求简单，不增加测试框架依赖 |
| Node 的环境文件加载 | 已使用。由启动命令加载 `.env`，不增加 dotenv 依赖；不在配置模块隐式读取文件 |
| DeepSeek | 已接入并完成真实验证。默认配置为 `deepseek-flash`，使用非思考、非流式 Chat Completions |
| `openai@7.18.0` 兼容 SDK | 已安装并用于 DeepSeek。禁用自动重试，设置超时及取消信号，关闭 SDK 原始日志 |

核对依据（2026-09-18）：[Node.js 发布说明](https://nodejs.org/en/about/previous-releases)、[TypeScript 7.0 发布说明](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)、[TSConfig 参考](https://www.typescriptlang.org/tsconfig/)、[DeepSeek 接入文档](https://api-docs.deepseek.com/)。实际环境与验证结果见 [PROGRESS.md](../PROGRESS.md)。

## 包管理与运行时取舍

已将 npm 锁文件导入 pnpm，并统一使用 pnpm 命令。当前依赖很少，选择 pnpm 的主要理由是依赖管理方式和用户偏好，尚未测量或宣称安装性能提升。沿用本机已有的 11.21.0，暂不为迁移升级到新的主版本。参考 [pnpm 的依赖组织说明](https://pnpm.io/symlinked-node-modules-structure)和[锁文件导入说明](https://pnpm.io/cli/import)。

启动和测试脚本显式串联 `pnpm run build` 与 Node 命令，不依赖自动 pre/post 脚本行为；pnpm 脚本参数直接跟在脚本名后，例如 `pnpm start --help`。

运行时继续使用 Node.js 24。Bun 已支持 Windows，并集成运行、包管理、测试和打包能力；但其官方兼容表仍记录部分 Node API 差异，包括本项目使用的 `node:test`。现阶段先建立已验证的 Node 基线。预计模型请求和工具执行会比本地循环本身更影响耗时，但这只是架构判断，尚无项目性能数据。

若后续单文件分发或本地性能成为明确需求，再单独验证 Bun 的 SDK、子进程、流式输出、取消和测试行为后决定。当前未运行 Bun 兼容测试，也未采用 Bun 专用 API。参考 [Bun Windows 安装支持](https://bun.com/docs/installation)、[Node.js 兼容性](https://bun.com/docs/runtime/nodejs-compat)和[单文件分发](https://bun.sh/docs/bundler/executables)。

## 第一阶段完整闭环（已实现）

以下职责已落地，具体文件和接口见 Agent Loop 文档。

- CLI：接收任务输入、展示模型最终结果和必要错误提示。
- 模型调用：提交消息与工具定义，返回模型响应或工具调用。
- 循环控制：维护内存历史，决定继续或结束，并落实迭代上限。
- 工具执行：统一校验 JSON 并顺序等待异步执行；默认 sum，显式选择工作目录时加入 list_directory 与 read_file，按调用 ID 回传结果或错误。

当前数据流：CLI 输入进入内存历史；循环控制请求模型；模型直接回答时结束，提出工具调用时执行工具并记录关联结果，再请求模型，直到得到最终结果或明确终止。

历史采用兼容 SDK 的消息结构；工具结果保留调用 ID。轮次按模型请求计数，工具错误可回传并纠正，服务错误和迭代上限明确终止。详细规则见 [AGENT_LOOP.md](AGENT_LOOP.md)。

## 工程约定

docs/ 之外的仓库文本只使用英文；中文仅用于 docs/ 内。模型输出和用户输入属于运行时数据，可以使用任意语言。pnpm-workspace.yaml 目前仅记录 pnpm 安装时为 openai@7.18.0 自动生成的 minimumReleaseAgeExclude 精确版本项，不定义多包工作区。

## 后续方向（未实现）

Session 持久化、Subagent、Channel、任务与上下文管理、恢复和成本优化均为计划，见 [ROADMAP.md](../ROADMAP.md)。本文件不将这些方向视为已有架构。
