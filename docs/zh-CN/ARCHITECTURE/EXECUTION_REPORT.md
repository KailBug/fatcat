

<a id="execution-reports-turn-facts-and-usage"></a>

# Execution reports：回合事实与用量

[English](../../en/ARCHITECTURE/EXECUTION_REPORT.md) | 简体中文

[架构总览](README.md) · [结果核对指南](../GUIDES/CODING.md#review-results-and-recover-from-failures)

`packages/runtime/src/execution-report.ts` 的 createTurnReporter 只消费事件并汇总，不访问文件、调用工具或请求模型。报告是观察结果，不是任务验收证书；taskVerification 当前固定为 not_assessed。

<a id="event-boundaries"></a>

## 事件边界

入口为每个用户回合创建观察器，转发 LoopEvent，在根 completed/stopped 后发出一次 execution_report。子终止只被转发，不结束父报告。CLI/chat 输出到 stderr，TUI/Web UI 用于展示；报告不进入模型历史或持久会话。

持久入口由 AgentSession/Manager 延迟根完成到保存成功之后。模型已回答但保存失败是 stopped/SESSION_STORAGE；开始记录失败可以产生零模型请求的失败报告。程序化普通 Loop/Session 的事件时机保持其内存语义。

自动 compact 属于原回合，只增加活动/请求事件；手动 compact 是独立操作。摘要与视觉请求计入用量，但不增加已完成聊天回合或冒充聊天上下文 token 观察。

<a id="aggregation-definitions"></a>

## 汇总口径

| 字段或事实 | 含义与限制 |
| --- | --- |
| outcome / stopCode | answered 或 stopped 与根错误码；answered 不代表任务成功 |
| modelRequests | 父子请求尝试，含本地预算拒绝；不是实际 HTTP 次数或计费确认 |
| toolResults | 已返回的成功/错误；取消可能已有操作记录但没有结果事件 |
| writes | 按 ID 保存最新状态、路径、哈希及大小，不从回答推测 |
| commands | 按 ID 保存完整退出/清理元数据，去重共享 journal |
| browserChecks | 状态、时间、步骤/诊断计数和 JSON/PNG 路径，不内嵌图片或页面正文 |
| requestBytes | checked/rejected/maxBytes；反映最终请求体，包括整理后仍超限的尝试 |
| tokenUsage | 合法服务计数及覆盖请求数，父子分别统计；未知不是零 |
| contextReduction | 每次请求省略数量和字节差，重复省略重复计数，不等于 token 或费用节省 |

命令 succeeded 要求 completed、exitCode=0、捕获未超限且清理不为 unconfirmed。日志摘要截断及模型侧 shell 的 outputTruncated 都与捕获超限不同；预览缩短不导致命令失败。output_read 读取已捕获输出，不启动新命令或新增命令记录。日志上限及生命周期见 [Tools](TOOLS.md#output_read-and-captured-output)。

新的或变化的 write_record 会把更早命令/浏览器检查标为 laterWriteAttempt。失败或 uncertain 写入也触发；相同记录重复事件不触发。该标记不能检测 shell、编辑器或外部进程修改，false 不证明文件仍未变。

<a id="usage-and-privacy"></a>

## 用量与隐私

只有通过非负安全整数及一致性校验的 token 计数参与汇总；部分报告仅表示已知部分，求和溢出保持未知。错误/取消前已观察到的用量保留，不推算服务端费用。

缓存统计由 [Providers](PROVIDERS.md)校验，TUI 在原始事件上计算覆盖与累计率；报告基础 totals 不混入缓存字段。界面不能再累加报告总量造成重复计算。

报告不含命令正文、stdout/stderr、文件正文、任务文本或模型答案。路径/哈希仍是任务数据；工具返回与保存历史可能包含敏感内容，元数据报告不是全局脱敏系统。进程崩溃、强制终止或事件回调抛错不保证最终报告。

<a id="verification-and-unimplemented-scope"></a>

## 验证与未实现范围

检查空日志不被模型声明填充、拒绝不算执行、失败后事实保留、父子去重、跨回合隔离、请求/用量缺失、截断与清理，以及保存失败的最终事件。固定编码脚本独立重跑测试并核对文件，不能由普通报告替代。

没有跨重启 journal 恢复、文件版本与测试结果的完整绑定、最终回答逐句认证、Task 关卡或成本账单。后续验收能力需定义可独立核对的任务结果。
