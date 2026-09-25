# 回合执行报告

## 状态与目的

阶段 2D-5 已实现并通过 126 项离线测试及一次真实 DeepSeek 编码样例验证，待用户 review；实际记录见 [PROGRESS.md](../PROGRESS.md)。解决用户需要从分散日志中自行重建本回合操作的问题，同时让实际记录独立于模型最终回答。

报告是交付时的事实摘要，不是完整 Task 系统，不判定模型回答的每项声明，也不认证任务成功。没有新依赖、模型工具、权限开关或持久状态。

## 模块与数据流

`src/execution-report.ts` 导出 `createTurnReporter(emit): (event: LoopEvent) => void`、`ExecutionReport` 和 `ReportEvent`。只使用已有事件，不访问文件、请求模型或调用工具。

CLI 单次任务 / chat 每个用户回合创建观察器 → 传入 Loop / Session 的 onEvent → 转发原始事件并累积本回合数据 → 根 completed / stopped 后额外发出 execution_report → stderr。stdout 及 Loop / Session 的返回值不变。命令和写入的日志仍由 Tools 所有；观察器不改变它们。

`ReportEvent` 是交互侧的 LoopEvent 或 execution_report 联合，不把报告加入核心 LoopEvent。低层 runAgent / Session 默认仍只产生原事件；程序化调用者可接入同一观察器。真实编码脚本也复用 CLI 的 createAgent 和观察器。

## 已实现的汇总规则

- outcome 为 answered 或 stopped；stopCode 只记录根回合的安全错误码。answered 表示得到答案，taskVerification 固定为 not_assessed。
- modelRequests 分别统计父与子请求事件；统计的是尝试，不能当作服务端计费确认。toolResults 统计父子返回的 ok / errors，包括 delegate_task；取消可能先留下记录而没有 tool_result。
- writes 以记录 ID 保留最新副本，包含失败、未决和已提交状态，不从模型输出推断。commands 以 ID 保留第一次完整结果元数据；当前内置 shell 在 Loop 观察前已结束，命令记录没有异步后续更新。
- 子事件先被观察，父 Loop 对共享记录的重复报告不重新排序；子 completed / stopped 只被转发，不结束根报告。仅根结束时发出一次报告。
- 看到新的或内容变化的 write_record 时，将此前命令的 laterWriteAttempt 设为 true。它指进入记录阶段的写入尝试，包含 failed / uncertain / started，不表示该文件一定被修改。相同 ID 与相同内容的重复记录不触发标记。
- 每条命令 succeeded 仅在 completed、exitCode=0、truncated=false 且 cleanup 不为 unconfirmed 时成立。outputSummaryTruncated 只表示日志摘要省略，与执行时收集输出超限不同，不据此推翻退出事实。
- 报告不包含命令正文、stdout/stderr、文件正文、任务文本、模型答案或密钥。写入元数据与现有事件一致，包含相对路径和哈希；不是内容脱敏系统。
- 每回合创建新观察器；已有记录不由 Loop 重放，不将之前回合或 reset 前的操作算作新执行。只有计数与有界的记录集合，没有累计完整事件历史；内置 Tools 仍限制最多 100 次写入尝试、20 次命令尝试。

## 失败、边界与限制

模型错误、迭代耗尽和正常取消时，Loop 在 stopped 前报告新增事实，因此回合摘要保留已经发生的副作用。配置/参数/工作目录错误等发生在 Loop 之前的失败不产生报告。进程崩溃、强制结束、输出流异常及自定义事件回调抛错不提供可靠最终报告保证。

报告仅解释所观察到的事件。laterWriteAttempt=false 不证明文件当前未变：shell、编辑器或其他进程可以修改文件；它没有文件版本绑定、快照或依赖分析。相反，失败暂存或不相关文件的写入也会保守设置标记。某个命令退出 0 不能说明它是测试、覆盖充分或任务完成。

模型最终陈述仍原样输出；exit code 0 仍只表示返回答案/正常交互。真实验收中模型曾额外声称历史哈希匹配当前状态，执行事件不足以支持该句话；本轮独立验收依据脚本核对和真实命令，不能据报告把整段答案认证为正确。后续再按具体任务完善证据关联和验收规则。

## 验证

离线使用注入模型验证空命令记录不会被“测试已通过”的回答填充、权限拒绝不算执行、失败/取消/耗尽后保留写入、子任务去重、回合/reset 隔离、状态更新与记录副本。固定事件验证超时、截断、启动失败和清理不确定的汇总规则；真实 Windows 命令验证非零退出 → 写入 → 零退出的顺序及日志不包含命令/输出。

实际 CLI 测试覆盖单次和聊天、直接和委派、模型失败及 Ctrl+C 报告；pnpm run verify:coding 使用临时故障源文件和固定测试，模型读改测后核对报告 ID/状态，并独立执行同一测试。详细请求次数与结果以 PROGRESS.md 为准。
