# Tools：通用 read、受控 write 与工作目录边界

## 当前状态

阶段 2B 的只读工具基线、阶段 2C 的最小委派已通过用户 review。阶段 2D-1 将 list_directory 和 read_file 合并为 read，增加目录分页和按行读取；该增量已通过 review。阶段 2D-2 新增受控 write、最小权限及独立写入记录，已验证、待 review；本轮实现与验证事实见 [PROGRESS.md](../PROGRESS.md)。没有新增依赖，沿用 Node、pnpm、SDK、Loop 和 Session。

## 模块与接口

| 模块 | 已实现职责 |
| --- | --- |
| `src/tools.ts` | createTools(workspace?, permission = "read-only") 创建实际工具集合；统一 JSON 解析、名称查找、异步执行、取消和安全错误转换 |
| `src/tools/types.ts` | 工具定义、执行类型与 JSON 可序列化 ToolResult |
| `src/tools/sum.ts` | 纯计算示例工具的 Schema、校验与有限数求和 |
| `src/tools/workspace.ts` | createWorkspace(workspace) 固定工作目录；resolvePath(path, signal?) 检查边界，返回内部绝对路径、规范化相对路径及文件状态；resolveNewFile 验证已有父目录并拒绝覆盖 |
| `src/tools/read.ts` | createReadTool(workspace) 提供 read 定义、参数校验、目录与文本读取、分页及输出限制 |
| `src/tools/text-file.ts` | read 与 write 共享有界 UTF-8 读取、文件身份核对、扩展名与编码限制 |
| `src/tools/write.ts` | createWriteTool 实现创建、精确替换、暂存与发布；持有写权限和进程内记录 |
| `src/cli.ts` | 解析 --workspace 和 --permission，在请求模型前初始化工具；不承担具体文件规则 |

Tools 包含 definitions 和 execute(name, argumentsJson, signal?, callId?)。可选 forTurn(onEvent?) 由委派包装器使用，隔离每回合次数与事件；基础 collectTools 保留内部命名 execute 函数。可选 getWrites() 返回深复制的 WriteRecord[]，由工作目录工具持有，Loop 只消费事实并记录事件。模型客户端和 Loop/Session 使用同一工具集合，结果按 tool_call_id 关联。

没有工作目录时仍只提供 sum；显式 --workspace 增加 read 和 write。默认 read-only，write 在实际执行入口返回 PERMISSION_DENIED；--permission workspace-write 授权本次运行写入。没有 workspace 时不能授予写权限。子任务自动复用相同工具、权限和写入记录；委派本身当前仍需 --subagent。默认导出的 toolDefinitions / executeTool 继续只操作 sum。

旧模型工具名称 list_directory 和 read_file 已移除，调用返回 UNKNOWN_TOOL。项目尚无持久历史，不增加旧名称兼容层。内部 createWorkspaceTools 已替换为职责分离的 createWorkspace 与 createReadTool。

## read 协议

输入：`{ path: string, offset?: number, limit?: number }`，拒绝额外字段及错误类型。

- path：非空相对路径，最多 1024 字符；`.` 为根目录，支持 `/` 和 Windows 反斜杠。
- offset：从 0 开始，默认 0，必须为非负安全整数；文件表示跳过的行数，目录表示跳过的已过滤、排序条目数。
- limit：默认 100，范围 1–200 的整数；最多返回的行数或条目数，字节预算可能使实际数量更少。
- 文件和目录由实际路径类型决定，无需 mode/action 参数。目录名称即使带 .txt 也返回目录页。

成功 result：

| 类型 | 字段 |
| --- | --- |
| 文件 | kind: file、path、offset、totalLines、startLine、endLine、content、truncated、nextOffset |
| 目录 | kind: directory、path、offset、totalEntries、entries: [{ name, type }]、truncated、nextOffset |

startLine / endLine 从 1 开始；空页二者为 null。totalLines 不把末尾换行计为额外空行；空文件为 0 行。content 保留 CRLF、LF、CR 原始换行；UTF-8 BOM 被移除。

truncated=true 表示还有未返回内容，nextOffset 指向下一行或条目；继续使用相同 path 和 nextOffset。完成时 truncated=false、nextOffset=null。offset 等于或超过末尾时返回空页，不报错或重复末页。

示例：`read({"path":"src/main.ts","offset":20,"limit":40})` 从第 21 行开始，最多读取 40 行。返回 nextOffset 时以它为准，不自行假设已返回 limit 行。

## 输入、扫描与输出限制

