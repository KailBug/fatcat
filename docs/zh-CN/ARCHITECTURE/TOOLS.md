

<a id="tools-general-protocol-and-file-execution-facts"></a>

# Tools：通用协议与文件执行事实

[English](../../en/ARCHITECTURE/TOOLS.md) | 简体中文

[架构总览](README.md) · [编码操作](../GUIDES/CODING.md)

Tools 提供模型可见定义、参数校验和异步执行。工具不自行读取终端输入；授权和共享执行防护归 [Permissions](PERMISSIONS.md)，各入口只提供审批回调。

工具定义使用 Fatcat 自有 `ToolDefinition`，直接持有 name、description、parameters 和可选 strict；工具装配及包装器不构造 OpenAI 的 function 外层。模型 API 编码器负责加上协议字段，现有定义内容与执行契约保持不变。工具调用的原始 arguments JSON 仍在 Tools.execute 中解析，校验失败按原调用 ID 返回，见 [模型边界](PROVIDERS.md#internal-messages-and-api-boundaries)。

<a id="assembly-and-specialized-responsibilities"></a>

## 装配与专用责任

| 源码 | 职责 |
| --- | --- |
| `packages/runtime/src/tools.ts`、`packages/runtime/src/tools/types.ts` | 集合装配、统一结果、取消及 forTurn 包装 |
| `packages/runtime/src/tools/read.ts` | 已知文件/目录分页 |
| `packages/runtime/src/tools/glob.ts`、`grep.ts`、`discovery.ts`、`search.ts`、`search-worker.ts` | 路径发现、文本搜索、有界遍历及隔离的正则执行 |
| `packages/runtime/src/tools/write.ts` | 精确文本创建/替换、提交协议与写入 journal |
| `packages/runtime/src/tools/shell.ts` | 命令协议、授权、cwd 复查与命令 journal |
| `packages/runtime/src/tools/shell/powershell.ts` | Windows PowerShell 环境、进程执行与清理 |
| `packages/runtime/src/tools/shell/bash.ts` | Linux Bash 环境、进程组执行与清理 |
| `packages/runtime/src/tools/shell/types.ts` | 共享 ProcessResult 协议与合并输出上限 |
| `packages/runtime/src/tools/shell-output.ts` | 有界不可变命令日志、预览及 output_read |
| `packages/runtime/src/tools/web.ts`、`browser.ts` | [HTTP 研究](WEB.md)与[本地浏览器](BROWSER.md)入口 |

程序化 createTools 省略目录时没有本地工具；传入目录增加 read/glob/grep/write/edit/shell/output_read，默认文件只读、shell deny。sum 已移除；集合为空时模型请求不发送 tools 外层。日常入口显式选择目录与权限，并装配 web/browser。Skills、附件、Memory 在通用 read/write 外包装，协议归各自专题，不在此复制。

结果使用 `{ok:true,result}` 或 `{ok:false,error:{code,message}}`。可恢复工具错误交给模型，取消抛 CANCELLED 停止回合；失败回合的消息由 Session 另存 attempt。文件/命令副作用不会因后续请求超限而回滚。

<a id="read-and-query"></a>

<a id="read-glob-and-grep"></a>

## read、glob 与 grep

read 对已知工作区路径接受 path、offset、limit，工作区 query 改由 grep 处理。附件、Memory 和 Skill 虚拟资源包装器仍保留各自文档中的 read query 协议。offset 从零开始，默认 limit=100、上限 200；展示行号从 1 开始。文件返回有界完整行，目录返回过滤排序后的条目；nextOffset 表示继续位置。分页重新读当前内容，没有工作区快照或版本令牌。

glob 接受 pattern 及可选目录 path，不打开文件内容，返回排序后的路径。grep 接受 query 及可选文件/目录 path，默认区分大小写的字面匹配。regex=true 在独立 worker 中启用 JavaScript Unicode 正则，每文件限时三秒；可选 ignoreCase 和前后 0–5 行 context，取消会终止 worker。结果按路径 UTF-16 码元再按行号排序，一行匹配多次只返回一次。offset 在 glob 中计路径，在 grep 中计匹配行；默认返回 100 项，最多 200 项。

模式采用 Node glob 语法，使用 `/` 分隔并相对于搜索目录；不含 `/` 的模式匹配文件名。grep 的可选路径过滤字段为 glob。两者都支持 exclude，默认 **/.git/** 和 **/node_modules/**；显式空数组移除这些过滤，但不扩大权限。两者都不解析 .gitignore。

| 边界 | 当前限制 |
| --- | --- |
| 工作区文本 | 单文件 1 MiB，严格 UTF-8；拒绝不支持的控制字符 |
| 文件页 | 正文 16 KiB，保留整行；单行超限明确失败 |
| 目录扫描 | 最多 1000 原始条目；条目页按 JSON 字节有界 |
| 搜索输入 | query 最多 512 UTF-16 码元 |
| glob/grep 发现 | 10000 原始条目、2048 匹配文件、32 层子目录 |
| 发现/搜索输出 | paths/matches JSON 最多 16 KiB，完整行不截断 |

遍历超限失败并要求缩小范围；递归搜索可跳过超大/编码不支持的候选，返回 skippedFiles 与 complete=false。complete=true 只表示本次发现的候选没有这类跳过，不保证整个磁盘覆盖或扫描期间不变。每页重新遍历，不解析 .gitignore，也没有索引缓存。

普通模式的名称、扩展名与链接规则由 Workspace/text-file 落实；CSV 和 TSV 的读取、搜索、写入均使用相同的有界 UTF-8 文本访问。Free to go 使用扩大的本地访问范围，仍保留编码、大小及身份检查。准确扩展名集合以 `packages/runtime/src/permissions/text-file.ts` 为准。读取内容进入模型及明文历史，不等于脱敏。

<a id="write-publication-protocol"></a>

## write 的提交协议

普通文件写入分为两个工具，共用提交协议：

- `write({path,content})`：创建新文件，父目录须存在，已有目标不能覆盖。
- `edit({path,edits:[{oldText,newText},...]})`：对原文件应用 1–32 处替换。每个 oldText 非空、恰好匹配一次且不同于 newText；区域不能重叠，不能依赖前一替换的输出。old/new 文本合计最多 2 MiB。

全部替换先校验，再一次审批、一次暂存发布、生成一条 journal。多处编辑审批展示完整前后文本；任何匹配冲突都拒绝整次编辑。

保留片段外字节语义、换行与 BOM；最终 UTF-8 文件仍受 1 MiB 限制。批准后重读文件身份和原始内容，冲突时拒绝而不自动重试。

进入暂存后创建 started 记录，在同目录独占写临时文件并 sync；发布前再次检查目录、目标和取消。创建通过硬链接安装完整临时文件，编辑通过 rename 替换。发布前标 uncertain，确认发布后立即标 committed。清理失败可以返回错误但保留 committed，不能解释成回滚；发布异常需核查当前文件后决定是否重试。

该协议避免原地写半个文件，不是多文件事务或 OS 比较交换。复查到发布之间仍有竞态；NTFS ACL、备用数据流等元数据不保证完整保留。没有文件删除、递归建目录或自动恢复；崩溃可能留下临时文件。创建依赖文件系统硬链接支持。

<a id="shell-execution-boundaries"></a>

## shell 的执行边界

`tools/shell.ts` 协调权限快照、审批、cwd 校验、命令记录及清理失败后的禁用。`tools/shell/` 中的平台执行器只接收命令、cwd、超时与取消信号，负责进程生命周期并返回 `ProcessResult`，不读取权限策略或请求审批。策略、审批协调与命令风险分类仍归 `permissions/`。

输入为 command、可选 cwd 与 timeoutMs。命令最多 4000 UTF-16 码元；默认 30 秒，允许 100–120000 毫秒。审批显示完整命令、规范目录和期限，批准后复核 cwd。文件写入授权不等于命令授权。

每次启动新的无 profile、无交互 stdin、隐藏 Windows PowerShell，使用参数数组与 EncodedCommand，工作目录不跨调用保存。只继承列出的运行环境变量，不继承模型 Key 或 NODE_OPTIONS；PATH/PSModulePath 仍属受信任宿主环境，不能隔离账户可读取的磁盘凭据。

新增 Linux 评估路径使用 `/bin/bash --noprofile --norc -c` 和独立进程组，无 stdin，不保存跨调用 shell 状态。`tools/shell/bash.ts` 保持相同 ProcessResult 协议及明确的 Linux 环境变量白名单，不继承 BASH_ENV、ENV、SHELLOPTS、加载器 hooks 或供应商凭据。工具描述与系统指导根据实际平台选择；shell 仍不支持其他平台。Linux 不使用 PowerShell 风险分类器：Free to go 下每条 Bash 命令都需审批；无界面任务必须明确选择 workspace-write/shell-allow 策略或禁止 shell。

stdout/stderr 捕获合计最多 1 MiB 原始字节，与模型预览上限独立；超限、超时和取消触发有界进程树清理。父进程退出后不再对旧 PID 执行清理；脱离后代未必结束。清理未确认时记录 unconfirmed，并阻止同一 Tools 再启动命令。没有 Job Object 级保证、后台服务或交互命令支持。

Linux 参考已检查的 pi 执行器，立即向所拥有的进程组发送 SIGKILL，最多等待五秒让流与进程收尾。这明确替代原计划的 TERM/宽限期升级：组长退出后的延迟信号可能命中复用标识，或遗漏忽略 TERM 的子进程。已终止的僵尸进程仍可能等待 init 回收；脱离进程组的后代需要容器销毁处理，`tree-killed` 确认组终止与收尾，不代表隔离。两个原生执行器都会在启动前拒绝已取消的调用。

PowerShell 错误与外部程序退出码反映到结果；串联多个 native 命令应逐个检查 LASTEXITCODE。工具 ok 不等于命令成功，截断输出不能作为完整验证。cwd 只是启动位置，shell 不是 OS 沙箱。

<a id="output_read-and-captured-output"></a>

## output_read 与捕获输出

每次 shell 返回 outputId（命令记录 ID）、预览 stdout/stderr、outputTruncated 及原始 status/exitCode/cleanup/truncated。每个流的预览最多 8000 个 JSON 转义后内容字节。outputTruncated 只代表预览缩短；truncated 表示捕获超限。success 要求 completed、退出码零、捕获未截断且清理已确认。

output_read 只接受 outputId，不接受文件路径。action=read（默认）按 Unicode 码点 offset 分页读取 stdout（默认）或 stderr，limit 默认 4000、最大 12000；tail=true 读取尾部且不能指定 offset。action=search 使用最多 512 UTF-16 码元的区分大小写字面 query，offset 计匹配行，limit 默认 100、最大 200。读取内容及搜索匹配 JSON 分别有 12000 字节页上限。长匹配行返回预览、textTruncated 及用于展开的 characterOffset。按相同选项使用 nextOffset 继续；captureTruncated 描述原捕获，与页 truncated 分开。

日志是工作区 Tools 实例拥有的不可变内存捕获，最多 20 条命令，每条最多捕获 1 MiB 原始字节。父子共享，包括失败命令输出；权限降级后拒绝读取 unrestricted 启动产生的日志。无关新 Tools 实例及重启进程无法解析旧 ID。会话历史仅持久保存实际返回的预览/页面，不保存整个捕获。没有新增持久日志目录或清理任务。

<a id="journals-and-verification"></a>

## journal 与验证

每个 Tools 实例保留最多 100 条进入暂存的写入记录和 20 次命令启动；父子共用，同目录缓存保留，返回防御性副本。参数/权限早期拒绝不伪装成已执行。写入记录含状态、路径、哈希及大小；命令记录含退出/清理事实和有界摘要。临时请求指导与事件可使用这些事实，不把 journal 复制为成功历史。

[执行报告](EXECUTION_REPORT.md)按 ID 去重并汇总；失败、新建会话不清空事实，重启不恢复 journal。当前没有把测试结果与所有相关文件版本强绑定。

关键检查为分页覆盖、大小/编码拒绝、查询完整性、批准后冲突、发布/清理失败、取消、子任务共享、真实 PowerShell 非零退出和后代清理。固定模型读改读或编码样例不代表普遍正确性。后续 Task 验收、文件快照和可靠进程隔离须分别设计，不通过新增大量专用模型工具代替。
