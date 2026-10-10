# Context：上下文投影与手动压缩

## 2026-10-10：上下文管理与 compact

本轮在 `feat/session-perfection` 将原请求投影迁入 `src/context/`，增加显式上下文状态、完整回合边界与手动压缩。参考本地 `D:/pi/packages/coding-agent/src/core/session-manager.ts` 的 `buildSessionProjection` / `CompactionEntry`，以及 `core/compaction/compaction.ts` 的摘要与保留区间设计。使用具名接口、明确状态所有权和直接模块引用；不引入 pi 运行时、JSONL 树或新的 SDK。实际验证见 PROGRESS。

| 模块 | 职责 |
| --- | --- |
| `src/context/manager.ts` | 压缩状态解码、原始历史到模型历史的投影，以及两者的 JSON 字节/消息统计。纯函数，不持有第二份活动 Session。 |
| `src/context/request.ts` | 原有完整请求体计量和旧成功 read 省略；最终精确预算仍由 Model 检查。 |
| `src/context/compaction.ts` | 选择完整回合边界、预先规划有界摘要分段、生成候选摘要和检查实际缩减。无文件 I/O、工具执行或自动重试。 |
| `src/context/commands.ts` | chat、TUI、Web UI 共用 `/context`、`/compact [instructions]`，命令不进入保存的用户历史。 |

数据流：Session 完整历史 → Context 投影（摘要＋最近保留区间）→ Loop 附加当前执行事实和回合预算 → Agent 加入当前工作区/权限/Skills 指导 → Model 构造完整供应商请求 → request 按需省略旧 read → 精确字节检查 → SDK。Loop 的检查点与成功出口始终使用完整历史。

`CompactionState` 记录版本、摘要、`firstKeptMessage` 和时间。边界是不可变前缀之后的原始消息下标，必须落在 user 消息，且前一消息是无工具调用的最终 assistant；不会拆开工具调用批次。Session 的 v1 JSON 增加可选 `compaction`，旧文件缺省为无压缩，新文件保留完整原文。恢复、命名、工作区切换与 fork 保留该字段，新会话/reset 清除。旧程序可能忽略摘要字段并恢复完整上下文，不承诺降级后的压缩状态保留。

手动 compact 保留最近一个完整用户回合，只摘要更早内容。重复压缩以旧摘要加新进入压缩范围的原文为输入，避免把最早原文重复发送。摘要作为明确标识的历史上下文进入普通消息，不能成为 system 策略或恢复权限；运行时指导、工具事实和未完成 attempt 恢复提示继续独立加入。

摘要使用当前 provider 的独立文本请求，不附加工具定义、委派/自动任务指导或真实工具执行。按源文本顺序分段，保留 Unicode；模型合并上一摘要和下一段。单次操作最多 `min(maxIterations, 8)` 个请求，规划超限时不发送任何摘要请求，不悄悄丢弃正文。摘要上限为 `min(8192, floor(maxRequestBytes / 8))` UTF-8 字节，附加指令上限 2048 字节；至少要求 4096 字节请求预算，实际仍须容纳提示和正文。规划预留供应商封装空间，SDK 发送前再次精确检查完整请求。工具调用、空摘要、超长摘要、无缩减、取消、传输失败均拒绝候选，无隐藏重试。

持久会话通过 Manager 操作锁串行运行 compact。生成前保存原记录以验证修订，生成后再次以预期修订原子保存候选，再刷新活动投影。失败保留原历史、原摘要和原 attempt；生成前的修订领取可能已写盘。跨进程采用乐观修订检查，不持有贯穿模型调用的磁盘锁；其他进程更新后候选发布失败，不覆盖其内容，已消耗的模型费用不撤销。压缩本身不创建可重放 attempt，进程终止后使用最后成功保存的状态。