- 文本文件最多 1 MiB（1048576 字节）；先检查已打开文件大小，再使用上限加 1 字节的缓冲检测读取期间增长。超限为 FILE_TOO_LARGE。
- 每页文件 content 的 UTF-8 字节预算为 16 KiB，始终保留整行。遇到下一行无法放入当前页时返回继续位置；如果单行本身超限，读取该行返回 OUTPUT_LIMIT，不提供残缺的成功结果。预算不包括结果元数据和 JSON 转义开销，不是 token 上限。
- 目录非递归扫描，最多接受 1000 个原始条目，包括随后被过滤的条目。超限返回 DIRECTORY_TOO_LARGE，不把不可继续的子集伪装成完整分页；已知子路径仍可以直接读取。
- 目录先完成过滤，再按名称的 UTF-16 码元顺序排序，与系统语言无关。每页还按条目的 JSON UTF-8 大小加分隔符计入 16 KiB 预算；外围数组和元数据不计入该预算。
- 保留原有文本扩展名集合：.txt、.md、.json、.ts、.tsx、.js、.jsx、.mjs、.cjs、.yaml、.yml、.toml、.csv、.html、.css、.xml、.sql、.py，不区分大小写。
- 严格 UTF-8 解码，拒绝非法编码和二进制控制字符。文件句柄在 finally 中关闭；目录迭代在结束、错误和取消时关闭。

每一页都是重新读取，不是快照；期间文件或目录变化可能使 offset 对应内容发生变化。当前没有版本令牌或一致性快照。每页都对整个有界文件做解码，尚未实现流式大文件读取、递归查找或内容搜索。

## 工作目录与访问边界

- 工作目录显式授权并在初始化时 realpath 解析为固定根目录。
- 拒绝父目录跳转、绝对路径、Windows 盘符/UNC/设备路径、NTFS 数据流及不支持的名称。
- 拒绝点开头路径段（包括 .env、.git）与 node_modules；“隐藏”是名称规则，不代表 Windows 隐藏属性。
- 逐级 lstat 拒绝符号链接、junction、特殊文件和文件硬链接；realpath 后再次检查目录包含关系和名称。目录条目复用相同路径检查。
- 打开文件后核对类型、硬链接计数、dev/ino。结果只暴露相对路径；不回传绝对根目录或原始文件系统错误。

这些检查不是操作系统沙箱，不能保证抵御恶意本机进程并发替换路径或内容。用户选择的文本会经工具结果发送给 DeepSeek；名称和扩展名过滤不等于内容脱敏。read 不写入；write 仅在授权后修改支持的文本，不执行文件。

## 错误、取消与历史

结果保持 `{ ok: true, result }` 或 `{ ok: false, error: { code, message } }`。新增 DIRECTORY_TOO_LARGE、OUTPUT_LIMIT；继续使用 INVALID_ARGUMENTS、PATH_NOT_ALLOWED、NOT_FOUND、UNSUPPORTED_FILE、FILE_TOO_LARGE、TOOL_IO、UNKNOWN_TOOL。sum 行为不变。

工具错误供模型纠正或说明，取消抛出 CANCELLED 终止回合。路径检查、目录迭代、文件读取循环及返回结果前检查 signal；不承诺立即中断底层文件系统调用。成功回合保留已读取页，失败回合仍采用现有 Session 临时历史丢弃规则。读取日志不输出内容或路径参数；write_record 记录规范化相对路径、摘要及结果状态，不记录正文。

## write 协议与权限（已实现）

输入严格二选一，不接受额外字段：

- `{ path, content }`：仅新建文件，路径已存在时 WRITE_CONFLICT；父目录必须存在。
- `{ path, oldText, newText }`：已有文件中替换唯一精确片段。oldText 非空，newText 必须不同；可用空 newText 删除该片段。不存在、多次匹配或重叠匹配均拒绝，不自动重试或覆盖整份文件。

模型工具描述要求先读后改。保留片段外的文本、原换行与 UTF-8 BOM；最终编码仍需满足 1 MiB 上限，拒绝未配对 Unicode 代理项和二进制控制字符。沿用 read 的路径与扩展名约束。最小权限是固定在 Tools 实例上的 read-only / workspace-write，不是逐次交互审批或完整权限框架；模型不能通过参数提升权限。

成功结果为 `{ recordId, path, operation, beforeHash, afterHash, bytes }`。path 只含规范化相对路径；beforeHash / afterHash 是原始文件字节的 SHA-256，新建的 beforeHash 为 null。结果不包含正文，不承诺文件随后未被其他进程修改。

## 写入提交与失败边界（已实现）

1. 校验权限、参数、路径与文本。编辑时读取有界原始字节，确认 oldText 仅出现一次并生成新内容。
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

## 后续安排（未实现）

read 与 write 已实现；后续加入 shell 的权限、输出边界及进程生命周期，并将命令结果纳入独立执行事实。shell 建议默认 PowerShell，不强制 Bash。进程权限不能只靠文件路径校验实现。

维持少量通用工具入口及清晰内部职责。搜索、流式大文件、持久状态、权限交互及完整插件体系均未实现，不为这些方向预建空接口。
