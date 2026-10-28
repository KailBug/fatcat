

<a id="coding-tasks-and-execution-evidence"></a>

# 编码任务与执行证据

[English](../../en/GUIDES/CODING.md) | 简体中文

[文档首页](../README.md) · [权限](../REFERENCE/COMMANDS.md#permission-modes)

在目标工作区启动单次任务、chat、TUI 或 Web UI。命令从 Fatcat 仓库根目录运行，并将下方路径替换为已有项目目录。有效的请求应说明预期修改及具体检查方法：

```powershell
pnpm start --chat --workspace "D:\work\my-app"
# 然后提问：找到问候语的实现，修改文案，并运行对应的定向测试。
```

Fatcat 可以检查文本、搜索、创建或编辑文件、执行命令、研究公开信息和委派聚焦任务。认定任务完成前，应审阅执行证据和最终 diff。

<a id="read-and-locate-code"></a>

## 读取与定位代码

可以要求入口概览、读取指定文件或按字面符号搜索。读取采用分页，大结果可能需要继续读取。文本读取接受不超过 1 MiB 的 UTF-8 文件，行范围和响应大小均有上限。搜索按字面、区分大小写、单行匹配，文件、目录和匹配数有界。部分结果或跳过文件不能证明目标不存在。

普通模式将文件工具限制在工作区内，排除隐藏路径、依赖目录和链接。Free to go 扩大本地访问范围，但保留文本与资源限制。读取内容可能发送给配置的模型。支持的文档格式应使用[附件](MATERIALS.md)，不要让文本工具解析二进制文件。

<a id="make-a-controlled-edit"></a>

## 受控修改

默认模式在每次写入前请求批准，提示展示路径及拟写内容/变更。文本工具可创建新文件而不覆盖现有文件，或替换必须恰好出现一次的精确片段。父目录必须存在，编辑仍遵守严格文本/大小检查。工具不提供通用目录创建或删除。

审批等待期间文件发生变化时，Fatcat 拒绝陈旧编辑，不会静默覆盖新内容。此时应让它重新读取并修订操作。后续模型失败不会回滚已提交写入；重试中断任务前先检查文件和 diff。

如需自动允许受控写入，同时继续审阅命令：

```powershell
pnpm start --chat --workspace "D:\work\my-app" --permission-mode acceptEdits
```

精确的读取、搜索与写入限制见[工具契约](../ARCHITECTURE/TOOLS.md)，访问规则由[权限架构](../ARCHITECTURE/PERMISSIONS.md)维护。

<a id="run-a-check"></a>

## 运行检查

要求执行定向测试或构建命令。Shell 使用全新的前台 Windows PowerShell 进程，不加载 profile，也不提供交互式 stdin。审批展示命令、工作目录和超时。批准文件写入不等于授权命令。

默认命令超时为 30 秒，上限 120 秒。合并输出上限为 16 KiB，达到上限会终止命令。工具调用成功本身不代表检查通过，应检查退出码、超时、取消和截断。包含多个原生程序的命令必须保留失败状态。

命令以 Windows 用户权限运行，不在 OS 沙箱内。进程清理只能尽力完成，脱离的进程可能存活。未确认停止会阻止该 Tools 实例继续启动 Shell；查看进程不会自动解除阻止。每个 Tools 实例保留有界命令/写入 journal，由父任务和委派任务共享。普通界面按工作区缓存实例，因此同一工作区新建聊天不会重置它。计数和生命周期见 [Tools](../ARCHITECTURE/TOOLS.md#journals-and-verification)。

<a id="delegate-focused-work"></a>

## 委派聚焦任务

委派默认可用，无需能力开关。适合时可要求独立、有边界的子任务，由模型决定是否委派。

子任务历史隔离，继承工具与权限边界，共享操作 journal，不能递归委派。当前默认允许两个子任务，每个最多三次模型请求，并受配置的迭代上限约束，按顺序执行。子任务最终回答是需要审阅的证据，不是成功证明。见[委派架构](../ARCHITECTURE/SUBAGENT.md)。

<a id="research-public-information"></a>

## 研究公开信息

可以请求当前来源、某个 URL，或指定地点和日期的天气。搜索和页面读取默认可用；`--web-permission deny` 可独立于文件权限关闭该工具。允许 Web 访问时，read-only/Plan 仍可研究。

搜索尽力返回结果，时效条件只是提示。页面读取处理有界的静态 HTML、文本、JSON 或 XML，不执行 JavaScript、不登录网站，也不解析远程 PDF。长页面可能需要再次读取，届时会重新获取来源。依赖回答前应检查来源日期和引用。

普通模式允许公共 HTTP(S)；Free to go 还允许私有地址和自定义端口。重定向、DNS、大小和超时检查仍然有效。禁止 Web 工具不会阻止独立授权的 Shell 命令联网。来源和网络限制见 [Web 架构](../ARCHITECTURE/WEB.md)。

<a id="local-page-checks"></a>

## 本地页面检查

可让 Fatcat 在受控浏览器中检查工作区 HTML/SVG 页面，执行有界交互，并报告控制台错误、几何信息或截图。要求 Windows 上已安装 Microsoft Edge；Fatcat 不自动下载浏览器。

每次调用打开隔离的浏览器上下文，支持工作区本地资源。不提供任意脚本执行、外部浏览或工作区外访问，即使在 Free to go 下也一样。Manual/Accept edits 请求命令审批；Plan、read-only 和 shell-deny 拒绝执行。截图和 JSON 记录是面向用户的证据，不会自动作为图片输入发送给模型。

证据保存在 `fatcat-browser-evidence/<id>.json`，截图保存为 `<id>.png`。Web UI 提供报告/截图按钮；CLI/TUI 用户可直接打开文件。文件留在磁盘，可能包含页面文字或输入值。`completed` 仅说明请求动作已完成，不代表页面无错误。源码变化后应重跑；一个视口截图不能验证整个动画。

无需执行工具的单文件快速查看，可用 [Web UI 预览](INTERFACES.md#preview-an-html-or-svg-file)。精确执行能力和证据格式见[浏览器架构](../ARCHITECTURE/BROWSER.md)。

<a id="review-results-and-recover-from-failures"></a>

## 审阅结果与失败恢复

将最终回答与 diff 和执行报告核对：

- 读取和搜索报告范围及省略，不能证明检查了整个仓库。
- 写入区分已提交、失败和不确定操作；失败回合仍可能改变文件。
- Shell 证据包含退出状态、取消、超时及有界输出；退出码 0 不证明更广泛的产品目标。
- 供应商 usage 区分已报告值与缺失数据；上下文大小、请求字节和累计 token 是不同指标。
- `taskVerification: not_assessed` 表示尚未评估任务正确性；最终回答不是验收证书。

取消、存储冲突或会话中断后，继续之前先检查当前文件和进程。Resume 恢复历史，不重放工具操作或旧审批。较早保存的会话不会恢复进程内执行报告。见[执行报告](../ARCHITECTURE/EXECUTION_REPORT.md)与[会话恢复](SESSIONS.md#storage-and-recovery)。
