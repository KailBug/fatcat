# 回合执行报告

## 状态与目的

阶段 2D-5 基线已通过用户 review 并合入 main；2D-7 请求大小及服务端 token 用量已通过 review 并合入；2D-8 请求整理统计已验证并随 PR #10 合入；实际记录见 [PROGRESS.md](../PROGRESS.md)。解决用户需要从分散日志中自行重建本回合操作的问题，同时让实际记录独立于模型最终回答。

报告是交付时的事实摘要，不是完整 Task 系统，不判定模型回答的每项声明，也不认证任务成功。没有新依赖、模型工具、权限开关或持久状态。

## 模块与数据流

`src/execution-report.ts` 导出 `createTurnReporter(emit): (event: LoopEvent) => void`、`ExecutionReport` 和 `ReportEvent`。只消费事件，不访问文件、请求模型或调用工具；2D-7 新增 model_input / model_usage 元数据观察，2D-8 增加 context_reduction。

CLI 单次任务 / chat 每个用户回合创建观察器 → 传入 Loop / Session 的 onEvent → 转发原始事件并累积本回合数据 → 根 completed / stopped 后额外发出 execution_report → stderr。stdout 及 Loop / Session 的返回值不变。命令和写入的日志仍由 Tools 所有；观察器不改变它们。

`ReportEvent` 是交互侧的 LoopEvent 或 execution_report 联合，不把报告加入核心 LoopEvent。低层 runAgent / Session 默认仍只产生原事件；程序化调用者可接入同一观察器。真实编码脚本也复用 CLI 的 createAgent 和观察器。

## 已实现的汇总规则

- outcome 为 answered 或 stopped；stopCode 只记录根回合的安全错误码。answered 表示得到答案，taskVerification 固定为 not_assessed。
- modelRequests 分别统计父与子请求事件；统计的是尝试，包含本地预算拒绝，不能当作实际 HTTP 次数或服务端计费确认。toolResults 统计父子返回的 ok / errors，包括 delegate_task；取消可能先留下记录而没有 tool_result。
- writes 以记录 ID 保留最新副本，包含失败、未决和已提交状态，不从模型输出推断。commands 以 ID 保留第一次完整结果元数据；当前内置 shell 在 Loop 观察前已结束，命令记录没有异步后续更新。
- 子事件先被观察，父 Loop 对共享记录的重复报告不重新排序；子 completed / stopped 只被转发，不结束根报告。仅根结束时发出一次报告。
- 看到新的或内容变化的 write_record 时，将此前命令的 laterWriteAttempt 设为 true。它指进入记录阶段的写入尝试，包含 failed / uncertain / started，不表示该文件一定被修改。相同 ID 与相同内容的重复记录不触发标记。
- 每条命令 succeeded 仅在 completed、exitCode=0、truncated=false 且 cleanup 不为 unconfirmed 时成立。outputSummaryTruncated 只表示日志摘要省略，与执行时收集输出超限不同，不据此推翻退出事实。
- 报告不包含命令正文、stdout/stderr、文件正文、任务文本、模型答案或密钥。写入元数据与现有事件一致，包含相对路径和哈希；不是内容脱敏系统。
- 每回合创建新观察器；已有记录不由 Loop 重放，不将之前回合或 reset 前的操作算作新执行。只有计数与有界的记录集合，没有累计完整事件历史；内置 Tools 仍限制最多 100 次写入尝试、20 次命令尝试。

## 请求大小与用量（2D-7 已实现）

