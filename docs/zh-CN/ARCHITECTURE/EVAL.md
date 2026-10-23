

<a id="eval-experiment-protocol-and-result-statistics"></a>

# Eval：实验协议与结果统计

[English](../../en/ARCHITECTURE/EVAL.md) | 简体中文

[架构总览](README.md) · [开发检查与证据要求](../DEVELOPMENT.md#evaluation-evidence-requirements)

`packages/eval` 是独立开发包，管理实验定义、注入模型的 Session 执行、结果记录和统计。它通过现有包导出调用 runtime 的 Session、Loop、Context、工具及存储，所有权仍在 runtime。产品包不依赖它；它与 verification 互不依赖。真实模型执行、自动数据集下载管理、整轮预算调度和通用实验 CLI 尚未实现；下述注入无界面入口已可用于固定的 Linux 任务环境。

<a id="current-evaluation-strategy"></a>

## 当前评估策略

自 2026-10-23 起，因当前开发无法承担费用，暂停通过 Harbor 运行付费真实模型评测。近期重点是在不请求真实模型的情况下验证 harness 正确性、执行边界与问题定位能力。日常评估的**模型 API 花费为零**；本地 CPU、存储、电力和依赖下载仍消耗资源。贡献或 review 改动不以具备本地模型或免费 API 为前提。

| 层级 | 当前用途 | 证据与限制 |
| --- | --- | --- |
| 离线契约与故障夹具 | 受影响 runtime、产品及 eval 改动的默认验证 | 使用假凭据和确定性输入，检查解码、状态迁移、权限、请求计数、证据与清理 |
| 注入 Session 与工具流程 | 执行或接入发生变化时的默认验证 | 用受信任的注入响应驱动真实 Session／Loop／Context、文件、shell 和持久化；按改动范围运行原生 Windows 或 Linux 检查 |
| 本地注入 Linux 或 Harbor Oracle 对照 | 适配器、任务环境或官方评分接线变化时的专项检查 | 使用已有 headless 检查及官方 Oracle／verifier，不请求真实模型；Docker／镜像／下载是额外本地依赖，不要求每次修改都运行 |
| Harbor 配合真实模型运行 Terminal-Bench | 暂停，保留给未来具备预算的评测 | 新改动的官方解题质量保持未评估，直到另行授权并完成真实评测 |

根据[开发文档](../DEVELOPMENT.md#evaluation-evidence-requirements)选择与改动相称的检查。固定夹具通过只证明对应契约；Oracle reward 验证参考解答／环境，注入 reward 验证评分接线，两者均不是 Fatcat 真实模型成功率。历史真实结果保留原模型、配置、失败和限制，不验证后续改动。不得把合成用量、未知费用或更少 token 解释成实测 API 节省或任务质量提升。

<a id="near-term-harness-acceptance"></a>

### 近期 harness 验收

以下优先级指导后续实现；本次文档调整没有新增恢复行为或通用轨迹回放服务。围绕已观察的失败扩展现有测试，并保持包职责：产品契约放在 `packages/verification`，评估适配器和结果契约放在 `packages/eval`。

1. **长任务失败。** 用有界的请求／响应夹具复现编码正文超限、上下文限制响应、输出截断和错误工具调用。检查明确的失败分类、保留的执行证据及清理；缩短或中断的运行不能计为任务成功。
2. **执行边界。** 向父任务／委派工作注入失败、超时和取消，检查权限决策、共享请求额度、已实现的预算计费、子进程收尾及临时文件所有权。预算声明的解析测试通过不代表预算已被强制执行。
3. **工具流程。** 用固定预期产物和受保护文件检查，覆盖读、改、执行、检查及修正序列。保留 Windows 行为，Linux 代码受影响时补跑其进程／路径专项。这些是开发夹具，不是替代公开 benchmark 的题库。
4. **证据与回归。** 将有用的历史失败缩减为不含秘密的合成夹具或经检查的响应序列，记录实际配置、终态、工具结果与清理结论。响应回放验证该序列下的 harness 行为，不模拟新的模型决策，也不证明质量提升。恢复 Session 不得重放工具副作用或旧审批。

Review 验收以相关离线／注入检查、真实结果和明确的剩余限制为准。暂停期间，真实模型评测不是常规 review 的前置要求；没有相应证据时，模型质量、通用任务成功率或更好压缩／推理的结论继续暂缓。

<a id="retained-harbor-route-and-resumption"></a>

### 保留 Harbor 路线与恢复条件

Harbor 仍是未来 Terminal-Bench 评测的预定路线：保留任务／版本固定信息、官方 verifier、Linux 指南和全部已记录的对照及失败，并保留另行 review 的适配器工作。不得用夹具分数替代官方真实模型结果，也不因暂停付费而移除接入。

只有新的明确恢复指令及约定的范围、费用上限，才能恢复付费评测。恢复前重新核对模型可用性、现行价格、任务／Harbor 版本和实际生效的请求／时间／费用限制，再验证受影响的离线／注入路径。先做有界的官方单题试跑，只有预算依据充分时才扩展至声明的子集或全集。此次暂停后，原 KAI-44 的 10 元授权及任何剩余额度都不再构成继续运行的授权。代码 review、测试通过或保留的命令示例均不会自动恢复付费执行。这是开发策略，本次不新增运行时禁用开关。

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
| `src/headless.ts`、`scripts/headless.ts` | 注入模型的任务目录 Session 执行、明确限制／策略、持久证据与入口信号生命周期 |
| `harbor/`、`scripts/verify-linux.ts` | 固定官方任务／控制端依赖、Oracle／镜像元数据和真实 Linux 验收 |
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

以下是于 2026-10-22 与 Linear 对齐的 Issue 范围参考。这些依赖不覆盖[当前评估策略](#current-evaluation-strategy)；暂停调整开发优先级，不改写历史验收条件或 Linear 状态。

| Issue | 当前职责与依赖 |
| --- | --- |
| [KAI-18](https://linear.app/kailtian/issue/KAI-18) | 用 Fatcat + DeepSeek V4.1 Flash 跑一道 Terminal-Bench 4.0 任务并保留官方评分；有效零分也可完成接入里程碑 |
| [KAI-21](https://linear.app/kailtian/issue/KAI-21)、[KAI-22](https://linear.app/kailtian/issue/KAI-22) | 已有协议及注入 Session／promptfoo 基础；KAI-22 已实现并发布待审，不是 Harbor 必经层 |
| [KAI-43](https://linear.app/kailtian/issue/KAI-43) | 固定 Linux 任务环境与注入模型的核心无界面执行；实现与复跑方式见下文 |
| [KAI-44](https://linear.app/kailtian/issue/KAI-44) | KAI-43 之后直接接入 Harbor，先注入验证，再运行一次明确授权的 DeepSeek 单题尝试并保存官方证据 |

KAI-43 新增 Linux 执行与注入模型的无界面入口；KAI-44 的 Harbor installed agent 和真实模型评分仍单独实施。Windows 原生仍是产品路径，Linux／容器作为新增评测路径。本增量不包含 TUI／Web UI 移植、新沙盒、本地替代题库或 Context／RAG 重构。

<a id="kai-43-execution-plan"></a>

## KAI-43 执行规划

环境优先的规划已推进至注入模型的 Linux 执行阶段。此前 KAI-22／规划增量的提交为 `89b8581c0ae87b91a69016cb1d28e99277e532c0`，已发布到 [PR #115](https://github.com/KailBug/fatcat/pull/115)。当前增量增加评估路径，不移植 Linux UI。安装、准确命令、失败情况与验证边界见 [Linux 评估](../GUIDES/LINUX_EVAL.md)。

<a id="source-audit-and-intended-boundaries"></a>

### 源码检查与拟定边界

- `runtime/src/tools/shell/bash.ts` 使用现有 ProcessResult 协议实现 Linux 前台执行；`tools/shell.ts` 选择 Bash 或原生 PowerShell。权限操作锁、cwd 复查、journal 和清理失败禁用仍归共享 shell 工具。平台指导准确，Bash 不进入 PowerShell 风险分类器。见 [Tools](TOOLS.md#shell-execution-boundaries) 与 [Permissions](PERMISSIONS.md#free-to-go-command-risk-classification)。
- 检查的 pi 参考仍为提交 `3daa20280f6a7c7cbe0935680c9a38fdc3863005` 的 `core/tools/bash.ts` 与 `utils/shell.ts`。立即对组发送 SIGKILL，替代原定的延迟 TERM 升级，以终止忽略 TERM 的后代并避免组长退出后延迟发送信号。逃逸进程组的后代仍需容器销毁，不宣称沙箱保证。
- `eval/src/headless.ts` 直接通过公开的 `createAgent`、`createTools`、`SessionManager` 和 `SessionStore` 导出，在实际任务 cwd 执行；不复制任务，也不改变 Session／Loop／Context／模型 SDK 的职责。KAI-22 的夹具工作区、promptfoo provider 和 exact-match grader 保持不变。
- `eval/scripts/headless.ts` 负责 argv、受信任注入模块加载及 SIGINT／SIGTERM；库导入不启动宿主操作。新的私有 Session 目录位于任务外；收尾后先写证据，再删除仅属于该次执行的目录。该驱动从不删除任务工作区。

<a id="ordered-implementation-and-acceptance"></a>

### 实施顺序与验收

1. **固定官方源码与资源。** `harbor/terminal-bench-4.0.json` 记录版本 `terminal-bench/terminal-bench@4.0.0`、提交 `452bf305c6daa62fc59061d22133a7cbc7c1572e`、单道 CPU 题 `terminal-bench/sound-change-cascade`、全部 18 个源码文件 SHA-256 及资源／时限。该版本包含 66 个任务清单，只选择此题。执行前检查了本机 Docker，未启动云资源。
2. **官方 Oracle 对照。** Harbor 0.23.0，并发一、单次尝试、零自动重试，得到 reward `1.0`，官方 verifier 七项测试通过。`harbor/oracle-control.json` 记录 trial、源码／镜像身份及证据哈希；前期环境失败均保留。这是 Oracle 分数，不是 Fatcat 分数。
3. **运行时与无界面执行。** Windows 保留 PowerShell，Linux 使用 Bash。无界面入口要求任务／结果绝对路径、明确的文件与 shell 策略、指令文本、1–32 次请求和 100–120000 毫秒时限。只接受 read-only/deny，或 workspace-write 配 allow/deny；缺失或交互审批显式失败。现有运行时及取消信号落实请求／时间限制，也覆盖委派工作。
4. **真实注入验收。** 官方任务环境中使用 Node 24.19.0 和 pnpm 11.21.0 的固定锁文件依赖，文件工具与 Bash 均在 `/app` 执行。检查读／建／改／重读、非零退出、超时、输出上限、拒绝、大小写不同文件、空格路径、符号链接逃逸、预先取消、父子进程取消及中断持久化／清理。可执行入口的 SIGTERM 路径也收尾并以 130 退出。运行采用 `--network none`，未产生供应商请求或官方 Fatcat 分数。
5. **Windows 回归与交接。** 新鲜类型检查、包边界／构建和离线完整测试证据与 Linux 日志分别保存。CLI／TUI／Web UI 的入口和输入代码不变。KAI-44 负责 installed Harbor agent、Fatcat 官方验收接线及另外明确授权的真实 DeepSeek 执行；KAI-43 不自动进入这些活动。

<a id="proposed-rerun-commands-and-exit-criteria"></a>

### 拟定复跑命令与完成条件

原模板已替换为 [Linux 评估](../GUIDES/LINUX_EVAL.md) 中的具体命令。`scripts/verify-linux.ts` 验证真实任务目录集成；产品进程／路径合同仍放 verification，评估编排合同仍放 eval，两个开发包互不导入。独立 Python 依赖快照用于 Windows Harbor 控制端；Fatcat JavaScript 依赖仍全部使用 pnpm 和现有锁文件。

无界面证据包含已准备的请求正文（不含 SDK headers）、事件、当前 Session 历史／中断、用量消费、写入、命令结果、平台及临时状态位置；`result.json` 记录最终状态与清理。这些是注入集成证据，不是通用 EvalResult 判分或 Harbor reward。证据可能包含任务文本，需私密处理。发布或磁盘失败可能留下不完整产物／私有状态；没有覆盖、自动恢复、沙箱、token／金额上限或全实验预算，完整预算合同仍归 KAI-23。

KAI-44 的真实接入验收要求实际运行获授权的模型、正常完成官方 verifier，并保留数值 reward（有效零分也可）、轨迹及可用用量／费用。该条件继续用于 Harbor 路线，不构成暂停期间重新付费评测的指令。环境失败、未执行或缺少评分都不能满足该里程碑。源码／镜像／版本身份和每次失败尝试必须与所选任务的有效结果区分。

<a id="future-work-boundaries"></a>

## 后续工作边界

[KAI-23](https://linear.app/kailtian/issue/KAI-23) 在扩大真实评测前补齐整轮预算、重试／委派用量及费用覆盖；其中 harness 计费逻辑可以用合成响应开发。[KAI-24](https://linear.app/kailtian/issue/KAI-24)（LongMemEval）、[KAI-25](https://linear.app/kailtian/issue/KAI-25)（BEIR）、[KAI-26](https://linear.app/kailtian/issue/KAI-26)（Context 质量比较）和 [KAI-27](https://linear.app/kailtian/issue/KAI-27)（质量命令／CI／结果）继续后置，不阻塞 harness 可靠性工作。[KAI-42](https://linear.app/kailtian/issue/KAI-42) 仅在本地证据不足时考虑 Langfuse，不自动上传。[KAI-52](https://linear.app/kailtian/issue/KAI-52) 保留为未来 Harbor／Terminal-Bench 路线，在明确恢复预算并具备完整预算控制前暂停：恢复后核对 GPU／资源，以少量获批任务试算成本，再考虑固定官方全集及同版本 Codex 榜单比较。子集不得作为完整榜单结果。这些保留计划均不会自动恢复付费执行。

离线测试不读取 `.env`、调用真实模型或授权花费。Windows 原生交互、Linux 任务执行、公开 benchmark 和真实模型质量分别验收；注入成功只证明集成契约。token、金额和整轮实验预算仍如上文所述只是声明，增加结果读取器不会落实这些限额。
