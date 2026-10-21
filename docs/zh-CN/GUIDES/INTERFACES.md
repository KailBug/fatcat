

<a id="cli-chat-tui-and-web-ui"></a>

# CLI、chat、TUI 与 Web UI

[English](../../en/GUIDES/INTERFACES.md) | 简体中文

[文档首页](../README.md) · [命令参考](../REFERENCE/COMMANDS.md)

先按[快速开始](../QUICK_START.md)配置供应商。示例从仓库根目录运行。普通单次任务、chat 和 TUI 默认创建已保存会话；新建未命名 Web UI 聊天从草稿开始。持久化与续接见[会话与项目](SESSIONS.md)。

<a id="single-task-and-terminal-chat"></a>

## 单次任务与终端 chat

```powershell
pnpm start --prompt "Inspect this workspace and summarize its entry points."
pnpm start --chat --workspace examples/workspace
```

单次任务输出到 stdout；诊断、审批和执行事件使用 stderr。脚本若需避开 pnpm/构建输出，可先构建，再从仓库根目录执行 `node --env-file-if-exists=.env packages/cli/dist/cli.js --prompt "Your task"`。直接调用 Node 使用自己的工作目录，不恢复 `INIT_CWD`。

Chat 每行接受一个 prompt，忽略空行。本地斜杠命令必须独占一行；未知命令报告本地错误，不转成模型 prompt。`/help` 列出命令，`/exit` 结束对话。审批回答仅作用于待处理操作。重置或切换会话不撤销已完成写入和命令。