chat 以 `operation: compaction` 输出请求/用量/执行报告；TUI 累计实际摘要消费但不增加已完成对话回合，清除摘要请求的上下文用量观测；Web UI 在当前页面显示操作及报告，恢复时仍展示原问答。Web UI 的 Stop、TUI 的 Escape/Ctrl+C 和 chat 取消信号传递到摘要请求。Web UI 不把摘要的输入 token 当作压缩后对话占用，成功后清空旧观测，等待下一次普通请求。`/context` 的数据不含工具定义、动态指导及执行 journals，不能充当完整请求或 token 估计。

首版只提供用户显式压缩，没有自动阈值触发、溢出重试、长期记忆、树形历史或原文删除。摘要有损且模型生成，需通过任务验证判断质量；可能遗漏 Skill 细节，应按需重新加载。最新完整回合、当前回合、工具事实或摘要本身仍可能超预算。完整原文保留意味着内存与 64 MiB 快照上限不变；八请求内无法处理的历史需要提高显式预算或新建会话。本轮离线和浏览器证据不能证明真实模型摘要质量。

## 当前状态与范围

以下记录阶段 2D-8 的旧读取省略机制：已通过离线与真实多回合验证，随 PR #10 合入 main；详细证据见 [PROGRESS.md](../PROGRESS.md)。它继续作为手动压缩之后的请求容量防线，目标是在连续对话累积较早 read 结果后尽可能满足字节预算。

后续 Web UI 的 context-usage.ts 仅观察最近父请求的有效 prompt tokens，并对照六个已核对精确模型的 token 窗口显示比例；未知用量/窗口不估算，恢复或切换后清空观测。它不计算草稿或最终响应 token，不作为当前完整历史的 token 测量；不改变本模块的完整 JSON 字节预算和省略规则，不增加 tokenizer 或模型请求。指标来源与容量依据见 [WEBUI.md](WEBUI.md)，TUI 的现有预算显示不随之改变。

## 职责与数据流

`src/context/request.ts` 导出 `prepareRequestContext(body, limitBytes, signal?)`，接收包含 messages 的完整 JSON 请求体，返回 body、beforeBytes、bytes 和 omittedReadResults。无文件访问、网络请求、缓存或持久状态；使用 Node 的 JSON 序列化和 UTF-8 字节计量。

Session 持有完整成功历史 → Loop 复制历史并附加当前消息与临时执行事实 → agent.ts 在父请求副本补充委派指导 → model.ts 组装含工具定义及生成参数的完整请求 → context/request.ts 测量并按需整理 → model.ts 发出元数据并检查最终预算 → 通过后才调用 SDK。

旧 read 省略本身不改变 Session / Loop 接口。context/request.ts 只复制消息数组及被替换的 tool 消息，不修改传入内容。返回原 body 或请求副本，均不作为 Loop 的保存历史；下一次请求重新准备。这将“保存了什么”与“本次发送什么”分开，不增加策略注册表。

## 已实现的选择规则

1. 测量完整 JSON 正文字节，包含转义、system、父指导、工具定义、历史、执行事实和生成参数。未超过上限时原样返回，不遍历或解析读取结果。
2. 从末尾找到倒数第二条 user 消息，作为最近完成回合的起点；它到消息末尾全部受保护，因此当前回合和最近完成回合不会被整理。边界前必须是非空最终 assistant 答案且没有工具调用，否则保持原请求。当前内部历史每回合只有一条 user 消息，Loop 的临时事实插在 system 后、实际历史之前；此函数沿用这一内部契约，不负责导入或校验任意外部历史。
3. 仅扫描保护范围之前的消息，按局部 assistant 工具批次匹配 tool_call_id 与工具名；消费结果后删除关联，遇到新的 assistant 或 user/system/developer 消息重置关联。跨回合重复 ID 不会被错误关联到另一工具。
4. 仅匹配成功 read 的 JSON 结果，要求 kind 为 file / directory / search、path 为字符串，且分别有 content 字符串、entries 数组或 matches 数组。未知格式、未关联结果、错误以及 write / shell / delegate_task 等结果全部保留。
5. 将整个较早 read 结果换成标记；仅实际减少消息序列化字节时才替换。按最旧优先处理，达到预算就停止，不按内容猜测语义重要性，也不逐行截断成貌似完整的结果。最后重新测量完整请求正文，不能只依赖局部差值。
6. 整理后仍超限，model.ts 返回 MODEL_CONTEXT_LIMIT，该请求不进入传输；没有额外模型摘要或重试。准备入口与遍历中检查取消。

