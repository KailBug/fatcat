# 架构总览与文档索引

## 文档组织约定

架构文档统一放在 `docs/ARCHITECTURE/` 下，本文件作为总览和索引，记录整体边界、跨系统关系及共享决策。

- 各系统在开始设计或实现时建立独立文档。当前已有 `AGENT_LOOP.md`；后续可按需建立 `SESSION.md`、`TOOLS.md` 等文档。
- 系统文档记录该系统的职责、设计决策、接口与数据流，以及分步实现安排和验收方式；按当前需要展开，不要求提前填满所有内容。
- 每份文档明确区分当前已实现内容和计划设计，具体实现安排也标注状态；验证与完成事实以 [PROGRESS.md](../PROGRESS.md) 为准，避免重复维护进度记录。
- 新增系统文档时更新本文件的索引。项目阶段目标仍放在 [ROADMAP.md](../ROADMAP.md)，系统内部的实现安排放在对应架构文档中。
- 系统文档按实际工作需要新增，不提前建立空文档或复杂目录层级。

## 当前文档索引

| 文档 | 内容 | 状态 |
| --- | --- | --- |
| [README.md](README.md) | 架构总览、共享决策与文档组织约定 | 已建立 |
| [AGENT_LOOP.md](AGENT_LOOP.md) | CLI、配置与最小 Loop 的设计和实现安排 | CLI 和配置已实现；模型与工具循环仍为计划 |

## 当前实现

当前工程已有 `src/cli.ts` 和 `src/config.ts`：CLI 提供帮助和本地配置检查，配置模块校验 DeepSeek Key、模型名及最大迭代次数。接口与当前数据流见 [AGENT_LOOP.md](AGENT_LOOP.md)。

`tsconfig.json` 使用严格模式与 NodeNext 模块规则，将 `src/`、`tests/` 编译到 `dist/` 下对应目录。CLI 入口为 `dist/src/cli.js`；测试使用 Node 内置运行器。当前没有生产依赖，没有模型请求、内存历史、工具执行或循环控制。

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
| DeepSeek | 用户已指定。默认配置为 `deepseek-flash`；当前只校验本地字段 |
| `openai` 兼容 SDK | 计划。按 DeepSeek 官方 Node.js 示例用于其 Chat Completions 接口；在实际模型接入时安装，本轮不提前增加生产依赖 |

核对依据（2026-09-18）：[Node.js 发布说明](https://nodejs.org/en/about/previous-releases)、[TypeScript 7.0 发布说明](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/)、[TSConfig 参考](https://www.typescriptlang.org/tsconfig/)、[DeepSeek 接入文档](https://api-docs.deepseek.com/)。实际环境与验证结果见 [PROGRESS.md](../PROGRESS.md)。

## 包管理与运行时取舍

已将 npm 锁文件导入 pnpm，并统一使用 pnpm 命令。当前依赖很少，选择 pnpm 的主要理由是依赖管理方式和用户偏好，尚未测量或宣称安装性能提升。沿用本机已有的 11.21.0，暂不为迁移升级到新的主版本。参考 [pnpm 的依赖组织说明](https://pnpm.io/symlinked-node-modules-structure)和[锁文件导入说明](https://pnpm.io/cli/import)。

启动和测试脚本显式串联 `pnpm run build` 与 Node 命令，不依赖自动 pre/post 脚本行为；pnpm 脚本参数直接跟在脚本名后，例如 `pnpm start --help`。

运行时继续使用 Node.js 24。Bun 已支持 Windows，并集成运行、包管理、测试和打包能力；但其官方兼容表仍记录部分 Node API 差异，包括本项目使用的 `node:test`。现阶段先建立已验证的 Node 基线。预计模型请求和工具执行会比本地循环本身更影响耗时，但这只是架构判断，尚无项目性能数据。

若后续单文件分发或本地性能成为明确需求，再单独验证 Bun 的 SDK、子进程、流式输出、取消和测试行为后决定。当前未运行 Bun 兼容测试，也未采用 Bun 专用 API。参考 [Bun Windows 安装支持](https://bun.com/docs/installation)、[Node.js 兼容性](https://bun.com/docs/runtime/nodejs-compat)和[单文件分发](https://bun.sh/docs/bundler/executables)。

## 第一阶段完整闭环（计划，尚未完成）

CLI 帮助和本地配置检查已经实现；以下是后续完整闭环的目标职责。

- CLI：接收任务输入、展示模型最终结果和必要错误提示。
- 模型调用：提交消息与工具定义，返回模型响应或工具调用。
- 循环控制：维护内存历史，决定继续或结束，并落实迭代上限。
- 工具执行：校验参数，执行示例工具，返回与调用关联的结果或错误。

计划数据流：CLI 输入进入内存历史；循环控制请求模型；模型直接回答时结束，提出工具调用时执行工具并记录关联结果，再请求模型，直到得到最终结果或明确终止。

上述内容只表示职责边界，不规定文件数量、类结构或接口签名。具体模块、消息结构、工具协议、错误行为和迭代计数方式，在实现时按实际代码记录。

## 后续方向（未实现）

Session、Subagent、Channel、任务与上下文管理、恢复和成本优化均为计划，见 [ROADMAP.md](../ROADMAP.md)。本文件不将这些方向视为已有架构。