`/context` 检查历史大小，`/compact [focus]` 摘要旧回合。请求超出本地字节预算时也可能自动压缩，见[上下文管理](SESSIONS.md#context-management)。

<a id="interactive-tui"></a>

## 交互式 TUI

```powershell
pnpm start --tui --workspace examples/workspace
```

TUI 共用 chat 的会话命令与工具，并提供编辑器、活动展示、审批提示和配置/usage 面板。它要求终端，拒绝重定向输入/输出。Enter 发送，Alt+Enter 换行，Page Up/Page Down 滚动。`/status` 显示完整配置与指标定义。Escape 或 Ctrl+C 取消当前工作并保留对话；空闲时 Ctrl+C 退出；Ctrl+D 取消并退出。

仅报告供应商实际提供的 usage。缺失 token 或缓存字段为未知，不是零。进程累计可能包含委派和压缩请求，并非当前上下文大小。终端渲染、快捷键及实现限制见 [TUI 架构](../ARCHITECTURE/TUI.md)。

<a id="local-web-ui"></a>

## 本地 Web UI

```powershell
pnpm start --webui
pnpm start --webui --workspace examples/workspace --port 3211
```

服务默认绑定 `127.0.0.1:3210` 并打开默认浏览器。打开失败时复制终端完整链接，包括 `#token=...`。请将其视为私有链接：它授予对该服务会话和当前对话的访问。设置 `FATCAT_WEBUI_OPEN_BROWSER=0` 可关闭自动打开。服务终端中 Ctrl+C 停止服务并取消当前工作。

Enter 发送，Shift+Enter 换行，IME 组字期间不提交。**Stop** 取消当前回合并保持对话可用。消息上限 32768 UTF-8 字节。模型回答在非流式请求完成后出现，运行期间仍展示活动更新。

**Copy code** 复制代码块正文，不带围栏或语言标签；**Copy answer** 复制原始 Markdown 回答，不含活动和执行报告。只有剪贴板写入成功才显示 **Copied**；浏览器阻止复制时，可重试或选中文字手动复制。代码块支持键盘聚焦和横向滚动。阅读较早消息时，**Back to bottom** 回到最新内容并聚焦输入框，不改变草稿。

回答支持 CommonMark/GFM，包括嵌套列表与引用、表格、只读任务列表、引用式链接、标题锚点，以及围栏或缩进代码。窄屏表格在自身区域滚动。原始 HTML 显示为文字；图片显示为带标签链接，不自动加载。外部链接允许 HTTP、HTTPS 和邮件；相对文件链接不打开本地文件。不包含数学公式、Mermaid 和语法高亮。

**Search chats** 筛选已有聊天的名称、标题、项目名和目录。匹配不区分大小写，要求包含每个空格分隔词，不搜索消息正文。搜索保留草稿和当前聊天。匹配的项目组临时展开，清空后恢复原折叠状态。Escape 清空查询，ArrowDown 聚焦第一个可见结果。结果数量和空状态随输入更新，与轮询保持一致。

浏览器展示拟写内容和命令，提供 **Allow once** 与 **Deny**。空闲时可通过权限选择器切换模式；显式启动限制仍是上限。见[权限](../REFERENCE/COMMANDS.md#permission-modes)。

连接同一服务的所有标签页共享当前会话和权限模式。刷新重新连接服务状态，包括待处理审批。关闭标签页不会取消工作。**New chat** 保留前一个会话，草稿持久化遵循[会话规则](SESSIONS.md#web-ui-drafts)。点击侧栏猫标志或 **fatcat** 文字通过相同新聊天流程返回首页。断连、请求或回合运行期间不可用。

当前显示对话达到 100 个普通回合后，Web UI 要求新建聊天才能继续发送普通消息。恢复的回合也计数；压缩保留历史，不重置此 UI 上限。上下文/Memory 命令仍可用，后台任务有独立路径。

侧栏会话菜单（省略号、右键或 Shift+F10）可查看详情、重命名、修改工作区、移入项目、fork 或删除。删除需确认并移除已保存对话数据。其他进程修改目标后，应刷新详情重新审阅。工作或审批期间禁用管理。共享和删除效果见[项目与会话操作](SESSIONS.md)及[资料](MATERIALS.md)。

点击模型名，为当前会话选择可用模型和启用的思考等级，再点 **Apply**。紧凑圆角列表隐藏未配置模型和地区标签。支持 medium 的模型默认 medium；开关型模型用 on；固定等级模型禁用滑块。强制推理不提供 off。已有保存选择在 Apply 前不变；打开 off 会话的选择器会建议该模型启用时的默认值。运行期间禁用切换，保留未发送草稿，并随持久化会话保存选择；其他标签页的陈旧选择会被拒绝。连接和凭据必须预先在宿主配置。

上下文环使用运行时对当前有效请求输入的新估算（包含最新回答和工具结果）以及当前模型窗口容量，不含未发送草稿。点击后显示紧凑的 **Context used / capacity percentage** 行和进度条。累计 usage、缓存覆盖率和最近主请求报告的输入仍是独立运行时数据，不作为环的来源。压缩重新计算占用而不降低累计 usage；切换模型用新模型重新估算，同时保留旧观测的身份。

新空聊天显示 **Not started**，不显示占用百分比。系统指令和工具定义已计入准备请求的基线，这不是计费 usage，也不强制归零。对话开始后，近似计数显示 **≈**，提示中说明方法；计数/容量不可用显示 **Unknown**，工作期间显示 **Updating**。DeepSeek 使用粗略 ASCII/汉字估算，并对标点、emoji 和其他文字采取保守 Unicode 回退，不是精确 tokenizer。其他模型或多模态内容需要适用本地计数器，否则保持未知。打开面板只刷新本地预览，不请求模型、不执行工具、不压缩、不写会话。独立请求字节预算仍有效。估算限制、窗口剩余量与输入余量语义及缓存覆盖率见[上下文计量](../ARCHITECTURE/CONTEXT.md)。

对话内，空输入框在失焦且鼠标未悬停 1.2 秒后折叠为底部工具栏。发送箭头旋转淡出为睡猫；点击或键盘激活猫可展开并聚焦输入。非空草稿、任务、审批或欢迎页使输入保持展开。动画遵循系统减少动态效果设置。

输入框只有一条底部工具栏：左侧为附件、权限模式、工作区，右侧为模型名、上下文环、Send/Stop。窄屏权限和工作区控件变为带标签及提示的图标。悬停或聚焦环可查看 usage 详情。左下回形针打开 **Attachments**；右上眼睛打开 **Preview**。Fatcat 标志旁图标新建独立聊天，**Projects** 旁加号创建项目，项目名称/箭头折叠或展开其聊天。左下 **Settings** 打开居中弹窗，包含外观（System、Light、Dark）、当前会话信息及已有移入项目流程。X、Escape 或点击弹窗外关闭，焦点回到 Settings。主题和各项目折叠偏好存入当前 origin 的浏览器本地存储。重开相同浏览器 profile 与 Web UI 地址（含端口）后恢复；清除浏览器数据会重置。存储不可用时，折叠仍在当前页面生效。连接状态在侧栏右下显示绿色 **Local** 或红色 **Disconnected**。长代码行在代码块内滚动。宽窗口预览并排展示，小窗口覆盖页面；关闭后焦点回到入口。

没有账户系统或远程托管。凭据留在服务端。保存历史恢复对话文字、模型选择及可用的会话 usage 观测，不恢复旧审批或实时执行 journal。当前占用重新计算；响应未提供 usage 时累计不完整。交互与无障碍细节见 [Web UI 架构](../ARCHITECTURE/WEBUI.md)。

<a id="preview-an-html-or-svg-file"></a>

## 预览 HTML 或 SVG 文件

Web UI 中点击 **Preview**，输入工作区相对 `.html`、`.htm` 或 `.svg` 路径，再点 **Open**。当前回合报告也为已提交的 HTML/SVG 写入提供预览按钮。Shell 创建的文件或恢复历史需手动输入路径。

窄窗口中 Preview 为模态，关闭前背景控件不能接收键盘焦点或点击。从预览控件按 Escape 或关闭按钮返回入口。嵌入页面独立接收按键；先用 Tab 或 Shift+Tab 从内容回到预览控件，再按 Escape。宽窗口保持非模态并排布局。切换宽窄模式保留已加载预览和未发送草稿。

宽窗口可拖动分隔条，或聚焦后用 Left/Right 调整宽度。Shift 使用更大步长，Home/End 选择最小/最大宽度，Escape 取消正在进行的拖动，Enter 或双击恢复默认宽度。宽度按浏览器 origin（含端口）保存，关闭预览或刷新后仍保留。窄屏覆盖模式不覆盖该偏好。浏览器存储不可用时，当前页面仍可调整。

**Refresh** 重新读取保存的文件并重启预览；关闭会停止 frame，读取失败清除旧预览。这是用于内联内容的隔离单文件预览，不加载站点相对资源，也不运行开发服务器。Read-only/Plan 下可用，不请求模型、不改变权限、不修改历史。

需要本地资源、脚本交互、诊断或截图的页面，应让 Fatcat 使用[本地页面检查](CODING.md#local-page-checks)中的受控浏览器。该工具执行代码并遵循命令权限。
