

<a id="eval-experiment-protocol-and-result-statistics"></a>

# Eval：实验协议与结果统计

[English](../../en/ARCHITECTURE/EVAL.md) | 简体中文

[架构总览](README.md) · [开发检查与证据要求](../DEVELOPMENT.md#evaluation-evidence-requirements)

`packages/eval` 是独立开发包，管理实验定义、结果记录和统计，不拥有 Session、Loop、权限或持久会话。当前只提供离线协议函数，没有实际模型执行器、公开数据下载、预算调度或评测 CLI。产品包不依赖它；它与 verification 互不依赖。

<a id="modules-and-references"></a>

## 模块与参考

| 模块 | 职责 |
| --- | --- |
| `src/experiment.ts` | `Experiment`、严格配置解析、版本化来源引用和实验 SHA-256 摘要 |
| `src/result.ts` | `EvalResult`、执行与评分状态、用量覆盖和 JSON 序列化／读取 |
| `src/summary.ts` | 配置绑定、逐次结果完整性和统计；返回可 JSON 序列化的摘要及全部记录 |
| `src/validation.ts` | 上述边界共同使用的标量、对象和摘要编码校验 |
| `tests/`、`scripts/test.ts` | 本包合成数据、文件往返、统计与包集成回归；源码清单驱动的离线入口 |

组织方式参考 Maka `packages/eval` 的实验／结果分离及严格解码（参考提交 `8686793e5d051018c61e53350e542992d19d5311`）；类型和显式函数结构参考 pi `usage-totals.ts`（参考提交 `3daa20280f6a7c7cbe0935680c9a38fdc3863005`）。这是针对 Fatcat 契约的独立实现，没有迁入 Maka 的 Harbor、Fleet、代理网络或重试选择机制，也没有添加第三方依赖。

<a id="experiment-definitions"></a>

## 实验定义

`schemaVersion` 为 `fatcat.eval.v1`。解析器拒绝缺失／多余字段、非法数字、重复样本和未知版本，并复制嵌套数据。实验包含：

- `id`、完整 Git SHA、`dirty`，以及具体 OS／Node／pnpm 环境标识。
- `evidence`：`synthetic`、`injected` 或 `live`；`level`：`contract`、`model_quality` 或 `task_acceptance`。二者独立，合成的任务验收结果仍是合成证据。
- 供应商、模型 ID 和非秘密生成参数。参数仅接受有限 JSON 标量；拒绝常见凭据字段。该检查不是通用脱敏器，调用者不得传入真实 Key、私人正文或完整运行配置。
- 数据 ID、版本、manifest 的来源及 SHA-256；manifest 应定位固定输入、参考答案与样本身份。`sampleIds` 是所声明版本的完整题目清单，开发／留出集为其不相交子集；选择只能来自声明的一个 split。
- `coverage` 为 `subset` 或 `full`；只有选择等于完整 `sampleIds` 才能使用 `full`。这是对已声明清单的一致性检查，不认证它与官方题库一致，也不证明官方运行环境未改变。数据接入方仍须核对版本、许可、完整清单及语料裁剪。
- 提示、策略及评分器各自的版本、来源和内容 SHA-256；重复次数；每次／整轮的请求、token、时间及可选美元上限。`costUsd: null` 表示未声明金额限制，不表示免费。

来源可以是可恢复的仓库相对路径或固定外部资源。当前解析器不读取文件、不访问网络、不验证 Git 对象或实际内容；后续执行适配负责解析和核验引用内容、采集实际环境信息，并将有效参数与清单保持一致。模型别名或外部服务行为仍可能变化，可定位配置不保证输出逐字相同。正式对照先使用干净提交；`dirty: true` 可记录诊断，但 v1 不保存未提交补丁或未跟踪文件，不能宣称可复现。

`experimentDigest()` 对完整解析结果按对象键排序后计算 SHA-256，数组保持声明顺序。结果不仅绑定实验 ID，还绑定此摘要；改动代码、模型参数、样本、提示、策略、预算或评分器后不能混用旧结果。

<a id="results-and-grading"></a>

## 结果与判分

每条 `fatcat.eval.result.v1` 记录使用实验 ID／摘要、样本 ID 和从 1 开始的 repetition 定位。重复实验与基础设施重试不是同一概念；v1 每个计划位置只接收一条终态记录，不支持覆盖、重试后挑选或断点续跑。执行适配尚未实现。

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

<a id="future-work-boundaries"></a>

## 后续工作边界

KAI-22 接入真实 Session／promptfoo，KAI-23 执行预算与费用收集，KAI-24／25 导入公开样本及评分，KAI-26 生成实际基线和成对报告，KAI-27 增加质量运行与归档流程。当前预算字段不提供拦截、取消或金额上限保证；协议测试不读取 `.env`、启动模型或授权花费。Windows 原生交互、公开 benchmark 和真实模型质量仍分别验收。
