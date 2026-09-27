# Agent Loop：当前实现与后续安排

## 当前状态

最小 Loop 已通过离线测试、真实 DeepSeek 闭环验证和用户 review。阶段 2A 复用该 Loop 增加内存 Session 与连续对话，阶段 2A 已验证并通过用户 review；Session 独立记录在 [SESSION.md](SESSION.md)。这里只描述当前落地边界。

## 模块与接口

| 模块 | 当前职责与接口 |
| --- | --- |
| `src/system-prompt.ts` | 父子 Loop 共用的英文 systemPrompt：CLI 编码协作、沟通、工具边界和证据化交付 |
| `src/agent.ts` | `createAgent(config, baseTools?, transport?, skills?)` 装配父子模型与工具，内部包装 Skill read，返回 model / tools / maxIterations；委派与 Skill 指导不进入保存历史 |
| `src/cli.ts` | 解析任务文本、`--prompt`、`--chat`、`--listSkills`、帮助与配置检查；发现本地 Skills；管理 Ctrl+C；选择入口并输出退出码 |
| `src/chat.ts`、`src/session.ts` | 连续输入和跨回合历史管理，详见 Session 文档 |
| `src/terminal.ts` | 统一终端输入，隔离聊天、写入及命令确认，管理提示颜色及终端取消 |
| `src/config.ts` | `loadConfig(env = process.env): Config` 校验 Key、模型、迭代上限、单次请求超时与请求体字节上限 |
| `src/providers.ts` | 四家供应商的配置描述、固定 endpoint 与专有请求参数；详见 PROVIDERS.md |
| `src/model.ts` | `createModel(config, transport?, tools?): Model` 按配置创建客户端；检查完整请求大小、观察收到的用量、校验响应、转换服务错误；保留 createDeepSeekModel 兼容入口 |
| `src/skills.ts` | 本地 Skill 元数据发现与校验、模型目录、read 包装与按需加载；详见 SKILLS.md |
| `src/context.ts` | `prepareRequestContext(body, limitBytes, signal?)` 测量完整请求，仅超预算时省略受保护范围外的旧 read 内容；不修改历史，详见 CONTEXT.md |
| `src/model-usage.ts` | 严格校验供应商 token 计数并转换为 TokenUsage；非法或缺失时为 null |
| `src/tools.ts`、`src/tools/` | 创建内置工具集合，提供定义和异步执行；默认 sum，显式工作目录额外提供 read / write / shell，执行处落实各自权限，详见 TOOLS.md |
| `src/loop.ts` | `runAgentTurn(prompt, history, options)` 在副本上执行一轮用户任务，返回答案及完整历史；`runAgent(prompt, options): Promise<string>` 保持单次任务入口 |
| `src/subagent.ts` | CLI 默认装配的单层委派包装器，复用空历史 Loop，限制子任务次数及轮次 |
| `src/execution-report.ts` | CLI/chat 的每回合事件观察器，转发原事件并在根回合结束时发出独立 execution_report，详见 EXECUTION_REPORT.md |
| `src/errors.ts` | `HarnessError` 携带稳定错误码与可展示的英文提示；共享取消检查 |
| `scripts/verify-coding.ts` | 临时多文件故障样例的真实搜索定位、读改测验证，仅允许指定源文件修改和固定测试命令，独立核对结果 |
| `scripts/verify-context.ts` | 三回合只读临时样例，触发请求整理并验证文件变化后的重读与前文要求保留 |
| `scripts/verify-delegation.ts` | 复用 CLI 装配的真实模型验证：算术直接完成、隔离上下文审查的默认委派，使用独立只读临时样例 |
| `scripts/verify-live.ts` | 显式真实模型验证：直接回答、工具闭环、依赖前文的追问、样例工作目录读取、子任务委派及临时目录读改读，与离线测试分开 |

`Model(messages, signal?, observe?)` 接收 SDK 消息数组，返回已校验模型回合；可选 observe 接收 ModelObservation 元数据，服务于当前 Loop 和离线测试。旧的双参数注入模型仍可用，但不提供新元数据。供应商选择通过小型 profile 实现，没有模型注册表、动态插件体系或模型路由。

