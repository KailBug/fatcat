# Tools：read、write、shell 与授权边界

## 当前状态

阶段 2B 的只读工具基线、阶段 2C 的最小委派已通过用户 review。阶段 2D-1 将 list_directory 和 read_file 合并为 read，增加目录分页和按行读取；该增量已通过 review。阶段 2D-2 新增受控 write、最小权限及独立写入记录，原功能已验证并合入 main，交互修正已通过用户 review；2D-3 新增 Windows shell 和命令事实，已通过 review 并合入 main；2D-4 默认委派迁移和 2D-5 回合报告已通过 review 并合入；2D-6 在 read 中增加字面文本搜索，已验证、待 review；本轮实现与验证事实见 [PROGRESS.md](../PROGRESS.md)。没有新增依赖，沿用 Node、pnpm、SDK、Loop 和 Session。

## 模块与接口

| 模块 | 已实现职责 |
| --- | --- |
| `src/tools.ts` | createTools(workspace?, permission = "read-only", approveWrite?, shellOptions?) 创建实际工具集合；统一 JSON 解析、名称查找、异步执行、取消和安全错误转换 |
| `src/tools/types.ts` | 工具定义、执行类型与 JSON 可序列化 ToolResult |
| `src/tools/sum.ts` | 纯计算示例工具的 Schema、校验与有限数求和 |
| `src/tools/workspace.ts` | createWorkspace(workspace) 固定工作目录；resolvePath(path, signal?) 检查边界，返回内部绝对路径、规范化相对路径及文件状态；resolveNewFile 验证已有父目录并拒绝覆盖 |
| `src/tools/read.ts` | createReadTool(workspace) 提供 read 定义、参数校验、目录与文本读取、分页及 query 分发 |
| `src/tools/search.ts` | 有界子树遍历、文本匹配、搜索分页与扫描覆盖标记 |
| `src/tools/text-file.ts` | read、search 与 write 共享有界 UTF-8 读取、文件身份核对、扩展名与编码限制 |
| `src/tools/write.ts` | createWriteTool 实现创建、精确替换、暂存与发布；持有写权限和进程内记录 |
| `src/tools/shell.ts` | 命令参数、独立权限、cwd 检查、命令记录及结果协议 |
| `src/tools/process.ts` | Windows PowerShell 启动、有限输出、超时、取消和 taskkill 进程树清理 |
| `src/cli.ts` | 默认 ask，解析 --workspace / --permission 并注入终端确认回调；不承担具体文件规则 |
| `src/terminal.ts` | 持有单一 readline 输入，隔离任务与确认答案，显示有界写入预览或完整命令预览，并返回单次批准/拒绝 |

Tools 包含 definitions 和 execute(name, argumentsJson, signal?, callId?)。可选 forTurn(onEvent?) 由委派包装器使用，隔离每回合次数与事件；基础 collectTools 保留内部命名 execute 函数。可选 getWrites() 返回深复制的 WriteRecord[]，由工作目录工具持有，Loop 只消费事实并记录事件。模型客户端和 Loop/Session 使用同一工具集合，结果按 tool_call_id 关联。

基础 createTools 没有工作目录时只提供 sum；CLI 经 createAgent 包装后另提供 delegate_task；显式 --workspace 增加 read、write 和 shell。CLI 默认 ask，write 在参数、路径与内容校验后请求终端确认。显式 read-only 无条件拒绝写入；workspace-write 仅预授权文件写入，不授权 shell。程序化 createTools 仍默认只读，ask 需要由调用方提供 approveWrite 回调。没有 workspace 时不能授予写权限。子任务自动复用相同工具、权限和写入记录；委派由 agent.ts 默认装配，无需 --subagent 开关。默认导出的 toolDefinitions / executeTool 继续只操作 sum。

旧模型工具名称 list_directory 和 read_file 已移除，调用返回 UNKNOWN_TOOL。项目尚无持久历史，不增加旧名称兼容层。内部 createWorkspaceTools 已替换为职责分离的 createWorkspace 与 createReadTool。

## read 协议

输入：`{ path: string, offset?: number, limit?: number, query?: string }`，拒绝额外字段及错误类型。

