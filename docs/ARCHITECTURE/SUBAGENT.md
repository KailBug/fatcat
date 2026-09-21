# Subagent：最小子任务委派

## 状态

阶段 2C 已实现，并通过 64 项离线测试及真实 DeepSeek 验证，已通过用户 review；实际结果以 PROGRESS.md 为准。仅解决将自包含小任务交给独立历史执行的问题，不增加依赖、线程或进程。

## 当前实现与接口

- `--subagent` 与单次任务或 --chat 组合，显式加入 delegate_task；默认关闭。
- `src/subagent.ts` 包装基础 Tools，增加委派定义和执行。基础工具集合与子模型来自同一配置；子模型与 Loop 都只拿基础工具，禁止递归。
- Tool 集合提供可选 forTurn 工厂，Loop 在每次用户回合创建独立执行计数与事件回调；原有 collectTools 结构及普通工具接口保留。
- 子任务仅接收 task 字符串（1 至 4000 字符）与默认 system，不复制父历史。需要的背景由父模型写入 task；工作目录权限保持相同。
- 每回合最多启动 2 个子任务，失败启动也占额度；每个子任务最多 min(3, HARNESS_MAX_ITERATIONS) 次请求。父回合上限仍独立计算，因此默认总请求上界为 8 + 2 × 3 = 14，SDK 不自动重试。
- 子任务结果为最终 answer；超过 12000 字符返回错误，不截断为成功。内部工具历史不合并进父历史。
- 子任务失败作为 SUBAGENT_FAILED 回传父模型，在 message 中保留安全的原因错误码；取消继续抛出 CANCELLED，终止整个父回合。次数耗尽为 SUBAGENT_LIMIT。
- 子事件通过父调用 ID 包装为 subagent_event，不输出任务文本、答案、文件内容或凭据。

`createSubagentTools(baseTools, childModel, maxIterations): Tools` 返回父工具集合。CLI 先用基础工具创建 childModel，再包装父 Tools，最后用父 Tools 创建父模型；基础工具和子模型均不包含 delegate_task。包装已有委派定义的工具集合会触发配置错误。

`forTurn(onEvent?)` 返回带独立 started 计数的执行对象；每次 runAgentTurn 只调用一次该工厂。未启用委派的工具无需工厂。execute 的可选第四参数 callId 由 Loop 传入，用来关联 subagent_event；直接调用 execute 时使用局部默认标识。程序化调用者每个新用户回合应使用 forTurn，或通过 Loop/Session 自动创建范围。

成功回传 `{ ok: true, result: { answer } }`。非法 JSON 或参数为 INVALID_ARGUMENTS，不启动子任务、不占额度。启动过的失败任务仍占额度；错误不会暴露原始 SDK 信息。子任务失败并不自动使父回合失败，父模型可以据此生成解释；父回合最终成功时可保留这个错误工具结果。

父和子都复用已有 Fatcat system 提示与 Loop；子任务答案按工具数据处理。隔离的是传给模型的消息数组，不是操作系统权限或模型客户端进程。

## 已验证

- 离线验证子历史隔离、父结果关联、内部工具历史不合并、独立回合与 Session 额度、失败占额度、上限、递归请求返回 UNKNOWN_TOOL、输出长度边界以及取消传播。
- 实际 CLI 使用虚构传输验证求和委派、工作目录继承和重置后再次委派。
- 真实子任务列目录并读取样例，父模型根据回传答案输出 AMBER-MEADOW-42；实际 pnpm 入口委派子任务用 sum(8,13)，最终输出 21。详情见 PROGRESS.md。

## 本轮非目标

不实现递归委派、并行子任务、后台任务、子任务恢复、跨子任务共享记忆或复杂调度。不保证委派改善成功率或节省 token；委派通常增加请求与成本。

## 目标交互调整（已确定，未实现）

后续将委派作为正常可用的内部能力，由 Agent 根据任务判断是否使用，不要求用户在日常 CLI 任务中手动传入 --subagent。可用不代表每个任务都委派；保留请求预算、取消、历史隔离及父任务权限上限。

当前代码仍采用显式开关。迁移时同步 CLI 帮助、README、测试与真实验证，检查直接完成和按需委派两条路径，不在本次方向讨论中改变运行时行为。