可注入的 `transport` 仅用于在 SDK 请求边界验证实际 JSON 与错误行为；生产客户端使用所选 profile 的固定厂商/区域地址，见 PROVIDERS.md。CLI 先创建带权限和记录的基础 Tools，发现本地 Skills 并以第四参传给 createAgent，由后者包装 Skill read、装配父子模型与委派工具；父模型和 Loop/Session 共用含委派的 Tools，子模型与子 Loop 共用带 Skill read 的基础 Tools。createAgent 默认基础工具为 sum，父集合增加 delegate_task；低层 createTools 和 runAgent 省略 tools 时仍只提供 sum，程序化调用者需显式注入 Skills。装配本身不发送网络请求。

## 数据流与内存历史

1. CLI 从参数获得单个任务，或由 `--chat` 逐行交给 Session，加载本地配置。
2. Loop 为单次任务建立新的 system 消息；Session 则提供此前成功历史。Loop 复制历史并追加新 user 消息，在副本上执行本轮任务。
3. Loop 在开始回合时调用可选 tools.forTurn，为委派初始化独立额度；每次请求通过 getWrites / getCommands 获取独立写入和命令记录，作为临时数据消息提供给模型，不保存进 Session 历史。模型客户端组装包含 Skill 元数据目录的完整请求体，交由 context.ts 在需要时省略旧读取内容，校验最终字节预算后，携带请求消息和工具定义请求所选供应商；已收到的用量在答案解析前观察。
4. 最终回答时，Loop 返回内容与完整历史。单次任务输出后结束；Session 保存本轮历史，连续对话等待下一条输入。失败则不保存本轮历史。
5. 工具调用时，先保留 assistant 消息，再顺序等待每个异步工具调用，执行后先报告新增或变化的执行记录，再检查取消；工具结果写成 role=tool 消息，保留原始 tool_call_id。
6. 将包含关联结果的历史提交给下一轮模型，直到得到最终回答或明确失败。

同一响应中的多个工具调用按顺序处理，也支持后续回合继续调用工具。同一用户回合内 ID 重复、响应结构不合法、终止原因与工具列表不一致时停止，避免构造歧义历史。

## System prompt（当前实现）

`src/system-prompt.ts` 集中维护基础提示词，Loop 创建新历史时作为第一条 system 消息使用；单次任务、Session 新历史及子任务共用。已有内存历史保留其原 system；开发修改后需重新启动进程使用新构建。`agent.ts` 在父模型请求副本中追加委派指导，并为父子请求追加相同 Skill 目录及使用指导；不向子模型加入委派能力，不改变预算或权限，也不改写保存历史。

本轮按用户要求参考 Claude Code 的公开工作流方向，以 Fatcat 当前能力重新编写：简洁直接、跟随用户语言、实现请求执行读改测、先了解相关代码、保持改动聚焦、只在关键歧义时提问，并据实际结果报告验证与限制。保留 Fatcat 身份，不再默认扮演猫；用户明确要求时才使用角色化表达。提示词只描述实际暴露的工具，适配 Windows PowerShell、分页读取、独立命令授权和现有权限边界。

2D-8 补充 context_omitted 不含可用正文、需要当前内容时应重新定向读取的指导。特别强调工具 ok 不等于测试成功、历史哈希不证明当前文件、没有执行过的重读/测试/比较不能声称完成。它是模型行为指导，不是新增的确定性检查或权限机制，也不保证杜绝错误陈述。

