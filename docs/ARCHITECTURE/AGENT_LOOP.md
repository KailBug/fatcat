# Agent Loop：当前实现与后续安排

## 当前状态

最小 Loop 已通过离线测试、真实 DeepSeek 闭环验证和用户 review。阶段 2A 复用该 Loop 增加内存 Session 与连续对话，阶段 2A 已验证并通过用户 review；Session 独立记录在 [SESSION.md](SESSION.md)。这里只描述当前落地边界。

## 模块与接口

| 模块 | 当前职责与接口 |
| --- | --- |
| `src/cli.ts` | 解析任务文本、`--prompt`、`--chat`、帮助与配置检查；管理 Ctrl+C；选择入口并输出退出码 |
| `src/chat.ts`、`src/session.ts` | 连续输入和跨回合历史管理，详见 Session 文档 |
| `src/config.ts` | `loadConfig(env = process.env): Config` 校验 Key、模型、迭代上限和单次请求超时 |
| `src/model.ts` | `createDeepSeekModel(config, transport?, tools?): Model` 创建唯一模型客户端；提交请求、校验响应、转换服务错误 |
| `src/tools.ts`、`src/tools/` | 创建内置工具集合，提供定义和异步执行；默认 sum，显式工作目录额外提供 read 与 write，实际写入检查工作目录权限，详见 TOOLS.md |
| `src/loop.ts` | `runAgentTurn(prompt, history, options)` 在副本上执行一轮用户任务，返回答案及完整历史；`runAgent(prompt, options): Promise<string>` 保持单次任务入口 |
| `src/subagent.ts` | 显式开启的单层委派包装器，复用空历史 Loop，限制子任务次数及轮次 |
| `src/errors.ts` | `HarnessError` 携带稳定错误码与可展示的英文提示；共享取消检查 |
| `scripts/verify-live.ts` | 显式真实模型验证：直接回答、工具闭环、依赖前文的追问、样例工作目录读取、子任务委派及临时目录读改读，与离线测试分开 |

`Model` 是接收 SDK 消息数组、返回一个已校验模型回合的函数类型，服务于当前 Loop 和离线测试。没有模型注册表、插件体系或多供应商抽象。

可注入的 `transport` 仅用于在 SDK 请求边界验证实际 JSON 与错误行为；生产客户端地址固定为 `https://api.deepseek.com`。CLI 创建一个 Tools 实例，传给模型和 Loop/Session，保证实际启用的定义与执行入口一致。省略 tools 时使用仅含 sum 的默认集合。

## 数据流与内存历史

1. CLI 从参数获得单个任务，或由 `--chat` 逐行交给 Session，加载本地配置。
2. Loop 为单次任务建立新的 system 消息；Session 则提供此前成功历史。Loop 复制历史并追加新 user 消息，在副本上执行本轮任务。
3. Loop 在开始回合时调用可选 tools.forTurn，为委派初始化独立额度；每次请求通过 getWrites 获取独立写入记录，作为临时数据消息提供给模型，不保存进 Session 历史。模型客户端携带请求消息和工具定义请求 DeepSeek。
4. 最终回答时，Loop 返回内容与完整历史。单次任务输出后结束；Session 保存本轮历史，连续对话等待下一条输入。失败则不保存本轮历史。
5. 工具调用时，先保留 assistant 消息，再顺序等待每个异步工具调用，执行后先报告新增或变化的写入记录，再检查取消；工具结果写成 role=tool 消息，保留原始 tool_call_id。
6. 将包含关联结果的历史提交给下一轮模型，直到得到最终回答或明确失败。

同一响应中的多个工具调用按顺序处理，也支持后续回合继续调用工具。同一用户回合内 ID 重复、响应结构不合法、终止原因与工具列表不一致时停止，避免构造歧义历史。

## DeepSeek 接入决策