- path：非空相对路径，最多 1024 字符；`.` 为根目录，支持 `/` 和 Windows 反斜杠。
- offset：从 0 开始，默认 0，必须为非负安全整数；无 query 时文件表示跳过的行数、目录表示跳过的已过滤排序条目数；有 query 时表示跳过的匹配行数。
- limit：默认 100，范围 1–200 的整数；最多返回的行数、条目数或匹配行数，字节预算可能使实际数量更少。
- query：可选、非空白的有效单行 Unicode 字符串，最多 512 个 UTF-16 码元；拒绝控制码（非空查询内可含 tab）及未配对代理项。指定后转为文本搜索，见下节。
- 未指定 query 时，文件和目录由实际路径类型决定，无需 mode/action 参数。目录名称即使带 .txt 也返回目录页。

不带 query 的成功 result：

| 类型 | 字段 |
| --- | --- |
| 文件 | kind: file、path、offset、totalLines、startLine、endLine、content、truncated、nextOffset |
| 目录 | kind: directory、path、offset、totalEntries、entries: [{ name, type }]、truncated、nextOffset |

startLine / endLine 从 1 开始；空页二者为 null。totalLines 不把末尾换行计为额外空行；空文件为 0 行。content 保留 CRLF、LF、CR 原始换行；UTF-8 BOM 被移除。

truncated=true 表示还有未返回内容，nextOffset 指向下一行或条目；继续使用相同 path 和 nextOffset。完成时 truncated=false、nextOffset=null。offset 等于或超过末尾时返回空页，不报错或重复末页。

示例：`read({"path":"src/main.ts","offset":20,"limit":40})` 从第 21 行开始，最多读取 40 行。返回 nextOffset 时以它为准，不自行假设已返回 limit 行。

## query 搜索协议与覆盖（2D-6 已实现）

例如 `read({"path":"src","query":"createAgent","limit":20})` 在 src 下递归搜索，或指定文件只搜索该文件。区分大小写、纯字面子串匹配；同一行中出现多次只返回一次，不支持正则、glob 或跨行匹配。无需 shell、外部搜索程序或新权限，子 Agent 自动复用同一实现。

结果为 `{ kind: "search", path, query, offset, totalMatches, matches: [{ path, line, text }], truncated, nextOffset, scannedFiles, skippedFiles, complete }`。匹配路径相对于固定工作目录；line 从 1 开始，text 保留原始行内容但不含行尾换行或文件 BOM。先按相对路径的 UTF-16 码元排序，再按行号排序。使用相同 path/query 和 nextOffset 继续；offset 不代表源文件行号。空页或超出匹配总数时 nextOffset=null。

- 遍历先收集候选路径，整个子树最多扫描 1000 个原始条目（含随后过滤的条目）、128 个候选文本文件、选定目录下 12 层子目录。任一超限返回 SEARCH_LIMIT，不返回部分成功，需缩小 path。目录句柄随结束、失败或取消关闭。
- 隐藏名称、node_modules、链接、特殊文件和不支持扩展名由既有边界排除，不计入候选或 skippedFiles。此覆盖范围不等于整个磁盘目录；未解析 .gitignore，普通生成目录仍可能被扫描。
- 候选文件读取前再次解析路径，并复用 text-file 的身份、大小与严格 UTF-8 检查。递归搜索中，过大或编码/二进制控制字符不支持的候选被跳过，增加 skippedFiles 并置 complete=false；直接搜索单文件仍返回 FILE_TOO_LARGE / UNSUPPORTED_FILE。其他 I/O、消失或身份变化错误使整次搜索失败；取消终止回合。
- totalMatches / scannedFiles 仅统计成功读到的合规文本；complete=true 仅表示本次遍历发现的候选没有因大小或编码跳过，不保证目录在扫描期间未变化。complete=false 即使 totalMatches=0、nextOffset=null，也不能声称范围内无匹配。
- matches 整体 JSON 编码的 UTF-8 大小最多 16 KiB，包括转义、数组和分隔符，不含其余结果元数据；不截断行。下一条放不下时以 nextOffset 继续，单条本身超限则 OUTPUT_LIMIT。该预算不是 token 上限。
- 内存只保留有界路径集合、当前文件及当前匹配页；仍扫描所有候选和全部行来计算总数，每个候选沿用 1 MiB 上限。每次翻页重新遍历，无索引、缓存或一致性快照；文件变化可能改变总数和分页位置。

read.ts 负责统一参数入口和搜索分发；search.ts 只组合现有 Workspace / text-file 与搜索规则，不修改 Loop、Session、权限或日志协议。日志仍不记录查询、路径参数和匹配正文；工具结果会进入模型上下文。

## 输入、扫描与输出限制