参考（2026-09-25）：[Claude Code 官方最佳实践](https://code.claude.com/docs/en/best-practices)中的先理解代码、按任务复杂度决定规划与实际验证，以及[输出风格文档](https://code.claude.com/docs/en/output-styles)的沟通与编码工作方式区分。本项目没有复制或声称复现 Claude Code 的完整内部 system prompt，也没有引入它的额外工具、计划模式或恢复能力。

## DeepSeek 接入决策

本节保留 DeepSeek profile 的已验证约定。2D-10 新增 Kimi、MiMo 和 Qwen 的字段差异、固定地址、默认模型及开发规范见 [PROVIDERS.md](PROVIDERS.md)，不能将这里的 DeepSeek 专有参数直接复用于全部厂商。新增供应商仅做离线 SDK 合约检查，不进行本轮 API 在线验证。

- 使用 `openai@7.18.0` 作为 DeepSeek Chat Completions 的兼容客户端，模型配置默认 `deepseek-flash`。
- 请求设置 `stream: false`、`thinking: { type: "disabled" }`、`tool_choice: "auto"` 和 `max_completion_tokens: 2048`。
- 第一阶段明确使用非思考模式；没有实现 reasoning_content 的历史管理，也没有暴露启用思考模式的配置开关。
- 禁用 SDK 自动重试，避免隐藏重试扩大运行时间。Loop 的 model_request 统计模型调用尝试；本地预算拒绝或取消可能没有实际网络请求。
- 默认单次请求 60 秒；SDK timeout 与覆盖整个请求的 AbortSignal deadline 共同限制等待，外部取消信号也会传入 SDK。
- 关闭 SDK 自身日志，不输出服务端原始错误对象；HTTP 错误只保留状态码及可操作的通用提示。
- 显式设置 DeepSeek Key 和地址，不使用 OpenAI Key；也不继承 OpenAI organization / project 配置。

依据：[DeepSeek 工具调用](https://api-docs.deepseek.com/guides/tool_calls/)、[思考模式控制](https://api-docs.deepseek.com/guides/thinking_mode/)、[OpenAI SDK 文档](https://developers.openai.com/api/docs/libraries)。具体 SDK 行为同时核对了已安装版本的类型与 README；真实验证结果见 [PROGRESS.md](../PROGRESS.md)。

## 工具校验与错误回传

`sum` 接收仅包含 numbers 的对象，numbers 为 2 至 32 个有限数字。执行前显式校验 JSON、字段、数组长度和数值；不依赖模型承诺或供应商的 Beta strict 模式。

sum 成功结果为 `{ ok: true, result: number }`；目录和文件工具的 result 为 JSON 对象，包含相对路径及条目或正文。各工具的详细协议与限制见 [TOOLS.md](TOOLS.md)。非法 JSON / 参数、未知工具、求和溢出返回 `{ ok: false, error: { code, message } }`，关联到原调用并回传模型，由模型在剩余轮次内纠正或解释。

sum 使用 JavaScript number 运算，浮点精度遵循 JavaScript 语义，不是任意精度计算器。sum 不访问网络、文件、时钟或进程；普通文件工具只访问显式指定的工作目录，Skill read 另限于已发现的技能目录，write 默认由终端逐次确认，也可显式只读或预授权；shell 独立授权后以当前用户权限执行 Windows PowerShell，不是操作系统沙箱；没有专用网络工具。

## 终止与日志

- 每次模型请求计为一次迭代，每个用户回合默认最多 8 次；连续对话在新用户输入时重置计数。
- 最后一轮如仍提出工具调用，直接以 MAX_ITERATIONS 终止，不执行无法回传给后续模型的调用。
- 缺失配置、模型服务失败、超时、截断或无效响应均明确终止；不把部分响应当作最终成功。
- Ctrl+C 发出取消信号，CLI 返回 130。其他运行错误返回 1，参数错误返回 2，成功返回 0。
- Loop 事件包括 model_request、context_reduction、model_input、model_usage、tool_result、write_record、shell_record、completed 和 stopped；委派时用 subagent_event 包装子事件，并记录父调用 callId。CLI 将事件写入 stderr，最终答案写入 stdout；连续对话添加用户回合编号 turn，重置时另发 session_reset。
- 日志包含轮次、工具名、调用 ID、成功标志和停止原因；write_record 另含相对路径、内容摘要、大小、状态及残留临时路径。JSON 事件日志不包含提示词、文件正文、完整参数、Key 或原始 SDK 错误；shell_record 只包含命令结果元数据，不含命令正文与输出；终端确认显示写入片段或完整命令，不属于 JSON 日志。失败和 finally 同样检查记录变化，取消不丢失已发生事实。

shell 的工具 ok=true 仅表示拿到执行结果；测试是否通过须检查 result.success、exitCode、status 与截断标记。命令失败可回传模型继续处理；取消时先保留事实再结束回合。

CLI / chat 另通过 createTurnReporter 发出 execution_report。它基于本回合实际事件汇总，包含子任务且按记录 ID 去重；不是 LoopEvent 的新分支，也不送入模型或 Session。底层调用者需显式接入观察器。详情见 [执行报告](EXECUTION_REPORT.md)。

这是必要日志与执行摘要，不是完整决策追踪、任务认证或恢复体系。

## 模型请求预算与用量观察（2D-7 已实现）

HARNESS_MAX_REQUEST_BYTES 默认 262144（256 KiB），接受 1–16777216 的十进制正整数。Config 的 maxRequestBytes 也在创建客户端时校验，程序化调用不能用 NaN / Infinity 绕过检查。选择字节预算是为了用现有 Node/SDK 精确限制待发送正文，不增加 tokenizer 或猜测模型上下文容量；默认值是本地策略，可按任务显式调整。

model.ts 在创建请求 deadline 和调用 SDK 前通过 context.ts 计算 `Buffer.byteLength(JSON.stringify(body))`：计入消息、system、父委派指导、工具定义、完整历史及临时写入/命令事实、模型名和生成参数；包括 JSON 转义和 UTF-8，不包含 HTTP 头与认证 Key。与当前安装 SDK 的 JSON 序列化方式一致，并以注入传输读到的实际正文验证。2D-8 在原始正文超限时先按 [CONTEXT.md](CONTEXT.md) 省略较早成功 read 的请求内容，再计算最终完整正文。等于上限允许，仍超出返回 MODEL_CONTEXT_LIMIT，给出字节数、上限及恢复建议；不重试、不生成摘要、不修改保存历史。

ModelObservation 有三个分支：`context_reduction { beforeBytes, afterBytes, omittedReadResults }` 仅在本次投影实际替换内容时发出，不含路径或正文；`model_input { bytes, limitBytes, accepted }` 表示本地检查结果，accepted 不是服务端接受或计费确认；`model_usage { usage }` 表示收到响应时的已校验统计或 null。Loop 仅增加 iteration 并透传，子事件仍包装在 subagent_event 内；parentModel 包装器透传 observe，模型层不依赖 Loop 事件类型。

用量按 [DeepSeek Chat Completions 文档](https://api-docs.deepseek.com/api/create-chat-completion/)中的 prompt_tokens、completion_tokens、total_tokens 提取。三项必须都是非负安全整数且总和一致，映射为 promptTokens / completionTokens / totalTokens；非法或缺失时为 null，不影响本来有效的答案。仅允许这些计数字段进入事件，不记录原始 usage 对象、ID 或其他供应商字段。收到响应后先观察用量，再检查取消/deadline 和解析答案，因此截断或协议错误仍可保留已收到统计；HTTP/网络错误及响应前取消可能没有统计。

这不是 token/费用硬预算。未计缓存细分或金额，不估算未知请求；服务端可能仍因自身 token 限制拒绝较小正文。先构造和序列化完整正文才检查，Session 内存、用户输入及模型输出的分配不受这个字节预算控制。工具批次完成后才准备下一次模型请求，之前的副作用不会回滚；/reset 不清执行事实，事实本身超限时需先 review 后调整配置或新进程。当前只有请求侧的旧读取投影，完整分层上下文与自动摘要仍未实现。

## 验证与后续安排

离线测试覆盖配置边界、工具参数和溢出、多工具关联、多轮纠错、迭代上限、协议错误、HTTP / 网络故障、超时、取消以及 CLI 退出码。

真实 DeepSeek 验证已覆盖直接回答、工具闭环、Session 追问和完整 CLI 入口；详细结果以 PROGRESS.md 为准。阶段 2B 已通过用户 review；阶段 2C 和 2D-1 已通过用户 review；2D-2 原 write 已完成离线及真实读改读验证并合入 main；终端确认修正已合入 main。2D-3 的 shell 和固定样例编码闭环已通过离线与真实模型验证、用户 review 并合入 main。2D-4 默认委派迁移已通过 review 并合入；2D-5 的回合执行报告已通过 review 并合入；2D-6 的 read query 文本搜索已通过 review 并合入；2D-7 的请求容量与用量记录已通过 review 并合入；2D-8 的旧读取投影已验证并随 PR #10 合入，2D-9 的双回合验收已验证、待 review。2D-10 的 Skills 和新厂商使用离线测试，不能沿用上述真实模型证据宣称已在线验证。持久化、并行调度及其他子系统仍未实现。
