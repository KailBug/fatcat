# 架构总览与文档索引

## 文档组织约定

架构文档统一放在 `docs/ARCHITECTURE/` 下，本文件作为总览和索引，记录整体边界、跨系统关系及共享决策。

- 各系统在开始设计或实现时建立独立文档。当前已有 `AGENT_LOOP.md`、`SESSION.md`、`TOOLS.md`、`SUBAGENT.md`、`EXECUTION_REPORT.md`、`CONTEXT.md`、`SKILLS.md`、`PROVIDERS.md` 和 `TUI.md`；其他系统文档在需要时建立。
- 系统文档记录该系统的职责、设计决策、接口与数据流，以及分步实现安排和验收方式；按当前需要展开，不要求提前填满所有内容。
- 每份文档明确区分当前已实现内容和计划设计，具体实现安排也标注状态；验证与完成事实以 [PROGRESS.md](../PROGRESS.md) 为准，避免重复维护进度记录。
- 新增系统文档时更新本文件的索引。项目阶段目标仍放在 [ROADMAP.md](../ROADMAP.md)，系统内部的实现安排放在对应架构文档中。
- 系统文档按实际工作需要新增，不提前建立空文档或复杂目录层级。

## 架构维护方式

架构现状与设计安排以本目录的 Markdown 文档为准。模块职责、调用关系或开发方向变化时，同步更新本总览及相关系统文档，区分已实现行为与计划能力；实际验证以 PROGRESS.md 为准。

按用户要求，停止维护 Excalidraw 文件。fatcat-architecture.excalidraw 已随此前提交删除并停止 Git 跟踪，当前工作目录没有该文件；不恢复或维护，不作为当前架构依据。以后如自行保留本地参考副本，也不得提交。

## 近期组织原则（设计方向）

继续保持 CLI / TUI、Session、Loop、模型客户端和 Tools 的清晰职责。新增权限判断应覆盖实际执行入口，子任务也应复用同一权限边界；交互层不承担工具执行规则，Loop 不积累各工具的具体逻辑。

状态分别回答“发生了什么”（成功对话由 Session 保存，当前写入与命令记录由 Tools 保存）、“当前模型需要看到什么”（Context）、“要完成什么以及完成证据”（Task）。2D-8 的 Context 目前只是独立的请求准备模块，处理旧读取内容的请求投影；Task 以及完整分层上下文仍是组织方向，不提前创建空目录或接口。

优先完成读取、修改、验证和交付闭环，再逐步完善恢复与长期记忆。2D-11 按用户要求加入可选 TUI；Web UI、App、Channel 继续后移。核心逻辑不依赖终端输入输出，TUI 复用现有 Session / Loop / Tools，不建立通用渠道框架。

## 当前文档索引

| 文档 | 内容 | 状态 |
| --- | --- | --- |
| [README.md](README.md) | 架构总览、共享决策与文档组织约定 | 已建立 |
| [AGENT_LOOP.md](AGENT_LOOP.md) | CLI、配置与最小 Loop 的设计和实现安排 | 最小 Loop 已实现、验证并通过 review |
| [SESSION.md](SESSION.md) | 内存 Session 与连续对话的边界及实现安排 | 已实现、验证并通过用户 review |
| [TOOLS.md](TOOLS.md) | 通用 read / write / shell、授权及执行记录 | read / write / shell 基线已合入；2D-6 文本搜索已通过 review 并合入 |
| [SUBAGENT.md](SUBAGENT.md) | 默认可用的有界委派、历史隔离及取消 | 2C 已通过 review；2D-4 默认迁移已通过 review 并合入 |
| [EXECUTION_REPORT.md](EXECUTION_REPORT.md) | 按用户回合汇总真实事件、共享记录去重与命令后写入提示 | 2D-5 / 2D-7 / 2D-8 已合入；2D-9 扩充双回合验收 |
| [CONTEXT.md](CONTEXT.md) | 请求预算下的旧读取省略、历史所有权及按需重读 | 2D-8 已验证并合入 |
| [SKILLS.md](SKILLS.md) | 本地及按 subsystem 组织的内置技能、构建资源、通用 read、Session 和权限边界 | 2D-10 含内置补充；验证事实见 PROGRESS |
| [PROVIDERS.md](PROVIDERS.md) | DeepSeek / Kimi / MiMo / Qwen 配置及 provider 开发规范 | 2D-10 新厂商按离线 SDK 合约验收，无新增厂商 API 在线验证 |
| [TUI.md](TUI.md) | 可选终端界面、审批控制与准确的回合 / 用量 / 缓存遥测 | 2D-11 离线及 Windows ConPTY 已验证，待 review；细节见 PROGRESS |