所有用户、system、assistant 消息均保留；调用 ID 和原始参数保留；独立写入/命令事实不在候选范围。当前单次任务和新子任务没有更早完成回合，不能靠本功能省略其当前工具结果。完整原始历史不会因为请求成功、失败或取消而被替换。

## 请求中的标记与重读

标记沿用关联 tool 消息，仅替换 content 的 JSON 数据：

```json
{
  "ok": true,
  "result": {
    "kind": "context_omitted",
    "originalKind": "file",
    "path": "src/example.ts",
    "notice": "Earlier read output omitted from this request to fit the byte budget. It is not evidence of current file contents. Repeat the original read, or a narrower read, if needed; files may have changed."
  }
}
```

ok 表示原调用成功，不表示此请求仍有原正文；kind 明确区分省略标记。实际 read 工具的返回协议不变，也不会生成这种标记。原调用保留 path、query、offset、limit 等参数，模型需要正文时可以再次 read；基础 system prompt 要求不能把标记或旧摘要当作当前文件证据。重读仍经过原路径、权限、大小与分页检查，获得的是当前数据，文件变化可能改变内容和分页位置。

## 观察与验证

`context_reduction` 包含 beforeBytes、afterBytes、omittedReadResults；Loop 添加 iteration，子事件按既有链路透传。只有真正省略了结果才发出，随后 model_input 使用最终正文大小。日志不含被省略的路径、正文或查询。

回合报告的 contextReduction 分 parent / children，按每次请求累计 requests、omittedReadResults、bytesSaved。同一个旧结果被两个请求省略会计两次；整理后仍超限或传输失败也保留记录。这不是 token 或计费节省，详情见 [EXECUTION_REPORT.md](EXECUTION_REPORT.md)。

离线测试涵盖精确字节与 SDK 正文一致、当前/最近回合保护、关联和重复 ID、文件/目录/搜索、错误和执行事实保留、不可变输入、失败与 reset、文件更新后重读，以及真实 CLI 入口。`pnpm run verify:context` 使用三回合临时只读样例和 26000 字节预算验证整理、重读及前文格式要求，最多 27 次真实请求；固定编码回归使用现有 verify:coding。实际结果以 PROGRESS 为准。

## 限制与后续方向

完整历史仍驻留内存，构造、序列化和 JSON 解析也消耗内存；这不是内存硬上限。用户要求、assistant 复制的正文、非 read 结果、当前/最近回合和执行事实仍可能填满预算。请求字节不等于 token，符合本地预算仍可能被服务端拒绝。

旧读取省略本身不删除或重写用户要求、不做模型摘要。手动 compact 的有损摘要与持久化边界见本页开头；本模块仍不提供文件快照、索引、缓存或长期记忆。2D-14 的会话恢复由 SessionManager / Store 负责。小样例只证明相应行为，不证明大仓库成功率、最优选取或成本改善。

2D-9 通过同一 Session 的多文件修复及后续需求记录具体行为和失败原因，不改变本模块。双回合样例要求重读当前文件；它的第一回合在第二回合仍属于受保护的最近完成回合，因此不要求触发旧读取省略，不能替代三回合的 verify:context。是否需要更完整的上下文组织或任务证据能力，继续由实际任务决定，不预建接口。

2D-10 的完整 SKILL.md 读取返回 `kind: skill`，因此不符合 file/directory/search 候选条件，在任何已成功回合中均保留其指令。Skill 的引用资源仍按普通 file/directory/search 结果处理，可在满足旧回合条件时省略。启动目录元数据位于请求提示中，同样计入预算；省略不会扩大预算或改变供应商协议。每个供应商先构造包括专有字段的完整请求，再调用同一 prepareRequestContext，字节统计与实际 SDK 正文一致。详见 [SKILLS.md](SKILLS.md) 和 [PROVIDERS.md](PROVIDERS.md)。