- 文本文件最多 1 MiB（1048576 字节）；先检查已打开文件大小，再使用上限加 1 字节的缓冲检测读取期间增长。超限为 FILE_TOO_LARGE。
- 每页文件 content 的 UTF-8 字节预算为 16 KiB，始终保留整行。遇到下一行无法放入当前页时返回继续位置；如果单行本身超限，读取该行返回 OUTPUT_LIMIT，不提供残缺的成功结果。预算不包括结果元数据和 JSON 转义开销，不是 token 上限。
- 目录非递归扫描，最多接受 1000 个原始条目，包括随后被过滤的条目。超限返回 DIRECTORY_TOO_LARGE，不把不可继续的子集伪装成完整分页；已知子路径仍可以直接读取。
- 目录先完成过滤，再按名称的 UTF-16 码元顺序排序，与系统语言无关。每页还按条目的 JSON UTF-8 大小加分隔符计入 16 KiB 预算；外围数组和元数据不计入该预算。
- 保留原有文本扩展名集合：.txt、.md、.json、.ts、.tsx、.js、.jsx、.mjs、.cjs、.yaml、.yml、.toml、.csv、.html、.css、.xml、.sql、.py，不区分大小写。
- 严格 UTF-8 解码，拒绝非法编码和二进制控制字符。文件句柄在 finally 中关闭；目录迭代在结束、错误和取消时关闭。

每一页都是重新读取，不是快照；期间文件或目录变化可能使 offset 对应内容发生变化。当前没有版本令牌或一致性快照。每页都对整个有界文件做解码，尚未实现流式大文件读取；有 query 的递归搜索使用上节规则。

## 工作目录与访问边界

- 工作目录显式授权并在初始化时 realpath 解析为固定根目录。
- 拒绝父目录跳转、绝对路径、Windows 盘符/UNC/设备路径、NTFS 数据流及不支持的名称。
- 拒绝点开头路径段（包括 .env、.git）与 node_modules；“隐藏”是名称规则，不代表 Windows 隐藏属性。
- 逐级 lstat 拒绝符号链接、junction、特殊文件和文件硬链接；realpath 后再次检查目录包含关系和名称。目录条目复用相同路径检查。
- 打开文件后核对类型、硬链接计数、dev/ino。结果只暴露相对路径；不回传绝对根目录或原始文件系统错误。

这些检查不是操作系统沙箱，不能保证抵御恶意本机进程并发替换路径或内容。用户选择的文本会经工具结果发送给 DeepSeek；名称和扩展名过滤不等于内容脱敏。read 不写入；write 仅在授权后修改支持的文本，不执行文件。

## 错误、取消与历史

结果保持 `{ ok: true, result }` 或 `{ ok: false, error: { code, message } }`。使用 DIRECTORY_TOO_LARGE、OUTPUT_LIMIT、SEARCH_LIMIT；继续使用 INVALID_ARGUMENTS、PATH_NOT_ALLOWED、NOT_FOUND、UNSUPPORTED_FILE、FILE_TOO_LARGE、TOOL_IO、UNKNOWN_TOOL。sum 行为不变。

工具错误供模型纠正或说明，取消抛出 CANCELLED 终止回合。路径检查、目录迭代、文件读取循环及返回结果前检查 signal；不承诺立即中断底层文件系统调用。成功回合保留已读取页，失败回合仍采用现有 Session 临时历史丢弃规则。读取日志不输出内容或路径参数；write_record 记录规范化相对路径、摘要及结果状态，不记录正文。

## write 协议与权限（已实现）

输入严格二选一，不接受额外字段：

- `{ path, content }`：仅新建文件，路径已存在时 WRITE_CONFLICT；父目录必须存在。
- `{ path, oldText, newText }`：已有文件中替换唯一精确片段。oldText 非空，newText 必须不同；可用空 newText 删除该片段。不存在、多次匹配或重叠匹配均拒绝，不自动重试或覆盖整份文件。

模型工具描述要求先读后改。保留片段外的文本、原换行与 UTF-8 BOM；最终编码仍需满足 1 MiB 上限，拒绝未配对 Unicode 代理项和二进制控制字符。沿用 read 的路径与扩展名约束。策略固定在 Tools 实例上：ask 每次确认、read-only 拒绝、workspace-write 预授权。模型不能通过参数提升权限。ApproveWrite 接收 path、operation、bytes、newText 及编辑时的 oldText，通过 Promise<boolean> 返回单次批准；工具层不直接读终端。

