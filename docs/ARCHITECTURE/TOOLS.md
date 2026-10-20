# Tools：通用协议与文件执行事实

[架构总览](README.md) · [编码操作](../GUIDES/CODING.md)

Tools 提供模型可见定义、参数校验和异步执行。工具不自行读取终端输入；授权和共享执行防护归 [Permissions](PERMISSIONS.md)，各入口只提供审批回调。

工具定义使用 Fatcat 自有 `ToolDefinition`，直接持有 name、description、parameters 和可选 strict；工具装配及包装器不构造 OpenAI 的 function 外层。模型 API 编码器负责加上协议字段，现有定义内容与执行契约保持不变。工具调用的原始 arguments JSON 仍在 Tools.execute 中解析，校验失败按原调用 ID 返回，见 [模型边界](PROVIDERS.md#内部消息与-api-边界)。

## 装配与专用责任

| 源码 | 职责 |
| --- | --- |
| `packages/runtime/src/tools.ts`、`packages/runtime/src/tools/types.ts` | 集合装配、统一结果、取消及 forTurn 包装 |
| `packages/runtime/src/tools/read.ts`、`search.ts` | 文件/目录分页与字面查询 |
| `packages/runtime/src/tools/write.ts` | 精确文本创建/替换、提交协议与写入 journal |
| `packages/runtime/src/tools/shell.ts` | 命令协议、授权与命令 journal；进程生命周期委托 permissions/process |
| `packages/runtime/src/tools/sum.ts` | 无副作用算术工具 |
| `packages/runtime/src/tools/web.ts`、`browser.ts` | [HTTP 研究](WEB.md)与[本地浏览器](BROWSER.md)入口 |

程序化 createTools 省略目录时基础集合只有 sum；传入目录增加 read/write/shell，默认文件只读、shell deny。日常入口显式选择目录与权限，并装配 web/browser。Skills、附件、Memory 在通用 read/write 外包装，协议归各自专题，不在此复制。

结果使用 `{ok:true,result}` 或 `{ok:false,error:{code,message}}`。可恢复工具错误交给模型，取消抛 CANCELLED 停止回合；失败回合的消息由 Session 另存 attempt。文件/命令副作用不会因后续请求超限而回滚。

## read 与 query

read 接受 path、offset、limit 及可选 query。offset 从零开始，默认 limit=100、上限 200；展示行号从 1 开始。文件返回有界完整行，目录返回过滤排序后的条目；nextOffset 表示继续位置。分页重新读当前内容，没有工作区快照或版本令牌。

query 是区分大小写的单行字面子串，不支持正则、glob 或跨行。结果按路径 UTF-16 码元再按行号排序，一行匹配多次只返回一次。offset 计匹配项，不是源文件行号。

| 边界 | 当前限制 |
| --- | --- |
| 工作区文本 | 单文件 1 MiB，严格 UTF-8；拒绝不支持的控制字符 |
| 文件页 | 正文 16 KiB，保留整行；单行超限明确失败 |
| 目录扫描 | 最多 1000 原始条目；条目页按 JSON 字节有界 |
| 搜索输入 | query 最多 512 UTF-16 码元 |
| 递归搜索 | 1000 原始条目、128 候选文件、12 层子目录 |
| 搜索输出 | matches JSON 最多 16 KiB，完整行不截断 |

遍历超限失败并要求缩小范围；递归搜索可跳过超大/编码不支持的候选，返回 skippedFiles 与 complete=false。complete=true 只表示本次发现的候选没有这类跳过，不保证整个磁盘覆盖或扫描期间不变。每页重新遍历，不解析 .gitignore，也没有索引缓存。

普通模式的名称、扩展名与链接规则由 Workspace/text-file 落实；Free to go 使用扩大的本地访问范围，仍保留编码、大小及身份检查。准确扩展名集合以 `packages/runtime/src/permissions/text-file.ts` 为准。读取内容进入模型及明文历史，不等于脱敏。

## write 的提交协议

普通文件写入严格二选一：

- `{path,content}`：创建新文件，父目录须存在，已有目标不能覆盖。
- `{path,oldText,newText}`：替换唯一精确片段；oldText 非空，零次、多次及重叠匹配都拒绝。

保留片段外字节语义、换行与 BOM；最终 UTF-8 文件仍受 1 MiB 限制。批准后重读文件身份和原始内容，冲突时拒绝而不自动重试。

进入暂存后创建 started 记录，在同目录独占写临时文件并 sync；发布前再次检查目录、目标和取消。创建通过硬链接安装完整临时文件，编辑通过 rename 替换。发布前标 uncertain，确认发布后立即标 committed。清理失败可以返回错误但保留 committed，不能解释成回滚；发布异常需核查当前文件后决定是否重试。

该协议避免原地写半个文件，不是多文件事务或 OS 比较交换。复查到发布之间仍有竞态；NTFS ACL、备用数据流等元数据不保证完整保留。没有文件删除、递归建目录或自动恢复；崩溃可能留下临时文件。创建依赖文件系统硬链接支持。

## shell 的执行边界

输入为 command、可选 cwd 与 timeoutMs。命令最多 4000 UTF-16 码元；默认 30 秒，允许 100–120000 毫秒。审批显示完整命令、规范目录和期限，批准后复核 cwd。文件写入授权不等于命令授权。

每次启动新的无 profile、无交互 stdin、隐藏 Windows PowerShell，使用参数数组与 EncodedCommand，工作目录不跨调用保存。只继承列出的运行环境变量，不继承模型 Key 或 NODE_OPTIONS；PATH/PSModulePath 仍属受信任宿主环境，不能隔离账户可读取的磁盘凭据。

stdout/stderr 合计最多 16 KiB 原始字节；超限、超时和取消触发有界进程树清理。父进程退出后不再对旧 PID 执行清理；脱离后代未必结束。清理未确认时记录 unconfirmed，并阻止同一 Tools 再启动命令。没有 Job Object 级保证、后台服务或交互命令支持。

PowerShell 错误与外部程序退出码反映到结果；串联多个 native 命令应逐个检查 LASTEXITCODE。工具 ok 不等于命令成功，截断输出不能作为完整验证。cwd 只是启动位置，shell 不是 OS 沙箱。

## journal 与验证

每个 Tools 实例保留最多 100 条进入暂存的写入记录和 20 次命令启动；父子共用，同目录缓存保留，返回防御性副本。参数/权限早期拒绝不伪装成已执行。写入记录含状态、路径、哈希及大小；命令记录含退出/清理事实和有界摘要。临时请求指导与事件可使用这些事实，不把 journal 复制为成功历史。

[执行报告](EXECUTION_REPORT.md)按 ID 去重并汇总；失败、新建会话不清空事实，重启不恢复 journal。当前没有把测试结果与所有相关文件版本强绑定。

关键检查为分页覆盖、大小/编码拒绝、查询完整性、批准后冲突、发布/清理失败、取消、子任务共享、真实 PowerShell 非零退出和后代清理。固定模型读改读或编码样例不代表普遍正确性。后续 Task 验收、文件快照和可靠进程隔离须分别设计，不通过新增大量专用模型工具代替。