- 使用 `openai@7.18.0` 作为 DeepSeek Chat Completions 的兼容客户端，模型配置默认 `deepseek-flash`。
- 请求设置 `stream: false`、`thinking: { type: "disabled" }`、`tool_choice: "auto"` 和 `max_completion_tokens: 2048`。
- 第一阶段明确使用非思考模式；没有实现 reasoning_content 的历史管理，也没有暴露启用思考模式的配置开关。
- 禁用 SDK 自动重试，使模型轮次和实际请求次数对应，避免隐藏重试扩大运行时间。
- 默认单次请求 60 秒；SDK timeout 与覆盖整个请求的 AbortSignal deadline 共同限制等待，外部取消信号也会传入 SDK。
- 关闭 SDK 自身日志，不输出服务端原始错误对象；HTTP 错误只保留状态码及可操作的通用提示。
- 显式设置 DeepSeek Key 和地址，不使用 OpenAI Key；也不继承 OpenAI organization / project 配置。

依据：[DeepSeek 工具调用](https://api-docs.deepseek.com/guides/tool_calls/)、[思考模式控制](https://api-docs.deepseek.com/guides/thinking_mode/)、[OpenAI SDK 文档](https://developers.openai.com/api/docs/libraries)。具体 SDK 行为同时核对了已安装版本的类型与 README；真实验证结果见 [PROGRESS.md](../PROGRESS.md)。

## 工具校验与错误回传

`sum` 接收仅包含 numbers 的对象，numbers 为 2 至 32 个有限数字。执行前显式校验 JSON、字段、数组长度和数值；不依赖模型承诺或供应商的 Beta strict 模式。

sum 成功结果为 `{ ok: true, result: number }`；目录和文件工具的 result 为 JSON 对象，包含相对路径及条目或正文。各工具的详细协议与限制见 [TOOLS.md](TOOLS.md)。非法 JSON / 参数、未知工具、求和溢出返回 `{ ok: false, error: { code, message } }`，关联到原调用并回传模型，由模型在剩余轮次内纠正或解释。

sum 使用 JavaScript number 运算，浮点精度遵循 JavaScript 语义，不是任意精度计算器。sum 不访问网络、文件、时钟或进程；文件工具只访问显式指定的目录，write 需要 workspace-write 权限；没有 shell 或网络工具。

## 终止与日志

- 每次模型请求计为一次迭代，每个用户回合默认最多 8 次；连续对话在新用户输入时重置计数。
- 最后一轮如仍提出工具调用，直接以 MAX_ITERATIONS 终止，不执行无法回传给后续模型的调用。
- 缺失配置、模型服务失败、超时、截断或无效响应均明确终止；不把部分响应当作最终成功。
- Ctrl+C 发出取消信号，CLI 返回 130。其他运行错误返回 1，参数错误返回 2，成功返回 0。
- Loop 事件包括 model_request、tool_result、write_record、completed 和 stopped；委派时用 subagent_event 包装子事件，并记录父调用 callId。CLI 将事件写入 stderr，最终答案写入 stdout；连续对话添加用户回合编号 turn，重置时另发 session_reset。
- 日志包含轮次、工具名、调用 ID、成功标志和停止原因；write_record 另含相对路径、内容摘要、大小、状态及残留临时路径。日志不包含提示词、文件正文、完整参数、Key 或原始 SDK 错误。失败和 finally 同样检查记录变化，取消不丢失已发生事实。

这是第一阶段的必要日志，不是完整决策追踪或恢复体系。

## 验证与后续安排

离线测试覆盖配置边界、工具参数和溢出、多工具关联、多轮纠错、迭代上限、协议错误、HTTP / 网络故障、超时、取消以及 CLI 退出码。

真实验证已覆盖直接回答、工具闭环、Session 追问和完整 CLI 入口；详细结果以 PROGRESS.md 为准。阶段 2B 已通过用户 review；阶段 2C 和 2D-1 已通过用户 review；2D-2 受控 write 已完成离线及真实读改读验证，待 review。持久化、并行调度及其他子系统仍未实现。