成功结果为 `{ recordId, path, operation, beforeHash, afterHash, bytes }`。path 只含规范化相对路径；beforeHash / afterHash 是原始文件字节的 SHA-256，新建的 beforeHash 为 null。结果不包含正文，不承诺文件随后未被其他进程修改。

## 写入提交与失败边界（已实现）

1. 校验权限、参数、路径与文本。编辑时读取有界原始字节，确认 oldText 仅出现一次并生成新内容。ask 在此时请求确认，拒绝或 EOF 返回 PERMISSION_DENIED，取消抛 CANCELLED；都不会暂存文件或创建写入记录。批准后先复查父目录、文件身份及完整原始内容，冲突则拒绝。
2. 创建 WriteRecord，状态 started；在同一目录独占创建 `.fatcat-write-<id>.tmp`，写入全部字节、sync 并关闭句柄。写入期间同一 Tools 的其他 write 返回 WRITE_BUSY。
3. 再解析父目录并核对身份。编辑复核目标身份及完整原始字节；创建再次确认目标不存在。检查取消后才发布。
4. 发布前标为 uncertain；新建使用 link 将完整临时文件安装到目标，目标已存在则失败且不覆盖；编辑使用 rename 替换，避免原地写到一半。发布返回后立即标为 committed，不在返回与记录之间检查取消。
5. finally 清理临时文件。正常编辑已移动临时文件，ENOENT 可接受；其他清理失败返回 WRITE_CLEANUP，并保留相对 temporaryPath。文件已提交时状态仍为 committed，不能把工具错误解释为回滚。

暂存阶段失败标为 failed；发布阶段异常保守标为 uncertain，需读取当前文件再决定重试。创建发布遇到 EEXIST 可确定为 failed / WRITE_CONFLICT。初步参数、权限或片段校验失败不创建写入记录。底层错误通过既有工具边界转换，不暴露原始文件系统信息。