- requestBytes 分为 parent / children：checked 为 model_input 次数，rejected 为本地预算拒绝次数，maxBytes 为本回合观察到的最大最终请求体（2D-8 整理之后，包括仍被拒绝的请求）；无观察为 null。每次事件仍保留 bytes / limitBytes / accepted。
- tokenUsage 分为 parent / children：reportedRequests 只计有效 usage 的请求数；totals 为已报告部分的 promptTokens / completionTokens / totalTokens 之和。没有有效报告时 totals=null，不能当作零消耗；有效全零统计仍是明确的零。
- reportedRequests 小于 modelRequests 时，totals 只代表已报告的部分，不能称作完整回合用量。预算拒绝、取消、HTTP 错误、统计缺失/非法、自定义 Model 不观察用量都会造成差异；不推算其中请求是否计费。
- 收到统计后发生截断、协议错误或取消，已观察到的用量仍进入停止报告。统计不进入模型历史；/reset 后新回合重新计数。父子统计分别汇总，子用量不会因父再次报告共享工具记录而重复累加。
- 求和超出安全整数范围时 totals 保持 null，但 reportedRequests 保留，不输出不精确数字或从后续小数值重新开始累计。汇总复制输入与最终报告，不持有调用者可变计数对象。

这是本地观察记录，不是服务账单，也未计算缓存价格、金额或相对成本。工具执行、任务成功率和 token 消耗必须分别解读。

## 失败、边界与限制

模型错误、迭代耗尽和正常取消时，Loop 在 stopped 前报告新增事实，因此回合摘要保留已经发生的副作用。配置/参数/工作目录错误等发生在 Loop 之前的失败不产生报告。进程崩溃、强制结束、输出流异常及自定义事件回调抛错不提供可靠最终报告保证。

报告仅解释所观察到的事件。laterWriteAttempt=false 不证明文件当前未变：shell、编辑器或其他进程可以修改文件；它没有文件版本绑定、快照或依赖分析。相反，失败暂存或不相关文件的写入也会保守设置标记。某个命令退出 0 不能说明它是测试、覆盖充分或任务完成。

模型最终陈述仍原样输出；exit code 0 仍只表示返回答案/正常交互。真实验收中模型曾额外声称历史哈希匹配当前状态，执行事件不足以支持该句话；本轮独立验收依据脚本核对和真实命令，不能据报告把整段答案认证为正确。后续再按具体任务完善证据关联和验收规则。

## 验证

离线使用注入模型验证空命令记录不会被“测试已通过”的回答填充、权限拒绝不算执行、失败/取消/耗尽后保留写入、子任务去重、回合/reset 隔离、状态更新与记录副本。固定事件验证超时、截断、启动失败和清理不确定的汇总规则；真实 Windows 命令验证非零退出 → 写入 → 零退出的顺序及日志不包含命令/输出。

实际 CLI 测试覆盖单次和聊天、直接和委派、模型失败及 Ctrl+C 报告；pnpm run verify:coding 使用临时故障源文件和固定测试，模型读改测后核对报告 ID/状态，并独立执行同一测试。详细请求次数与结果以 PROGRESS.md 为准。

2D-9 的 `pnpm run verify:workflow` 将检查扩至同一 Session 的两个编码回合，每回合只与共享 journal 的新增记录比较。两回合都须有新的读取、预期修改、失败命令及最终成功命令；最终成功命令不能早于后续 write。提示要求修改前复现失败，脚本不单独断言失败在首次编辑前。脚本另行执行固定检查、核对受保护文件字节与每次请求的有效用量，离线负例检查遗漏或复用旧证据会被拒绝。这些是合成样例的外部验收断言，不改变报告的 `taskVerification=not_assessed` 或生产接口；实际验证结果见 PROGRESS.md。

## 请求整理统计（2D-8 已实现）

contextReduction 分为 parent / children，每项包含 requests、omittedReadResults 和 bytesSaved，未发生整理时均为 0。requests 统计实际省略旧 read 的请求尝试；omittedReadResults 按每次请求累计被替换的结果数，同一历史结果在两个请求中被省略会计两次，不是唯一读取次数。bytesSaved 累加 beforeBytes - afterBytes，是完整 JSON 正文的字节差，不是 token、已发送流量或计费节省。

事件发生在最终 model_input 之前：整理后仍超限、传输失败或回合失败都保留已观察到的统计。事件只有大小与数量，不记录路径、正文、搜索词或原始结果。报告仍不进入 Session 或模型历史；它证明程序做了请求整理，不证明任务正确、内容恢复或成本优化。