## 当前实现

当前工程已实现 CLI、配置校验、DeepSeek 模型客户端、内存消息循环、纯计算工具及统一错误处理；阶段 2A 已有独立内存 Session 和终端连续对话；阶段 2B 已有统一异步工具集合与显式开启的工作目录读取；阶段 2C 增加显式开启的最小子任务委派；阶段 2D-1 合并为通用 read，并分离 workspace 路径边界与 read 的读取和分页实现；2D-2 增加受控 write，共享有界文本读取模块，并将写入记录与成功对话历史分开。review 修正新增 terminal.ts 统一聊天与确认输入，CLI 注入批准回调，工具负责校验与落实权限。2D-3 新增 shell.ts 与 process.ts，分别持有命令规则/事实与 Windows 进程生命周期，terminal.ts 复用单次确认。2D-4 新增 agent.ts 集中装配父子模型与工具，普通 CLI 默认可委派；仅父请求带任务选择指导，不改变保存的历史。共享基础提示词现集中在 system-prompt.ts，父子 Loop 都使用简洁、行动导向及基于验证结果的编码协作规则。2D-5 新增 execution-report.ts，在交互边界观察事件，汇总当前回合报告；不改变 Loop / Session 返回值，不写入模型历史。2D-6 新增 tools/search.ts，负责 read query 的有界遍历与匹配；read.ts 持有统一 Schema、参数校验与分发，Workspace 和 text-file 继续负责访问与解码边界。2D-7 在 model.ts 发送前检查完整请求字节，model-usage.ts 校验服务用量；Model 的可选观察回调经 Loop 转为元数据事件，execution-report.ts 汇总父子请求和用量。2D-8 新增 context.ts，在完整请求超预算时整理较早成功 read 的请求副本，保留当前/最近回合和完整 Session 历史；具体边界见 [CONTEXT.md](CONTEXT.md)。真实运行可从 CLI 输入任务，经历模型调用与工具结果回传，再输出最终结果。Loop 接口、错误行为与数据流见 [AGENT_LOOP.md](AGENT_LOOP.md)，跨用户回合的历史所有权与连续输入见 [SESSION.md](SESSION.md)，内置工具与文件边界见 [TOOLS.md](TOOLS.md)，委派与请求上限见 [SUBAGENT.md](SUBAGENT.md)。

`tsconfig.json` 使用严格模式与 NodeNext 模块规则，将 `src/`、`tests/`、`scripts/` 编译到 `dist/` 下对应目录。`pnpm run build` 在编译后运行 `scripts/copy-skills.ts` 的构建产物，验证 `src/skill` 并刷新复制到 `dist/src/skill`；运行时从模块相对路径加载这些内置资源，不依赖 cwd。CLI / TUI 共用 `dist/src/cli.js`；`pnpm start` 经 `dist/scripts/start.js` 恢复调用目录后导入该入口，构建和 `.env` 加载仍在包根完成。直接运行 CLI 不读取 INIT_CWD。测试使用 Node 内置运行器。生产依赖为 `openai@7.18.0`（共享 Chat Completions 兼容客户端）、`yaml@2.9.1`（Skill frontmatter 解析）及 `@earendil-works/pi-tui@0.87.1`（可选 TUI 的编辑、Markdown 和终端渲染）。`pnpm run verify:live` 提供显式 DeepSeek 验证；自动化测试保持离线。

2D-9 在脚本与测试层扩充多文件双回合验收，不改变上述生产职责或接口。`scripts/verify-workflow.ts` 通过 `pnpm run verify:workflow` 复用同一 Session、createAgent 与 createTurnReporter；`scripts/fixtures/coding-workflow.ts` 管理临时计价样例、逐回合事实断言及独立复验，供离线测试共用。它检查修复、后续需求、受保护文件、实际命令及每回合新增记录；实际运行结果以 PROGRESS 为准，不将验证脚本视作生产 Task 系统。

2D-10 继续完善单个 Session。`skills.ts` 发现并校验本地元数据，包装通用 read 以加载 Skill 与引用资源；目录仅加入模型请求，加载结果仍由成功历史持有，`kind: skill` 不参与旧读取省略。`providers.ts` 将所选供应商的地址、模型、凭据名称和请求参数限制在小型 profile 中；`model.ts` 通过 createModel 复用同一预算、取消、解析与错误边界。新增三家只有离线合约验收，本轮不发起其 API 在线验证；没有多会话管理、模型自动路由、流式或思考历史。