实现依据为 Node 文件操作接口：[link](https://nodejs.org/docs/latest-v24.x/api/fs.html#fspromiseslinkexistingpath-newpath) 与 [rename](https://nodejs.org/docs/latest-v24.x/api/fs.html#fspromisesrenameoldpath-newpath)。不声称这些操作构成多文件事务或崩溃恢复机制。新建需要文件系统支持硬链接；本机 Windows 验证已通过。

复查与发布之间仍有竞态窗口，没有跨进程锁或操作系统级比较并交换；不能抵御恶意本机进程。替换不保证完整保留 NTFS ACL、备用数据流及其他元数据；不提供文件删除、递归建目录或自动回滚。进程崩溃可能遗留临时文件；创建后清理失败时目标可能仍与临时文件构成硬链接，需要人工核查并清理后再使用 read/write。

## 写入事实所有权（已实现）

createWriteTool 持有最多 100 条已进入暂存阶段的记录；达到上限拒绝新写入，不丢弃旧事实。getWrites() 返回副本；不同 Tools 实例互不共享，父子任务使用同一实例。记录只有路径、操作、状态、摘要、大小及安全错误码，没有文件正文。

Loop 在每次模型请求时把记录作为临时数据消息提供给模型，不写入 Session 成功历史；工具返回、回合失败和 finally 均检查记录变化并发出 write_record。失败回合和 /reset 不影响记录或已提交文件，重启进程后记录丢失。父子两层事件可包含同一 id，消费者按 id 关联，不将其解释为两次写入。记录为历史事实，不是当前文件快照或持久执行日志。

离线测试通过真实临时文件及窄范围文件操作注入，验证冲突、取消、发布失败、清理失败、回合失败后继续与父子权限继承；真实模型完成临时样例创建与精确修改后的读回。详情以 PROGRESS.md 为准。

## shell 协议与授权（2D-3 已实现）

createTools 第四参数为 `{ permission?: "ask" | "deny" | "allow", approve?: ApproveShell }`，程序化默认 deny。CLI 默认 ask，--shell-permission 可设 deny 或显式 allow；--permission read-only 强制禁止命令，workspace-write 只预授权文件写入。没有工作目录时不能授予命令权限。默认工具可被模型选择，授权在实际执行入口检查。

输入 `{ command, cwd?, timeoutMs? }`，仅接受已定义字段。command 为非空、最多 4000 UTF-16 码元的有效 Unicode，拒绝控制码（允许换行和 tab）。cwd 默认 `.`，需通过现有路径检查且是目录，确认后复核身份；timeoutMs 默认为 30000，整数范围 100–120000。ApproveShell 接收规范化 cwd、完整 command 与 timeoutMs。终端展示全部转义命令，不截断批准依据；管道、拒绝、EOF 与批准前取消都不启动进程，已有排队任务不能变成批准。

工作目录仅约束启动位置，**不是操作系统沙箱**。命令可以在当前用户权限内读写目录外文件和访问网络，也不受 read/write 的扩展名及隐藏路径过滤约束。确认界面明确说明此边界；不能把 shell 判定成安全的只读命令。子任务使用同一策略、回调和记录，不能提升权限。

## 命令执行、输出与清理（2D-3 已实现）

process.ts 使用系统目录下的 Windows PowerShell，通过 spawn 的参数数组传入 UTF-16LE EncodedCommand；无 profile、无 stdin、非交互、隐藏窗口，每次均为新进程，不保留变量或 cd 状态。设置 UTF-8 控制台编码、文本输出及关闭进度输出；PowerShell 错误转为非零退出，外部程序最终 LASTEXITCODE 作为退出码。多个外部命令串联时需逐个检查退出码，后来的命令可能覆盖先前失败。

环境仅继承列出的 OS/运行时变量，例如 PATH、SystemRoot、TEMP、用户目录及 PNPM_HOME；不继承 DeepSeek Key、任意业务密钥或 NODE_OPTIONS。此措施不隔离当前账户可读取的磁盘凭据。命令输出与命令记录进入模型，JSON 事件不记录正文；终端授权会本地显示命令。

stdout/stderr 合计最多收集 16 KiB 原始字节，UTF-8 解码；不兼容编码可能替换字符。超过上限标记 truncated 并请求终止；结果不把截断输出冒充完整验证。预算不含 JSON、元数据及转码开销。默认 30 秒超时，工具参数最多 120 秒。

超时、取消或输出超限调用系统 taskkill /PID /T /F，仅针对本次启动的进程树；清理额外最多等待 5 秒。已观察到父进程退出后不再按旧 PID 执行清理，避免明显的 PID 复用风险；退出与系统调用间仍无 Job Object 级保证。未确认终止时记录 termination_failed / unconfirmed，并禁止同一 Tools 再启动命令。正常父进程退出只记 foreground-exited，不声称所有脱离的后代已结束。后台服务、脱离进程及交互式命令不受支持，不将其写成可靠恢复或隔离。

依据：[Microsoft taskkill 文档](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill) 的 /PID、/T 和 /F 行为；实际本机测试验证了被启动子进程的 PID 在超时清理后不存在。

## 命令结果与事实（2D-3 已实现）

结果含 recordId、success、status、exitCode、stdout、stderr、truncated、durationMs、cleanup。状态为 completed / timed_out / output_limit / cancelled / spawn_failed / termination_failed；仅 completed 且 exitCode=0 且未截断时 success=true。ToolResult.ok 表示执行接口返回了结果，不等于测试通过；权限、参数等前置错误仍走 ok=false。取消在保存结果后继续抛 CANCELLED，Loop 仍报告记录。

createShellTool 保存命令记录，getCommands() 返回深复制。每个工具实例最多 20 次启动尝试，满后拒绝新增，不静默淘汰；记录保留命令、cwd、退出事实，以及每个输出流最多 1000 Unicode 码点的摘要，outputSummaryTruncated 明确说明省略。Loop 在后续每次请求补入临时数据消息，与成功历史分离；失败、/reset 和子任务失败不清除命令事实。shell_record 事件仅发 cwd、ID、状态、退出码、耗时及截断/清理标志，不含 command/stdout/stderr。父子事件可重复报告同一记录 ID。

2D-5 的执行报告从现有事件汇总本回合命令结果，并标记命令之后观察到的 write 尝试；不会增加授权或重新执行工具。后续 shell 或外部进程修改文件不会触发该标记。

输出摘要、退出码与文件版本尚无强绑定，也不能保证模型最终叙述逐条符合工具证据；当前成功证明依赖明确工具结果与外部验收脚本，不是完整 Task 关卡。记录仅在进程内，命令副作用不自动回滚，没有崩溃恢复或全量持久日志。

## 后续安排（未实现）

read、write 与前台 shell 均已实现，委派默认可用已在 2D-4 完成。后续先处理 review 与实际任务暴露的问题，再完善上下文容量和验证证据组织；不提前建设后台调度或持久执行框架。

维持少量通用工具入口及清晰内部职责。正则/索引搜索、流式大文件、持久状态、完整权限策略与插件体系均未实现，不为这些方向预建空接口。
