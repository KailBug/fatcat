# Agent Loop：装配、请求与终止

[架构总览](README.md)

Loop 执行一个用户回合，保持模型消息与工具结果的关联，落实请求余额和取消。它不选择会话、不保存磁盘记录，也不持有界面或各工具的执行规则。

## 模块职责

| 源码 | 职责 |
| --- | --- |
| `packages/runtime/src/agent.ts` | workspaceAgentFactory 准备工作目录资源；createAgent 装配父子 Model、Tools、Skills、动态指导及实际 Session 身份 |
| `packages/runtime/src/loop.ts` | runAgentTurn 在历史副本上请求模型、顺序执行工具并生成事件；runAgent 提供单次调用 |
| `packages/runtime/src/system-prompt.ts` | 共用 systemPrompt、委派/自动任务/资料指导文本，以及目录和权限说明的纯格式化函数 |
| `packages/runtime/src/model.ts`、`packages/runtime/src/model-usage.ts` | SDK 请求、响应校验、安全错误及用量观察，见 [Providers](PROVIDERS.md) |
| `packages/runtime/src/errors.ts` | 稳定 HarnessError 错误码与取消检查 |
| `packages/cli/src/cli.ts`、`scripts/start.ts` | 启动参数/入口选择与调用目录恢复，操作见[命令参考](../REFERENCE/COMMANDS.md) |

Session 的提交与恢复归 [Session](SESSION.md)；请求省略和压缩归 [Context](CONTEXT.md)；工具执行归 [Tools](TOOLS.md)。

## Agent 装配边界

Agent 装配统一维护在 `packages/runtime/src/agent.ts`，CLI、TUI、Web UI 通过 `@fatcat/runtime/agent` 准备工作目录资源。`createAgent` 和 `workspaceAgentFactory` 保持原有参数及返回契约；旧 workspace-agent 模块与根 src 下的运行核心路径均不提供兼容转发。

- **工作目录资源。** workspaceAgentFactory 的每个实例按规范目录缓存基础 Tools，Windows 键忽略大小写，保留其权限回调和执行 journals。只有工具构造成功后才缓存；每次选择都重新发现 Skills 并装配 Agent。缓存不保存绑定会话后的工具、模型、附件或 Memory 访问器，也不持有当前选中 Session。
- **父子装配。** createAgent 依次在基础工具上包装附件、Memory 读取及 Skills，形成父子共享能力；子 Model 使用这个集合，父集合再增加有界委派、automation 和可用的 Memory 写入包装。装配本身不发送模型请求。摘要模型仍单独创建，不继承父工具或动态指导。
- **会话绑定。** forSession 从基础资源重新生成绑定实际身份和资料访问的组件，只替换仍是原装配结果的 tools/model；调用者覆盖的工具、模型和其他 Session 选项保留。自定义模型仍接收执行身份及可用的 Memory 请求上下文。Session 记录、切换与持久化继续由会话层拥有。
- **请求指导。** sharedAgentGuidance 每次请求读取当前权限，只负责选择并组合说明；文本和目录/权限的格式化归 system-prompt.ts，其函数不读取可变策略或持有 Tools。父请求额外添加委派与当前时间指导。bindSessionModel 保持身份与 Memory 包装顺序，withGuidance 只修改请求副本，转发取消、观察器及请求选项，不改写历史。委派指导保持直接处理简单任务、聚焦独立子任务、有界上下文、顺序执行与证据核对的要求；简化措辞不改变实际权限或预算，离线检查不证明真实模型委派选择质量。

后续装配调整沿这三个生命周期区分资源：工作目录可复用、会话按身份绑定、请求读取当前策略。不要把 Session 状态或资料授权放入目录缓存，也不要为拆分文件另建配置或状态所有者。对应装配回归放在 `packages/verification/tests/agent/`；跨会话 Memory、附件及目录切换的契约继续由各责任域测试维护。

## 回合流程

1. 复制已完成历史，加入当前用户消息；动态 system、工作目录、权限、Skills、Memory、委派和执行事实只装入请求副本。
2. 构造模型请求，测量包含工具定义及专有参数的完整 JSON。超限先尝试旧 read 省略，符合条件时由 Session 协调自动 compact。
3. 无工具调用的非空最终回答结束回合，返回答案与完整消息。正常返回不代表任务通过。
4. 有工具调用时，Model 校验调用类型、非空名称/ID 和参数字符串；Loop 记录 assistant 批次，拒绝重复 ID，再顺序执行工具。工具层解析并校验参数 JSON，结果按原 ID 追加为 tool 消息。
5. 在消息检查点交还已发生内容，继续请求。存储边界可据此保存未完成 attempt；Loop 自身不做文件 I/O。

调用 ID 在同一用户回合内不得重复，结果不能与其他批次错配。参数必须是合法对象；未知工具或可恢复的工具错误作为关联结果返回，供模型纠正。协议错误、取消及不可恢复的模型错误明确终止，不把半个工具批次当作成功历史。

## 预算与失败语义

每次模型尝试消耗回合请求余额。最后一次保留给文字交付，请求中禁用工具；模型仍违规调用工具时停止。视觉辅助请求与自动摘要也消耗所属回合预算，不能绕过最后交付预留；子任务另有窄额度，见 [Subagent](SUBAGENT.md)。

每次请求同时受期限和完整请求字节限制。SDK 自动重试关闭；用量只采纳通过校验的服务端计数。字节限制不是 token 限制或进程内存硬上限。

取消在循环、模型和工具边界传播。超时、迭代耗尽、协议错误和取消保留已发生的操作与用量；不自动重跑工具、回滚文件或撤销外部请求。完整历史提交与最后事件时机由 AgentSession 协调，避免把模型已回答误报成会话已保存。

## 指导与事件

systemPrompt 要求先检查相关代码、完成已授权任务、报告实际检查，并尊重只读 review 请求。它是模型指导，不能替代运行时权限或保证正确性。当前程序规则由本次启动提供，不由恢复历史中的旧 system 消息决定。

模型观察包含请求大小、用量、旧读省略和辅助请求类型。Loop 补充回合/迭代及父子关系，工具提供操作事实；汇总口径见 [Execution reports](EXECUTION_REPORT.md)。普通事件不输出密钥或原始服务错误，工具正文仍可能进入明文历史。

## 验证与未实现范围

关键检查包括多工具关联、重复 ID、参数错误、空响应、最后文字轮、期限、取消、预算拒绝、失败后副作用保留及提交事件顺序。自动测试使用注入模型/传输；固定真实 DeepSeek 场景曾覆盖直接回答、工具闭环和编码任务，不证明开放任务成功率。

未实现 Graph 执行、并行工具调度、自动重试事务、文件恢复检查点或答案正确性认证。新抽象须由具体执行需求推动。