同阶段的内置 Skill 补充采用 `src/skill/<subsystem>/<skill-name>/SKILL.md`，当前涵盖 tools/workspace-editing、subagent/focused-delegation、context/context-recovery、execution-report/verification-handoff。它们指导 Fatcat 完成用户编码任务，不是 Fatcat 源码开发规范。`src/skills.ts` 继续持有运行时逻辑，内置目录以最低优先级加入已有发现流程；名称保持统一 URI，subsystem 只作组织与元数据。父子读取、成功历史、请求预算和执行权限不变，正文仍按需加载；只在实际 subsystem 任务需要时增加内容，不建空目录或确定性工作流引擎。内置补充的离线与真实验证状态以 PROGRESS 为准。

2D-11 的可选 `--tui` 将视图、输入/审批控制和事件统计分开。启动配置由 CLI 解析并沿用 createAgent；界面读取 Loop / execution_report 的事实，并在 Session.run 成功返回后累计保存回合数，不把屏幕内容或遥测写入模型历史。标准 token 用量与 provider 缓存字段在 model-usage 边界校验，父子请求及进程累计由交互侧汇总。本地请求字节预算、最近父请求的 prompt tokens 和未知的模型 token 窗口分别标注；取消本轮与退出界面有独立生命周期。详见 [TUI.md](TUI.md)。

同阶段修正 CLI 的默认工作目录：普通任务、--chat、--tui 和 --listSkills 默认使用 process.cwd()，--workspace 可覆盖。pnpm start 的专用启动器先根据 INIT_CWD 恢复调用位置，因此默认目录及相对 --workspace 都基于用户调用命令的目录。任务默认提供同级 read / write / shell，write 与 shell 仍分别逐次确认；程序化 createTools 省略目录仍不开放文件访问。Tools.workspaceRoot 来自 createWorkspace 的规范 realpath，agent.ts 将该路径作为父子请求指导，TUI 显示同一值；不会改写 Session 历史或放宽相对路径及权限规则。实现与验证事实见 PROGRESS.md。

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
| Kimi / MiMo / Qwen | 按用户要求加入固定 provider profile；各自模型、认证、区域和请求字段见 PROVIDERS.md；本轮不执行 API 在线验证 |
| `openai@7.18.0` 兼容 SDK | 沿用并复用于四家供应商。禁用自动重试，设置超时及取消信号，关闭 SDK 原始日志 |
| `yaml@2.9.1` | 解析 Skill frontmatter 的引号、多行和结构，避免手写不完整 YAML；边界和拒绝规则见 SKILLS.md |
| `@earendil-works/pi-tui@0.87.1` | 复用 TypeScript 的终端编辑、Markdown、宽度计算与增量绘制；符合现有 Node / Windows 工具链，避免为界面另引 Go 或另一套 Agent 运行时 |

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
- 工具执行：统一校验 JSON 并顺序等待异步执行；程序化基础集合默认 sum，传入工作目录时提供 read / write / shell，CLI 默认选择启动目录；已发现 Skills 时通用 read 也可读取其专属 URI；CLI 父工具集合另默认提供 delegate_task；写入与命令分别授权，支持终端逐次确认或显式策略，按调用 ID 回传结果或错误。

当前数据流：CLI 输入进入内存历史；循环控制请求模型；模型直接回答时结束，提出工具调用时执行工具并记录关联结果，再请求模型，直到得到最终结果或明确终止。

历史采用兼容 SDK 的消息结构；工具结果保留调用 ID。轮次按模型请求计数，工具错误可回传并纠正，服务错误和迭代上限明确终止。详细规则见 [AGENT_LOOP.md](AGENT_LOOP.md)。

## 工程约定

docs/ 之外的仓库文本只使用英文；中文仅用于 docs/ 内。模型输出和用户输入属于运行时数据，可以使用任意语言。pnpm-workspace.yaml 目前仅记录 pnpm 安装时为 openai@7.18.0 自动生成的 minimumReleaseAgeExclude 精确版本项，不定义多包工作区。

## 后续方向（未实现）

Session 持久化、并行或递归 Subagent、Channel、完整任务与分层上下文管理、长期记忆、恢复和成本优化均为计划，见 [ROADMAP.md](../ROADMAP.md)。本文件不将这些方向视为已有架构。
