# Tools：工具集合与只读工作目录

## 当前状态

阶段 2B 已实现，通过离线测试和真实 DeepSeek 工作目录读取验证，待用户 review。进度事实见 [PROGRESS.md](../PROGRESS.md)。沿用现有运行时、SDK、Loop 和 Session，没有新增依赖。

## 模块与接口

| 模块 | 已实现职责 |
| --- | --- |
| `src/tools.ts` | `createTools(workspace?): Promise<Tools>` 创建实际启用的集合；统一 JSON 参数解析、按名称查找、异步执行、取消和安全错误转换 |
| `src/tools/types.ts` | 内置工具定义与执行类型，以及 JSON 可序列化的 ToolResult |
| `src/tools/sum.ts` | 原 sum 的 Schema、校验与有限数求和 |
| `src/tools/workspace.ts` | 将显式目录解析为固定根目录，提供 list_directory 和 read_file 的校验与执行 |
| `src/cli.ts` | 解析 --workspace，只允许与单次任务或 --chat 组合；在请求模型前初始化工具集合 |

Tools 包含 `definitions` 和 `execute(name, argumentsJson, signal?): Promise<ToolResult>`。模型客户端使用同一实例的定义，Loop 顺序等待执行并关联 tool_call_id。Session 创建时固定 tools，后续回合及 /reset 保留该集合。

不指定工作目录时使用 `defaultTools`，仅含 sum。`toolDefinitions` 和异步 `executeTool` 是默认集合的入口；executeTool 已由同步函数变成 Promise 返回值。程序化调用者自定义 tools 时，应把同一实例传给 createDeepSeekModel 的第三个参数和 Loop/Session。

这是一组内置工具，没有插件发现、动态加载、权限审批框架或外部进程执行。

## 工具协议

三个工具都只接受指定字段，拒绝额外参数：

| 工具 | 输入 | 成功 result |
| --- | --- | --- |
| sum | `{ numbers: number[] }`，2 至 32 个有限数字 | 有限 JavaScript number，浮点语义不变 |
| list_directory | `{ path: string }`，根目录为 `.` | `{ path, entries: [{ name, type }], truncated }`；type 为 file 或 directory |
| read_file | `{ path: string }` | `{ path, content }`；完整 UTF-8 文本 |

路径最多 1024 字符，支持 `/` 和 Windows 反斜杠。结果只返回规范化的相对路径，不暴露绝对根目录。

list_directory 非递归，只展示可识别的文本文件和目录，返回最多 100 条，并最多检查 1000 个原始目录条目。任一上限导致提前结束时 truncated=true；返回的子集按名称排序，不提供全目录排序保证或分页。隐藏、依赖目录、链接及不支持扩展名的文件被省略。

read_file 最多接受 65536 字节；先检查文件大小，再以 65537 字节有界缓冲读取，防止读取期间文件增长导致无界结果。超限返回 FILE_TOO_LARGE，不回传截断内容。使用严格 UTF-8 解码，接受 BOM 并去除，保留原有换行；拒绝非法编码及二进制控制字节。文件句柄在 finally 中关闭。

支持的文本扩展名（不区分大小写）：`.txt`、`.md`、`.json`、`.ts`、`.tsx`、`.js`、`.jsx`、`.mjs`、`.cjs`、`.yaml`、`.yml`、`.toml`、`.csv`、`.html`、`.css`、`.xml`、`.sql`、`.py`。

## 文件边界

- 工作目录必须显式指定且存在；创建时 realpath 解析为固定根目录。
- 工具仅接受相对路径，拒绝父目录跳转、绝对路径、Windows 盘符/UNC/设备路径、NTFS 数据流写法、尾部点或空格等不支持的名称。
- 点开头的路径段（包括 .env、.git）和 node_modules 不可访问；这里的“隐藏”指名称规则，不是 Windows 隐藏属性。
- 逐级 lstat 拒绝符号链接、junction、特殊文件和文件硬链接；realpath 后再次检查目录包含关系和名称。
- 打开文件后核对文件类型、硬链接计数和 dev/ino，拒绝检查期间被替换的不同文件。

这些检查限制只读工具的范围，不是隔离恶意本机进程的操作系统沙箱；无法保证抵御所有并发路径替换或读取期间的文件修改。默认不扫描任意本地目录。用户显式选中的文本经工具结果进入历史，并随下一次请求发送给 DeepSeek；名称和扩展名限制不等同于内容脱敏。

文件中的指令按数据处理，不改变 harness 工具权限；当前没有写入、shell 或网络工具。日志不包含文件正文和路径参数。

## 错误、取消与历史

成功为 `{ ok: true, result }`；失败为 `{ ok: false, error: { code, message } }`。常见错误码：UNKNOWN_TOOL、INVALID_ARGUMENTS、PATH_NOT_ALLOWED、NOT_FOUND、UNSUPPORTED_FILE、FILE_TOO_LARGE、TOOL_IO，sum 溢出仍为 TOOL_EXECUTION_FAILED。原始文件系统错误、绝对路径或堆栈不回传模型。

工具错误关联到原调用供模型纠正；取消则抛出 CANCELLED 结束整个回合。文件操作之间及结果返回后检查 signal，Loop 也在等待结束后再次检查，取消后不加入迟到结果或执行后续工具。底层文件系统调用本身不保证立即被中断。

成功回合保留完整文件工具结果；回合失败时按 Session 既有规则丢弃本轮历史。读取结果已经发送给模型后，清空历史不会撤销请求或费用。

## 实施与验收状态

1. 工具集合及异步执行已实现，默认 sum 与原有 Loop/Session 回归通过。
2. 工作目录工具和 CLI 已实现；离线验证 Windows 路径、junction/硬链接、隐藏名称、编码、大小、返回条数、取消、错误纠正及会话工作目录隔离。
3. 真实模型仅使用 `examples/workspace/project-notes.txt` 虚构样例，验证列目录、读取和回答；pnpm 的单次任务入口也已验证。等待用户 review。

实现依据：Node 24 [文件系统 API](https://nodejs.org/docs/latest-v24.x/api/fs.html)，结合本机 Windows 测试确认实际行为。

## 后续方向（未实现）

分页、搜索、按行读取、大文件处理、写入工具、命令执行、插件和权限交互均未实现，留待实际需要时决定。
