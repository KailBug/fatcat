# Web UI：本地 HTTP、交互与预览

[架构总览](README.md) · [操作指南](../GUIDES/INTERFACES.md#local-web-ui)

Web UI 是本机单用户入口。浏览器持有草稿、菜单与显示快照；共享核心持有会话、回合、工具事实与权限。所有标签使用同一服务的活动会话，不分别运行 Agent。

## 模块职责

实现位于私有 workspace 包 `@fatcat/webui`，包根只导出 `runWebUi`。CLI 按原时机惰性加载入口，导入本身不监听端口、打开浏览器、注册信号处理或请求模型。包依赖 runtime 和 commands，不依赖 TUI 或根应用；Controller 和页面各自的状态所有权保持不变。

服务端、浏览器模块和显示类型都在 `src/` 下，独立构建为包内 `dist/`。HTML/CSS、图标及许可证、原生目录 helper 随包构建复制；侧栏共享 logo 仍以根 `images/logo/mini-logo.png` 为唯一源，构建时复制进包。首页 walking.png、助手头像 looking.png 和空闲输入框 sleeping.png 来自用户提供的原图，由 Web UI 的 src/public 持有并随包复制，通过明确的图片 URL 白名单提供。运行时按模块位置定位资源，不依赖仓库根目录或启动 cwd。浏览器继续使用原 HTTP URL 和原白名单，构建检查客户端产物不引入 Node 或其他服务端模块；类型导入不会进入浏览器执行代码。

原根 `webui/` 与 `scripts/copy-webui.ts` 已移除，不提供转发。测试仍在 `packages/verification/tests/webui/`，验证脚本仍在 `packages/verification/verify/`，需要内部模块时使用仅限验证的 `@fatcat/webui/internal/*`。包规则见[开发规范](../DEVELOPMENT.md#workspace-package-boundaries)。

| 源码 | 职责 |
| --- | --- |
| `packages/webui/src/index.ts`、`open-browser.ts` | 共享核心装配、服务退出与一次性系统浏览器打开 |
| `packages/webui/src/server.ts` | 原生 Node HTTP、认证/来源、静态白名单与路由 |
| `packages/webui/src/controller.ts` | 显示用 transcript、状态版本、提交/停止、审批和宿主互斥 |
| `packages/webui/src/types.ts` | 客户端与服务端共享的显示协议类型，不含运行逻辑 |
| `packages/webui/src/turns.ts` | 历史到显示回合的恢复、执行事件到活动文案的无状态转换 |
| `packages/webui/src/client/app.ts` | 页面装配、快照、请求/轮询、草稿与跨组件协调 |
| `packages/webui/src/client/transcript.ts`、`markdown.ts` | 回合 DOM、节点缓存、展开状态与安全文本呈现 |
| `packages/webui/src/client/session-list.ts` | 会话/项目分组、列表缓存、折叠状态、菜单入口与拖拽事件 |
| `packages/webui/src/client/composer-motion.ts` | 空闲输入框的展示定时、收缩/展开及唤醒焦点回调 |
| `packages/webui/src/client/settings.ts` | 设置展开/焦点、浏览器主题偏好与现有会话操作入口 |
| `packages/webui/src/client/session-menu.ts`、`session-dialog.ts` | 目标快照、菜单/弹窗、键盘与焦点 |
| `packages/webui/src/projects.ts`、`project-http.ts`、`project-management.ts` | 项目预览与确认入口，持久语义委托 Manager |
| `packages/webui/src/attachments.ts`、`attachment-http.ts`、`attachment-evidence.ts` | 上传、当前作用域与实际来源呈现 |
| `packages/webui/src/preview.ts`、`client/preview.ts` | 单文件快照与隔离预览 |
| `packages/webui/src/folder-picker.ts`、`native-folder-dialog.ps1` | 有界原生目录选择，不是模型工具 |
| `packages/webui/src/client/model-controls.ts` | 模型/思考临时表单、上下文圆环与详情展示，数据来自 runtime 快照 |
| `packages/webui/src/client/cron.ts`、`permission-menu.ts`、`browser-evidence.ts` | 对共享服务的调度、模式和证据操作 |

## 浏览器页面与视图边界

`app.ts` 持有唯一页面快照、ETag、连接状态与提交锁，并协调输入草稿、审批/详情、滚动跟随、预览重置及各菜单和弹窗。请求成功后的刷新和草稿清空时机不由视图决定；轮询继续过滤旧 revision，304 只更新连接状态，断连不丢弃草稿。

`TranscriptView` 接收回合、Session ID 与工作目录，只持有回合节点和序列化签名缓存。未变化的回合复用 DOM；变化时保留按 `data-kind` 区分的展开区域；删除的回合移除对应缓存。Markdown 与来源按钮捕获渲染时的 Session ID，不在点击时改用新选中的聊天。预览按钮与浏览器证据仍调用现有组件；滚动跟随条件和执行时机留在 `app.ts`。

`client/copy.ts` 为代码块和回答提供同一复制控件，只接收明确文本并调用浏览器 Clipboard API。代码复制不含语言标签/围栏，回答复制保留原始 Markdown，不混入 Activity、来源或执行报告；成功后才显示 Copied，失败显示重试/手动复制说明。复制不请求宿主、不改变历史、草稿或授权。代码工具栏独立于横向滚动区；代码区可键盘聚焦。`app.ts` 根据当前滚动距离、内容和视口尺寸更新 Back to bottom，用户主动返回底部后将焦点交回输入框；原有轮询跟随条件保持不变。

`markdown.ts` 使用直接声明的 `marked@18.0.11`（复用 pi-tui 已有版本）解析 CommonMark/GFM，按 Token 显式构建 DOM，移除原有手写语法解析器。支持标题、段落、软/硬换行、强调/删除线、嵌套及有序列表、只读任务列表、嵌套引用、表格、围栏/缩进代码、引用链接和自动链接；标题锚点限于当前回答并带独立 ID。保留来源按钮的 Session 身份与复制语义。原始 HTML 显示为文本，外链仅接受 http/https/mailto，图片显示为明确标注的链接，不自动加载远程资源；相对文件链接不映射本机路径。未提供数学公式、Mermaid 或代码语法着色。构建从锁定依赖复制独立 ESM 和 MIT 许可证，并将编译后的裸导入改为本地模块路径；静态白名单逐项注册，不使用 CDN，也不放宽 CSP。版本/API 依据见 [Marked 选项](https://marked.js.org/using_advanced)和[Token 接口](https://marked.js.org/using_pro)。

搜索词由 `app.ts` 持有，只传给 `SessionListView` 过滤已有摘要：名称、标题、项目名和工作目录按 NFKC/小写归一化，多词全部匹配。筛选不请求历史正文、不切换会话、不改变草稿或持久数据；轮询保留筛选，无结果提供状态和清空入口。搜索中匹配项目临时展开且不写折叠偏好，清空恢复原状态；Escape 先清空，ArrowDown 聚焦首个可见会话。

`client/preview-resize.ts` 仅持有分隔条 DOM、拖动临时数据及当前 origin 的 `fatcat-preview-width` 展示偏好。桌面拖动使用 Pointer Events/capture；左右键调整，Shift 加大步长，Home/End 到边界，Enter/双击恢复默认，Escape/取消捕获回滚拖动。宽度限制由既有侧栏、对话最小宽度和预览最小宽度共同决定；窗口变小时只夹紧实际布局，不覆盖保存值。窄屏覆盖模式隐藏分隔条，返回桌面恢复偏好，关闭/刷新仍可恢复宽度；存储不可用时保留本页功能。预览内容、读取取消和焦点恢复仍由 `FilePreview` 管理，不引入 React 分栏库。

`SessionListView` 接收列表所需快照，只持有列表签名、DOM、项目折叠状态和显示格式器。折叠状态按项目 ID 存入当前 origin 的 localStorage，刷新、关闭浏览器及服务重启后可恢复；每次点击只更新该项目的键，轮询重绘和改名不会展开已折叠的项目，观察到项目删除时清除对应状态。存储不可用时退回当前页面内记忆，新项目默认展开。这是浏览器展示偏好，不进入 Session 持久数据或授权。`displaySessions` 统一菜单、详情与列表对已保存当前会话的补入规则，不把未保存草稿加入持久列表。点击和菜单事件携带明确目标；拖拽开始/悬停通过回调读取实时可操作状态，放下时由入口按当前快照解析 Session 并打开项目确认。视图不请求 API、不保存另一份页面快照，也不负责业务校验或持久状态。按钮禁用在每次 controls 更新时应用，即使列表签名未变化也有效。

新增客户端运行时模块必须同步加入服务端静态白名单，并通过真实 HTTP 核对资源可加载；不开放目录映射。开发约束与验证归属见[开发说明](../DEVELOPMENT.md)。

## HTTP 与本地访问

固定监听 127.0.0.1；端口及打开器配置见[参考](../REFERENCE/COMMANDS.md)。每次启动生成 32 字节随机 capability，以 URL fragment 交给页面；页面移除 fragment，存于当前标签 sessionStorage，以 Bearer header 调 API。provider Key 不发给页面。

请求核对精确 Host，存在 Origin 时只接受实际本地 origin；API 必须有 capability，不开放 CORS。静态路径是明确白名单，不映射磁盘目录。聊天页 CSP 限制脚本/样式/连接到自身，预览使用独立路径/CSP；设置 no-store、nosniff、no-referrer 并禁止外部嵌入。

普通 JSON 最多 64 KiB、prompt 32768 UTF-8 字节；连接数 32，header/request 10 秒、idle 15 秒。原生目录选择响应临时延长至 310 秒。附件流使用独立有界通道，不放大普通消息限制。

state 支持 ETag/304，前台约 700ms、后台约三秒轮询，是状态更新而非模型 token 流。只有显式允许的字段/类型可进路由；运行或待批时不能重复提交/管理，旧 approval/revision 返回冲突。页面关闭不停止任务，Stop 或服务退出才取消。

capability 是本地访问凭证，不是多用户账户或 OS 隔离。持有链接的标签可以操作该服务；没有远程托管或外网监听配置。

## 宿主状态与资料入口

Controller 的 transcript 是显示状态，不替代 Session history。未命名新聊天可为草稿，保存触发条件归 [Session](SESSION.md#管理与跨模块关系)，不能只按是否出现聊天回复判断。恢复历史不恢复审批、实时日志、旧活动报告或过程用量。

`WebUiInfo`、`WebTurn`、`WebUiState` 从 `packages/webui/src/types.ts` 导入；审批类型直接引用权限模块，Controller 不为旧导入路径提供转导出。`turns.ts` 只接收历史或事件并返回展示数据，不持有 Controller、SessionManager 或可变宿主状态。历史恢复仍按每个成功文本回合提取真实附件读取来源，忽略未完成回合。

Controller 保留活动回合、管理操作、显示列表、revision、审批协调和关闭状态。`startTurn` 负责校验、显示限额、可见性及执行生命周期，私有 `executeTurn` 分派 Memory、Context、Automation 与普通请求；自动任务的 prompt 不经过手动本地命令识别。调用执行入口前先安装 active，执行结束仍先拒绝遗留审批、刷新列表，再释放 active 和运行 Session 标识。事件递归、父请求用量筛选、报告挂接、活动截断与 revision 更新也留在 Controller；文案格式化不改变这些时序。

管理入口通过 `restore` / `preserve` 明确成功后的 transcript 处理。新建、恢复、分叉及修改/删除当前 Session 按原语义恢复显示并清空用量；管理非当前目标或仅改名保留当前显示。项目迁入/改目录、删除以及目录选择成功后的局部用量重置、附件版本更新仍在对应入口执行，不套用统一刷新策略。失败路径分别尝试刷新 Session、Project 元数据，保留原始错误，不为重试覆盖 transcript 或重放操作；操作已提交的持久变化也不回滚。状态所有权与新增回归测试规则见[开发说明](../DEVELOPMENT.md)。

当前显示列表中非 contextOperation 回合达到 100 条后，拒绝新的手动普通提交；已恢复的成功回合也计入，后台自动任务不受此入口门槛约束。context/Memory 操作显示最多保留 20 条，每轮 activity 最多保留 100 条。它们是 UI 限制，不是 Session 历史保留期。

会话菜单作用于明确 ID/revision，非活动操作不随意切换当前历史。冲突刷新元数据供重新确认，不自动重放；项目管理、共享和删除语义归 [Projects](PROJECTS.md)，不能在前端复制。

上传初次与重试固定发起 Session/项目/代次，UI 切换不重投。取消后的接收占位等流清理才释放。资料来源从成功历史里的实际 read/delegate_task 证据生成，父子标明；失败回合及失败子任务目前不保留该来源面板。

来源 HTTP 只允许本地范围读取，拒绝 visual/transcribe/question，点击来源不触发模型请求。按当前范围重新授权固定原件/解析版本，不导航裸磁盘路径或执行附件 HTML；格式与覆盖见 [Documents](DOCUMENTS.md)。

模式切换、自动任务和 compact 均交给共享核心。背景任务显示目标身份而不切换前台；自动摘要留在原回合 activity。Web 不再维护独立用量观察器；消费、普通主请求实测、当前估算和容量全部来自 SessionManager.contextUsage，定义与计量限制见 [Context](CONTEXT.md)。

## 模型、思考与上下文控件

空白且尚未运行的会话显示 `Context Not started / 容量`、比例 —，不把预先组装的系统/工具开销呈现为已开始对话的占用，也不将 runtime 估算强行归零。开始对话后使用完整当前估算；已有历史的恢复/fork 不适用空白状态。`verify:webui-models` 除注入计数的生命周期场景外，还使用生产估算器验证中文标点/emoji 回答、真实本地 read 结果、空白首页、连续回合和恢复；生成传输仍注入，不调用供应商。

模型按钮打开紧凑 dialog，内部使用自定义圆角 listbox，仅列出 runtime modelChoices 中 available 的型号；选项显示模型名，不显示区域和未配置连接。完整身份仍用于选择与提交。列表支持方向键、Home/End、Enter 和 Escape，焦点边框保留在容器内。思考滑条从该型号的 thinkingOptions 选择已开启档位，DeepSeek 显示 low/medium/high/max/ultra；固定 on 不可拖动，不支持思考则隐藏滑条，不向强制思考型号提供 off。默认值由 runtime 目录决定：支持 medium 则优先 medium，仅开关型号为 on，其他保留实际支持的默认档位。已有选择不被重写；已有 off 会话打开菜单时预选启用默认值，只有 Apply 后才修改。别名的实际协议档位保留在滑条提示中，不增加说明段落。

Apply 由 app.ts 提交 `/api/model` 的 sessionId、revision、previous 和 selection；Controller 检查目标/旧选择并调用 SessionManager.setModel。revision 0 草稿也核对 previous，阻止跨标签旧选择覆盖。忙碌时拒绝切换，错误保留临时表单并在弹窗内呈现；成功刷新标签，不清空未发送草稿。保存、准备、激活顺序仍由 runtime 管理，失效或缺少连接不会暗中回退模型。

圆环只用当前 ready 估算与当前模型窗口绘制，不使用累计消耗或最近实测输入。点击后仅显示 `Context 已用 / 窗口容量 百分比` 一行和进度条，token 使用 K/M 紧凑格式。近似值前加 ≈；未知显示 Unknown，pending 显示 Updating，不能求百分比时显示 —，不伪装成零。完整数值、计量方法或未知原因保留在提示中，不显示长说明和多项指标。只有图形宽度限制在 0–100%，真实占比可以超过 100%。runtime 快照仍完整保留累计、缓存覆盖、最近主请求身份/时间、窗口剩余和输入余量，未改变这些指标的统计口径；仅精简浏览器展示。缓存命中不减少占用，思考不重复加入输出。

Controller 在启动/恢复、回合收尾（包括工具、回答及压缩）、会话管理和模型切换完成后调用只读 previewContext；执行开始即失效，执行期间显示 pending。权限模式改变也失效并刷新。打开详情通过空正文 `/api/context/refresh` 重新采样动态指导；轮询仅取快照，不触发计数或模型调用，未发送草稿不进入 API。刷新串行排队，runtime 丢弃旧实例/revision 的迟到结果。预览不生成、不执行工具、不压缩、不改会话存储；本地请求字节限制与模型 token 上限分别保留。

ModelControls 只保存 DOM、显示签名与打开时的临时表单，app.ts 持有页面快照、请求及草稿。两个弹窗支持 Escape、外部点击与焦点恢复；模型面板另有关闭按钮，上下文摘要不显示额外标题和关闭按钮。浮层锚定工具栏并限制在视口内，模型列表内部滚动，渐变缩放入场尊重减少动态效果设置。模型与圆环按钮和左侧按钮使用相同圆角，并提供圆角悬停背景/阴影。三个左侧图标统一为 16px 图标框并垂直对齐。

## 两类页面查看

用户 Preview 读取工作区单个 HTML/HTM/SVG，以短期单次快照送入 sandbox iframe。允许内联脚本/样式，不允许同源、外部网络和相对资产，不启动开发服务器；Free 不扩大预览范围。刷新从磁盘重读，失败清除旧画面，关闭移除 frame；无模型请求、历史变更或执行报告。

预览容器使用原生 dialog：宽屏以非模态方式并排显示，覆盖布局通过 showModal 阻止背景页面交互和聚焦，保留浏览器自身工具栏的键盘访问。跨布局切换保留当前 iframe、路径及可用的面板内焦点；面板控件上的 Escape/关闭按钮移除 iframe、取消读取并恢复入口焦点，入口不可用时回退到对话阅读区。隔离 iframe 接收自己的按键，需 Tab/Shift+Tab 返回面板控件后使用 Escape；不读取 iframe 的 DOM、不注入按键桥接，也不扩大 sandbox 权限。

预览沿用 UTF-8 文本文件的 1 MiB 限制，最多四次并发读取、八个快照；快照 60 秒过期且只消费一次。创建和消费时核对工作目录，目录变化后的旧快照不可用。

受控 browser 的执行、交互与 JSON/PNG 由 [Browser](BROWSER.md) 负责，Web UI 只认证读取固定证据 ID。JSON 使用 textContent，PNG 经带头 fetch 转 Blob，令牌不进入 URL；关闭释放 URL 并取消读取。预览可在 Plan/read-only 使用，browser 仍遵守命令权限。

## 原生桥接与交互约束

目录 helper 使用系统 PowerShell/.NET、STA 的 IFileDialog，固定 execFile 参数、shell=false，路径经环境传递，输出最多 32 KiB。五分钟期限、断连/关服取消与隐藏 owner 保证有界生命周期；使用 PerMonitorV2 和 TOOLWINDOW 避免多余任务栏窗口。选择结果仍由 Manager 验证，不授予文件/命令权限。

打开器使用隐藏 helper 与环境传递 URL，五秒期限；失败保留终端私有链接，服务继续。退出取消未完成 helper，不关闭用户浏览器。

页面使用系统字体、中性色、共享 logo、本地 Lucide sprite 及许可证，无 CDN。Markdown 只支持当前子集，HTML 当文字；输入法组合不误提交，Enter/Shift+Enter 语义见指南。菜单/弹窗可键盘访问，移动抽屉限制焦点、关闭恢复入口，嵌套 Escape 优先；减少动态效果设置应被尊重。具体尺寸/样式以 CSS 为准，不在架构复制逐像素清单。

侧栏集中项目/聊天导航与连接状态，不展示占位账户信息。消息、审批与输入框共用内容宽度和页边距；输入框内保留权限、工作目录和发送/停止，底部同一行左侧依次放置附件回形针、权限与工作目录，右侧为模型名、上下文圆环与发送/停止；窄屏将权限和目录文字收为带可访问名称及提示的图标，模型名可截断但保留完整提示。点击圆环打开紧凑上下文摘要，悬停或聚焦可读占用提示。顶栏只保留预览眼睛图标和窄屏侧栏开关；新建聊天位于品牌右侧，Projects 标题右侧提供新建项目。底部设置位于连接状态左侧，正常连接显示绿色圆点与 Local，断线显示红色圆点与 Disconnected；当前不存在 Cloud/Remote 宿主。响应式规则以实际对话列宽度为依据，预览分栏保留对话的最小可用宽度，较窄窗口沿用覆盖式预览。长代码行在代码块内横向滚动，长草稿和资料提示限制在输入区域内，短窗口仍保留对话阅读空间。

`SettingsPanel` 使用位于侧栏与 main 之外的原生模态 dialog，居中显示并带阴影，限制键盘焦点在弹窗内；叉号、Escape 或弹窗外部点击关闭并恢复设置入口焦点。只在指针按下和点击均位于外部时关闭，内部点击/拖动不会误关闭。弹窗独立于侧栏抽屉和尺寸变化。它只管理设置展示、焦点和浏览器外观偏好（System/Light/Dark），同一 origin 的 localStorage 保存主题；跟随系统时响应系统主题变化，存储不可用时当前页面仍可切换。会话详情和迁入项目通过回调或入口调用现有流程，不复制宿主设置或授权。移除顶栏项目名后，当前草稿迁入项目入口保留在设置中。

首页仅保留 logo 与主标题。回合下方的 Activity、Execution report 使用紧凑折叠摘要。会话详情采用固定标题与内部可滚动内容区，滚动条避开外框圆角，保留阴影和键盘滚动；当前未保存草稿的详情直接读取页面 current 快照，不依赖已保存会话列表。项目表单标签与 Session name 一致，左对齐、独占一行，并与输入或选择框保持相同间距。

输入框空闲动画仅在已有对话、连接正常且无请求提交、模型运行或待批时启用。空文本、输入框内无焦点、鼠标移出同时持续 1.2 秒后，隐藏输入区并保留工具栏，发送箭头与睡猫使用旋转淡入淡出，尺寸过渡使用弹性缓动。ComposerMotion 只持有 DOM、展示状态和定时器；app.ts 提供可启用状态并保留草稿、发送、停止与焦点回调。收缩区设置 inert，睡猫为独立 type=button，点击或键盘激活只展开并聚焦，不提交；非空草稿始终保留展开。返回首页或执行开始时立即展开，系统减少动态效果时不播放过渡。

输入框宽度变化由 `app.ts` 的 ResizeObserver 调用既有高度更新，处理窗口缩放或预览分栏导致的换行；只在宽度变化时更新，不在每次高度回调里重排，不更改草稿、提交、轮询或滚动跟随的所有权。

## 验证与未实现范围

包迁移回归还覆盖从无关工作目录加载入口、静态资源与原生 helper 定位，以及未公开包路径和 HTTP 路径拒绝。

检查真实 HTTP 的认证/来源/大小/静态路径、忙碌与旧确认、断连、取消、空草稿、跨标签、目录与共享材料变化。Edge 检查使用临时数据和注入模型/目录选择，涵盖桌面/窄屏、主题、焦点、审批和预览；原生选择器单独检查真实 Win32 行为，不能相互替代。真实视觉和模型质量未由这些 UI 检查证明。

浏览器视图调整还需验证节点复用/替换、展开状态、来源身份捕获和实时拖拽门禁；这些检查由 `verify:webui` 使用实际提供的模块执行。项目分组和跨标签迁入使用 `verify:projects`，资料引用及来源显示使用 `verify:documents` / `verify:attachments`，按改动范围选择。离线静态资源检查不能替代真实 DOM 和焦点验证。

`verify:webui` 的布局辅助检查还覆盖长草稿、短窗口、抽屉和预览断点两侧、浅深主题、消息与输入框对齐、关键控件命中测试、草稿随宽度变化自动增高、代码块局部滚动及轮询保留阅读位置。IME 合成事件验证提交防护，不代表实体输入法的完整实机测试；截图仍需人工检查视觉层级。

原生 Windows helper 已通过实际目录窗口的选择、取消、中止与超时检查，包含 192 DPI 下的 PerMonitorV2、隐藏 owner、无额外任务栏窗口及退出清理。该检查由验证 helper 驱动真实窗口，不代表所有 Windows/DPI 配置；非 Windows、实体手机和其他浏览器仍未完成实机验证。

`verify:webui-models` 使用真实 Edge、SDK 组装、注入传输和本地计数器，覆盖模型/思考选择和协议别名、不可用项、错误重试、草稿保留、忙碌拒绝、三种指标隔离、回答/工具/压缩刷新、模型切换后的旧观察、未知值、重载/恢复、浅深主题与 1440/390/320px 布局、短视口、图标对齐及焦点/减少动态效果。离线 HTTP 检查额外覆盖认证、来源、严格字段、旧会话/revision/选择拒绝及快照不泄漏凭据。注入计量不证明供应商 token 精度，不执行真实模型请求。

`verify:documents` 通过受控延迟覆盖回答可见但最终上下文刷新尚未结束的阶段：来源仍可查看，宿主忙碌和发送门禁仍有效。连续提交等待发送按钮真正可用，不把答案节点出现当成回合已收尾；请求次数、实测输入及视觉/转录来源断言保持严格。

后续 UI 调整按实际任务确定方案，继续保留共享核心所有权，验证目标操作、键盘、窄屏、错误和取消。账户、多用户、远程发布、语言切换、流式输出、会话正文全文搜索、数学/图表 Markdown 扩展、Office 高保真查看器、文件恢复和操作重放尚未实现。
