

<a id="eval-experiment-protocol-and-result-statistics"></a>

# Eval：实验协议与结果统计

[English](../../en/ARCHITECTURE/EVAL.md) | 简体中文

[架构总览](README.md) · [开发检查与证据要求](../DEVELOPMENT.md#evaluation-evidence-requirements)

`packages/eval` 是独立开发包，管理实验定义、注入模型的 Session 执行、结果记录和统计。它通过现有包导出调用 runtime 的 Session、Loop、Context、工具及存储，所有权仍在 runtime。产品包不依赖它；它与 verification 互不依赖。真实模型执行、公开数据下载、整轮预算调度和评测 CLI 尚未实现。

<a id="modules-and-references"></a>

## 模块与参考

| 模块 | 职责 |
| --- | --- |
| `src/experiment.ts` | `Experiment`、严格配置解析、版本化来源引用和实验 SHA-256 摘要 |
| `src/result.ts` | `EvalResult`、执行与评分状态、用量覆盖和 JSON 序列化／读取 |
| `src/summary.ts` | 配置绑定、逐次结果完整性和统计；返回可 JSON 序列化的摘要及全部记录 |
| `src/validation.ts` | 上述边界共同使用的标量、对象和摘要编码校验 |
| `src/artifacts.ts` | 本地内容哈希、受目录约束的读取、独占证据写入及实际代码／构建／环境身份 |
| `src/materials.ts` | 校验数据、提示、策略和单独存放的参考答案 |
| `src/session-runner.ts` | 经 runtime 执行一次隔离尝试；事件、用量、取消、证据、清理与独立评分 |
| `src/promptfoo-provider.ts` | 将样本／次数交给 runner，返回输出及结果元数据的薄 provider |
| `src/harbor-result.ts` | 离线读取绑定哈希的 Harbor 单步骤 trial 结果；保留 reward、异常和可空用量，不另行评分 |
| `tests/`、`scripts/test.ts` | 本包合成数据、文件往返、统计与包集成回归；源码清单驱动的离线入口 |

组织方式参考 Maka `packages/eval` 的实验／结果分离及严格解码（参考提交 `8686793e5d051018c61e53350e542992d19d5311`）；类型和显式函数结构参考 pi `usage-totals.ts`（参考提交 `3daa20280f6a7c7cbe0935680c9a38fdc3863005`）及其 SDK 的显式依赖装配。这是针对 Fatcat 契约的独立实现，没有迁入 Maka 的 Harbor、Fleet、代理网络或重试选择机制。Eval 声明 `@fatcat/runtime` 依赖，并将开发依赖 `promptfoo` 固定为 `0.124.1`，用于真实 provider 加载器集成。Provider 仅从 `promptfoo/contracts` 导入类型，避开根类型入口无关的数据库驱动声明，不放宽 TypeScript 检查。Workspace 允许 esbuild 必需的安装构建。

固定版本的 promptfoo 依赖图当前有 peer 范围不匹配：OpenTelemetry API（1.10.0，而 SDK 要求低于 1.10）、nunjucks/chokidar（5 与 3）、MongoDB/gcp-metadata（9 与 7）。本次使用的内存 provider 路径通过验证；遥测导出、watch 模式及数据库集成未验证。保留这些上游兼容性警告，不通过关闭 peer 检查或未经验证的覆盖配置隐藏它们。

<a id="experiment-definitions"></a>

## 实验定义

`schemaVersion` 为 `fatcat.eval.v1`。解析器拒绝缺失／多余字段、非法数字、重复样本和未知版本，并复制嵌套数据。实验包含：

- `id`、完整 Git SHA、`dirty`，以及具体 OS／Node／pnpm 环境标识。
- `evidence`：`synthetic`、`injected` 或 `live`；`level`：`contract`、`model_quality` 或 `task_acceptance`。二者独立，合成的任务验收结果仍是合成证据。
- 供应商、模型 ID 和非秘密生成参数。参数仅接受有限 JSON 标量；拒绝常见凭据字段。该检查不是通用脱敏器，调用者不得传入真实 Key、私人正文或完整运行配置。
- 数据 ID、版本、manifest 的来源及 SHA-256；manifest 应定位固定输入、参考答案与样本身份。`sampleIds` 是所声明版本的完整题目清单，开发／留出集为其不相交子集；选择只能来自声明的一个 split。
- `coverage` 为 `subset` 或 `full`；只有选择等于完整 `sampleIds` 才能使用 `full`。这是对已声明清单的一致性检查，不认证它与官方题库一致，也不证明官方运行环境未改变。数据接入方仍须核对版本、许可、完整清单及语料裁剪。
- 提示、策略及评分器各自的版本、来源和内容 SHA-256；重复次数；每次／整轮的请求、token、时间及可选美元上限。`costUsd: null` 表示未声明金额限制，不表示免费。

来源可以是可恢复的仓库相对路径或固定外部资源。协议解析器不读取文件、不访问网络、不验证 Git 对象或实际内容。下面的注入执行适配只支持本地文件，校验哈希，并核对代码／环境与当前 checkout 一致。模型别名或外部服务行为仍可能变化，可定位配置不保证输出逐字相同。正式对照先使用干净提交；`dirty: true` 可记录诊断，但 v1 不保存未提交补丁或未跟踪文件，不能宣称可复现。

`experimentDigest()` 对完整解析结果按对象键排序后计算 SHA-256，数组保持声明顺序。结果不仅绑定实验 ID，还绑定此摘要；改动代码、模型参数、样本、提示、策略、预算或评分器后不能混用旧结果。

<a id="results-and-grading"></a>

## 结果与判分

每条 `fatcat.eval.result.v1` 记录使用实验 ID／摘要、样本 ID 和从 1 开始的 repetition 定位。重复实验与基础设施重试不是同一概念；v1 每个计划位置只接收一条终态记录，不支持覆盖、重试后挑选或断点续跑。注入执行适配在执行前原子占用对应位置。

执行 `status` 为 `completed`、`failed`、`timeout`、`cancelled` 或 `infra_error`。未完成状态必须有 `failureReason`，评分为 `not_assessed`。正常完成可评分 `passed`、`failed` 或尚未评分；已评分必须有理由和来源／SHA-256 证据。`completed` 不自动意味着通过。[执行报告](EXECUTION_REPORT.md) 的 `taskVerification: not_assessed` 保持不变，评测判定由独立评分器提供；这里校验记录形状，不执行或认证评分器。

`usage.requests` 是记录范围内观察到的请求尝试数，不等于供应商确认计费次数。`reportedRequests` 表示其中取得合法用量的数量；输入／输出为已知请求的小计，缺失为 null。缓存命中是输入的子集，不再次加到输入总量，也不在未报告时补零。汇总溢出保持未知。只有已完整取得用量时才可记录费用，并必须注明 `estimated`／`reported` 和价格／账单来源；未知价格写 null。失败和取消不删除之前已观察到的用量或费用。跨类别费用不冒充统一的实测总费用。

<a id="summary-definitions"></a>

## 汇总口径

`summarizeExperiment()` 拒绝错配实验、未知样本、越界次数及重复记录。计划数量是 `selectedIds.length × repetitions`；所有次数的记录均保留并按样本／次数排序，不只挑最好一次。

- 缺记录时 `complete: false`，报告 planned／recorded／missing；最终 `successRate` 为 null。
- 所有计划位置都有记录且正常完成的记录均已评分时，成功比例为 passed／planned。失败、超时、取消、基础设施错误仍在分母内，并各自列数。这是本地尝试成功比例，不宣称官方 benchmark 分数或 pass@k。
- 正常回答但未评分也使最终成功比例为 null。失败终态并不被误认为待补评分。
- 用量展示已知小计和请求覆盖；只有完整实验且全部请求有输入／输出计数才提供完整总量。无任何已知值时保持 null。
- 费用只有所有计划记录都有同一种依据的费用且求和有限时才汇总；否则为 null，逐条记录仍保留。JSON 的 null 应显示为 `unknown`，不能显示为 0。

合成示例见 `packages/eval/tests/fixtures/experiments.ts`：五次记录包括通过、回答错误、超时、取消和环境错误，成功比例为 1/5；用量仅两次已知、费用未知。它用于测试统计程序，不是 Fatcat 实际成绩。

<a id="injected-session-execution"></a>

## 注入模型的 Session 执行

包内执行入口是 `runSessionEvaluation({ experiment, sourceRoot, outputRoot }, { createTransport }, { sampleId, repetition }, signal?)`。先构建，再经 pnpm 调用，以便记录实际 pnpm 版本。`evidence` 必须为 `injected`，不会回退到真实 fetch 或加载凭据。调用者提供受信任的 transport 工厂，每次尝试创建独立 transport 状态。这是显式测试依赖，不是任意 transport 代码的沙箱。

材料使用 UTF-8 JSON／文本，通过相对 `sourceRoot` 的路径和内容 SHA-256 引用：

- 数据集：`{ "samples": [{ "id": "read", "prompt": "Read note.txt and return its color.", "files": [{ "path": "note.txt", "artifact": { "source": "note.txt", "sha256": "<64 hex characters>" } }] }] }`。题目清单必须与实验一致；工作区路径拒绝越界、隐藏路径段、`node_modules`、Windows 设备名及歧义后缀。每题最多 64 个文件；每个来源必须是源目录内不超过 1 MiB 的普通文件。
- 提示：非空纯文本，放在样本指令之前。
- 策略：`{ "permission": "read-only", "maxRequestBytes": 262144, "requestTimeoutMs": 5000, "autoCompaction": true }`；也支持 `workspace-write`。Shell 执行被拒绝，未启用 web／browser 工具；文件权限仍由 runtime 执行。
- 评分：`{ "type": "exact-match", "answers": { "read": "violet" } }`，每个声明样本恰有一个非空答案。答案不进入工作区或模型输入；这个简单评分器判断答案文本，不构成编码任务验收。

模型使用 runtime 校验后的供应商／模型身份，参数必须恰为 `region`、`thinking`；不支持的额外参数直接拒绝，不会静默忽略。证据记录解析后的模型选择、runtime 生成默认值和实际准备的请求正文，不记录 SDK 凭据头；也记录实际 Git SHA／dirty、OS／Node／pnpm 版本，以及 runtime／eval 已编译 JavaScript 的摘要。必须先构建：该摘要标识执行产物，但不能证明过期构建与源码提交一致。

每次尝试创建独立临时工作区、SessionStore、SessionManager 和 Agent。真实文件工具、Context 准备、模型解码与 Session 持久化均通过注入 transport 执行。请求事件提供用量；缺失用量及未定价费用保持未知。Runner 传递调用者取消信号和单次截止时间，等待 runtime 结束，保存历史／事件后才删除自己生成的临时目录。Runtime 请求额度来自 `perAttempt.requests`；token、金额和整轮限制仍是声明，等待 KAI-23 实施。截止时间依赖注入 transport 配合取消及 runtime 取消机制，不保证强制结束进程。

输出独占写入 `outputRoot/<experimentDigest>/<sha256(sampleId)>-<repetition>/`：

| 文件 | 含义 |
| --- | --- |
| `evidence.json` | 完整实验、实测执行身份、请求正文、事件、Session 快照、回答和清理前的执行结果 |
| `grade.json` | 仅正常完成时生成：独立精确匹配判定、期望／实际答案及带哈希的执行证据引用 |
| `result.json` | 协议结果，包含最终状态、评分引用、耗时、用量和未知费用 |

材料／配置错误在占用尝试位置前失败。占用后，普通准备／运行错误生成终态记录；清理失败使最终状态为 `infra_error`。证据写入失败会保留临时状态供诊断；磁盘故障或进程终止可能留下不完整输出目录。重复占用（包括不完整目录）直接失败，不覆盖或续跑。证据含任务内容和历史；使用非秘密夹具，并保护输出目录。

在 promptfoo 中，由受信任的包装类继承 `FatcatProvider` 并在构造函数注入 transport，遵循[自定义 JavaScript provider 接口](https://www.promptfoo.dev/docs/providers/custom-api/)。配置仍为 `{ experiment, sourceRoot, outputRoot }`。使用提示 `{{sampleId}}`、测试变量 `{ sampleId }`、`cache: false`、`repeat: experiment.repetitions`；promptfoo 从零开始的重复索引转换为从一开始的次数。Provider 拒绝未追踪的替代提示文本，并在 metadata 中返回权威结果及证据位置。Promptfoo 断言和 runtime 执行报告都不替代独立保存的评分。

可运行示例见 `tests/fixtures/session.ts`、`tests/fixtures/promptfoo-provider.ts`、`tests/fixtures/promptfoo-run.mjs`。根构建后运行 `pnpm --filter @fatcat/eval test`，或只运行 `pnpm --filter @fatcat/eval exec node --test dist/tests/promptfoo.test.js`。后者在独立进程、临时配置目录和筛选后的环境变量中调用固定版本的真实 promptfoo 加载器，并阻止出站 fetch／HTTP／socket。0.124.1 即使关闭遥测也会尝试发送一次“遥测已关闭”通知；夹具在本地拒绝该请求并断言已知行为，不发送任何遥测或模型请求。

基线和候选是两份完整实验配置。改变提示／策略／模型身份会改变摘要和输出目录；不得重标旧记录，也不得用历史 Git SHA 冒充运行中的 checkout。注入对照测试验证这种隔离，不代表模型质量提高。Promptfoo 夹具将两题各跑两遍，其中一题故意答错：四次执行正常完成，两次评分通过，独立汇总为 0.5。测试产物为临时文件，断言完成后删除。

<a id="harbor-result-evidence"></a>

## Harbor 结果证据

`readHarborTrialResult(root, { source, sha256 })` 通过受目录约束的 artifact reader 读取现有本地 trial `result.json`，校验 SHA-256，并严格按 UTF-8 JSON 解码。已有解码结果的调用方可使用纯函数 `parseHarborTrialResult(value)`。两者均不启动 Harbor、导入 promptfoo、创建 Session、加载凭据、写文件或访问服务。原始文件仍是权威证据，应与验收日志和 Agent 轨迹一起保存。

投影依据 Harbor 0.23.0 的单步骤 `TrialResult`、`VerifierResult` 和 `AgentContext` 源码，检查版本为 [commit fd0049126a060f930372f9b0b0aa330caf1f19e5](https://github.com/harbor-framework/harbor/tree/fd0049126a060f930372f9b0b0aa330caf1f19e5/src/harbor/models)。它读取实际使用的字段，允许上游附加元数据；不承担完整 Harbor schema 校验，也不宣称兼容其他版本。非空 `step_results` 会被拒绝，避免遗漏步骤内失败。Job 汇总不是 trial 记录。本地读取沿用 1 MiB artifact 上限。

- `scoring: scored` 要求记录中具有 trial、Agent 执行和 verifier 的起止时间、非空 Agent 结果对象、数值 reward，且没有 trial 异常。零分、小数分原样保留。这不证明 Fatcat 或真实模型实际执行：Oracle 和注入模型的 trial 也可能具有评分。KAI-44 验收仍须检查固定任务／配置、真实模型执行证据、日志和轨迹。
- 缺少执行或验收证据标为 `incomplete`，不伪造零分。异常标为 `error`，同时保留已经记录的 reward 和用量。无效数值、身份和时间记录会校验失败。不推断通过阈值、exact-match 等级、本地成功率或官方汇总分数。
- 输入 token 已包含缓存命中。输入、输出、缓存、费用各自未知时保留 null；不编造请求次数或价格／账单依据。Harbor 的原始费用值作为上游数据保留，不转换成要求更严格的 `EvalResult.cost`。
- 投影不复制配置、环境变量和 traceback。这不是通用脱敏：异常信息和原始文件仍可能含任务内容。哈希只绑定字节，不证明来源真实性或遵守了 benchmark 规则。

合成构造器 `tests/fixtures/harbor.ts` 与 `tests/harbor-result.test.ts` 验证上述区分、哈希不匹配、非法输入和只读证据处理。构建后执行 `pnpm --filter @fatcat/eval exec node --test dist/tests/harbor-result.test.js`。这些测试不产生官方成绩。

<a id="current-linear-milestones"></a>

## 当前 Linear 里程碑

以下范围于 2026-10-22 与 Linear 对齐：

| Issue | 当前职责与依赖 |
| --- | --- |
| [KAI-18](https://linear.app/kailtian/issue/KAI-18) | 用 Fatcat + DeepSeek V4.1 Flash 跑一道 Terminal-Bench 4.0 任务并保留官方评分；有效零分也可完成接入里程碑 |
| [KAI-21](https://linear.app/kailtian/issue/KAI-21)、[KAI-22](https://linear.app/kailtian/issue/KAI-22) | 已有协议及注入 Session／promptfoo 基础；KAI-22 已在本地实现，等待审阅发布，不是 Harbor 必经层 |
| [KAI-43](https://linear.app/kailtian/issue/KAI-43) | Linux 任务环境与核心无界面执行；下述规划尚未实施 |
| [KAI-44](https://linear.app/kailtian/issue/KAI-44) | KAI-43 之后直接接入 Harbor，先注入验证，再运行一次明确授权的 DeepSeek 单题尝试并保存官方证据 |

本次新增代码仅为上述离线 Harbor 结果读取器，不完成 KAI-43 或 KAI-44。Windows 原生仍是产品路径，Linux／容器作为新增评测路径。本增量不包含 TUI／Web UI 移植、新沙盒、本地替代题库或 Context／RAG 重构。

<a id="kai-43-execution-plan"></a>

## KAI-43 执行规划

本节是提案，不是已实现的 Linux 支持或成功执行记录。规划基于当前 checkout，包括尚未提交的 KAI-22 工作。后续实施前先审阅已有工作并固定实际代码提交；脏工作区只能作为诊断证据。

<a id="source-audit-and-intended-boundaries"></a>

### 源码检查与拟定边界

| 当前源码或行为 | 拟改动及所属模块 |
| --- | --- |
| `runtime/src/tools/shell.ts` 拒绝非 Windows 平台，工具描述写死 PowerShell | runtime 选择具体平台执行器及准确描述；保留 shell 授权、操作锁、cwd 重检、命令日志和清理失败后的禁用状态 |
| `runtime/src/permissions/process.ts` 编码 PowerShell，筛选 Windows 环境变量并调用 `taskkill` | 保留 Windows 路径；新增遵循相同 `ProcessResult` 契约的 Bash 执行器，显式环境白名单、输出上限、截止时间和有界进程组取消 |
| `runtime/src/system-prompt.ts` 声称 shell 是 PowerShell；`permissions/command-risk.ts` 分析 PowerShell 语法 | 提供符合平台的提示，不将 PowerShell 风险分类直接用于 Bash，也不让 Free to go 静默自动批准 Bash。首个无界面入口采用显式限定的任务策略；不支持的审批直接失败，不等待终端 |
| `permissions/workspace.ts` 检查普通可移植名称与链接；`agent.ts`、`session/record.ts` 只在 Windows 折叠大小写 | 验证 Linux 大小写敏感、任务绝对 cwd、路径穿越、符号链接和文件身份。保留 Windows 规则，仅调整所选任务证明确有冲突的限制；文件工具内不做宿主机／容器路径映射 |
| KAI-22 `session-runner.ts` 创建临时夹具工作区、禁用 shell，并做 exact-match 评分 | 保留夹具 runner。单独的 eval 无界面 driver 在 Harbor 的真实任务 cwd 中调用 runtime 公共导出，将私有临时 Session 存储放在任务输入之外；不得把任务复制到另一个工作区 |
| runtime 拥有 Session、Loop、Context、模型 SDK 和委派 | 复用 `createAgent`／`SessionManager`／`SessionStore` 及其取消／预算契约。题目选择、安装、日志和 Harbor 胶水代码归 eval；产品回归归 verification，两个开发包互不导入 |

实施前参考 pi 的 `core/tools/bash.ts`、`utils/shell.ts` 和显式 SDK 组装，版本为 `3daa20280f6a7c7cbe0935680c9a38fdc3863005`。采用具体函数与依赖，保留 Fatcat 契约，不引入通用执行器插件系统。进程组是清理机制，不是沙盒；逃逸后代仍须 Harbor 环境销毁兜底，无法确认清理时必须如实记录。

<a id="ordered-implementation-and-acceptance"></a>

### 实施顺序与验收

1. **先固定官方环境，再开始适配。** 使用数据集 `terminal-bench/terminal-bench@4.0.0`。Harbor 从已检查的 0.23.0 源码版本开始评估，记录实际安装版本／提交和解析后的依赖锁，不预设它一定兼容所选任务。读取官方清单及一道题的配置、环境、参考解答和 verifier。只选一道 CPU、单步骤任务；固定名称／版本／校验值、镜像摘要、CPU／内存／磁盘、网络需求和超时。具体 CPU 题和镜像须等这一步检查后确定，本规划没有下载或认证任何任务。声明子集／全集覆盖前核对完整清单。
2. **确定资源，再建立 Oracle 对照证据。** 安装或执行前确认本地 Docker 可用性和资源，或明确批准云端选择、额度与费用。保留原生 Windows 开发，普通使用不要求 WSL／Docker。对固定任务运行一次官方 Oracle 与 verifier，并发为一、重试为零；保留配置、reward、验收日志和环境身份。环境／验收失败或 Oracle 结果异常时先停下来定位，不能归因于 Fatcat。完整基准包含 GPU 题，单道 CPU 题不验证全量运行基础设施。
3. **实现最小 runtime 平台支持。** Bash 执行和平台提示放在 runtime，保留 Windows 执行器及权限语义。以前台、无用户 profile、无交互 stdin 的方式启动 Bash，筛选环境变量，传递退出状态，限制输出，处理启动失败、超时和取消。对所属进程组发送终止信号，有界等待后升级终止，等待进程／流收束，如实报告无法确认的清理。文件和 shell 操作共享同一任务环境与 cwd。检查 Linux 下子进程入口／资源和依赖安装，不仅为评测更换模型 SDK。
4. **增加 eval 无界面入口，先走注入执行。** 显式接收任务 cwd、指令输入、结果目录、权限策略、请求数和时间限制；导入不得产生宿主副作用。创建真实隔离 Session，通过注入传输复用现有模型适配器，不经过 promptfoo 或答案评分器。入口负责信号处理，将 abort 向下传递，等待 Session／工具收束，保存观察到的请求／历史／用量，再清理自己拥有的 Session 资源。不得删除 Harbor 任务工作区。验收器／参考答案不进入模型输入；缺少审批或配置明确失败。委派工作遵循相同权限和取消规则。
5. **验证两个操作系统并记录复跑方法。** 在真实 Linux 任务容器内，注入模型必须读取、新建、修改、重读文件，以 Bash 操作同一文件，报告命令非零退出，并取消一个带子进程的长时间命令。同时检查超时、输出溢出、权限拒绝、仅大小写不同的路径、符号链接逃逸、带空格路径和预先取消输入。核实父子进程终止、中断证据持久化及收束后无自有临时状态遗留。Windows 执行类型检查、包边界和完整离线测试；若修改入口／输入／生命周期，再运行注入模型的 Windows 终端检查。保存命令与本次日志，区分 Linux 和模型质量证据。
6. **将固定任务交给 KAI-44。** 优先使用 Harbor installed agent，使 Fatcat 及全部工具均在任务环境内运行。Harbor 拥有环境创建／销毁和官方 verifier。其 installed-agent API 可能需要一层薄 Python 集成，但不能重新实现 Session／Loop，也不引入第二套 TypeScript 模型客户端。具体打包和 runtime 导出需求在 KAI-44 按实际消费者审查。先注入验证，随后才确定 `deepseek-flash` 的单题／单次授权、请求数／超时及 API／云端额度。记录实际模型版本、思考配置、日期与代码／任务身份，不只保存可能变动的别名。模型未执行或缺少官方评分不能通过验收。

<a id="proposed-rerun-commands-and-exit-criteria"></a>

### 拟定复跑命令与完成条件

以下命令是后续获授权环境执行的准备模板，本次没有执行。Python／uv 属于外部 Harbor harness，Fatcat 的 JavaScript 依赖继续全部使用 pnpm。检查固定版本 CLI、选定任务后才能替换占位符；只有确定云端方案后，才将 Docker 换成获批云端环境。

```text
uv tool install "harbor==0.23.0"
harbor --version
harbor run --help
harbor run -d terminal-bench/terminal-bench@4.0.0 -i "<EXACT_CPU_TASK_NAME>" -l 1 -a oracle -e docker -k 1 -n 1 -r 0 -o "<LOCAL_RESULTS>" --job-name kai43-oracle
pnpm install --frozen-lockfile
pnpm --filter @fatcat/runtime --filter @fatcat/eval -r build
pnpm run typecheck
pnpm test
```

执行前检查并保存 Harbor 解析后的配置，必须只包含预期的那一道题。本规划不授权 `--upload`、完整基准、真实模型或云端启动。无界面入口实际存在后，补充最终注入命令，并在任务容器内复跑；不能把拟定文件名或占位符写成现有可执行命令。依赖安装失败、无法获得不可变任务／版本属于准备阻塞，不能静默换用其他 benchmark 发布版本。

KAI-43 只有在 CPU 题和环境固定、Oracle／verifier 对照成功、同一环境内真实注入读写／Bash／取消通过、Windows 回归通过且安装／复跑方法可重复时才完成。本次不宣称上述任何 Linux／环境验收已经满足。KAI-44 另须真实获授权的模型执行、正常结束的官方验收、数值 reward（包括零）、日志／轨迹及可得用量／费用。保留全部尝试和失败，只报告所选单题结果。

参考：[Terminal-Bench 运行说明](https://www.tbench.ai/run)、[Harbor 自定义 Agent](https://docs.harborframework.com/agents/custom-agents)、[Harbor job 命令](https://docs.harborframework.com/jobs/run-a-job)、[任务配置](https://docs.harborframework.com/tasks/configuration)。于 2026-10-22 核对，执行前仍须复核固定版本实现。

<a id="future-work-boundaries"></a>

## 后续工作边界

[KAI-23](https://linear.app/kailtian/issue/KAI-23) 在扩大真实评测前补齐整轮预算、重试／委派用量及费用覆盖。[KAI-24](https://linear.app/kailtian/issue/KAI-24)（LongMemEval）、[KAI-25](https://linear.app/kailtian/issue/KAI-25)（BEIR）、[KAI-26](https://linear.app/kailtian/issue/KAI-26)（Context 比较）和 [KAI-27](https://linear.app/kailtian/issue/KAI-27)（命令／CI／结果）均后置，不阻塞首道官方题。[KAI-42](https://linear.app/kailtian/issue/KAI-42) 仅在本地证据不足时考虑 Langfuse，不自动上传。[KAI-52](https://linear.app/kailtian/issue/KAI-52) 等单题流程及完整预算控制完成后，再核对 GPU／资源，以少量获批任务试算成本，随后运行固定官方全集，与同版本榜单的 Codex 组合比较模型加 Agent 的整体表现。子集不得作为完整榜单结果。

离线测试不读取 `.env`、调用真实模型或授权花费。Windows 原生交互、Linux 任务执行、公开 benchmark 和真实模型质量分别验收；注入成功只证明集成契约。token、金额和整轮实验预算仍如上文所述只是声明，增加结果读取器不会落实这些限额。
