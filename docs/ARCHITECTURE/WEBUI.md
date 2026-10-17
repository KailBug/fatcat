# Web UI：本地 HTTP、交互与预览

[架构总览](README.md) · [操作指南](../GUIDES/INTERFACES.md#local-web-ui)

Web UI 是本机单用户入口。浏览器持有草稿、菜单与显示快照；共享核心持有会话、回合、工具事实与权限。所有标签使用同一服务的活动会话，不分别运行 Agent。

## 模块职责

实现位于私有 workspace 包 `@fatcat/webui`，包根只导出 `runWebUi`。CLI 按原时机惰性加载入口，导入本身不监听端口、打开浏览器、注册信号处理或请求模型。包依赖 runtime 和 commands，不依赖 TUI 或根应用；Controller 和页面各自的状态所有权保持不变。

服务端、浏览器模块和显示类型都在 `src/` 下，独立构建为包内 `dist/`。HTML/CSS、图标及许可证、原生目录 helper 随包构建复制；共享 logo 仍以根 `images/logo/mini-logo.png` 为唯一源，构建时复制进包。运行时按模块位置定位资源，不依赖仓库根目录或启动 cwd。浏览器继续使用原 HTTP URL 和原白名单，构建检查客户端产物不引入 Node 或其他服务端模块；类型导入不会进入浏览器执行代码。

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
| `packages/webui/src/client/session-list.ts` | 会话/项目分组、列表缓存、菜单入口与拖拽事件 |
| `packages/webui/src/client/session-menu.ts`、`session-dialog.ts` | 目标快照、菜单/弹窗、键盘与焦点 |
| `packages/webui/src/projects.ts`、`project-http.ts`、`project-management.ts` | 项目预览与确认入口，持久语义委托 Manager |
| `packages/webui/src/attachments.ts`、`attachment-http.ts`、`attachment-evidence.ts` | 上传、当前作用域与实际来源呈现 |
| `packages/webui/src/preview.ts`、`client/preview.ts` | 单文件快照与隔离预览 |
| `packages/webui/src/folder-picker.ts`、`native-folder-dialog.ps1` | 有界原生目录选择，不是模型工具 |
| `packages/webui/src/context-usage.ts` | 最近普通父请求 token 与已知模型容量 |
| `packages/webui/src/client/cron.ts`、`permission-menu.ts`、`browser-evidence.ts` | 对共享服务的调度、模式和证据操作 |

## 浏览器页面与视图边界

`app.ts` 持有唯一页面快照、ETag、连接状态与提交锁，并协调输入草稿、审批/详情、滚动跟随、预览重置及各菜单和弹窗。请求成功后的刷新和草稿清空时机不由视图决定；轮询继续过滤旧 revision，304 只更新连接状态，断连不丢弃草稿。

`TranscriptView` 接收回合、Session ID 与工作目录，只持有回合节点和序列化签名缓存。未变化的回合复用 DOM；变化时保留按 `data-kind` 区分的展开区域；删除的回合移除对应缓存。Markdown 与来源按钮捕获渲染时的 Session ID，不在点击时改用新选中的聊天。预览按钮与浏览器证据仍调用现有组件；滚动跟随条件和执行时机留在 `app.ts`。

`SessionListView` 接收列表所需快照，只持有列表签名、DOM 和显示格式器。`displaySessions` 统一菜单、详情与列表对已保存当前会话的补入规则，不把未保存草稿加入持久列表。点击和菜单事件携带明确目标；拖拽开始/悬停通过回调读取实时可操作状态，放下时由入口按当前快照解析 Session 并打开项目确认。视图不请求 API、不保存另一份页面快照，也不负责业务校验或持久状态。按钮禁用在每次 controls 更新时应用，即使列表签名未变化也有效。

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

模式切换、自动任务和 compact 均交给共享核心。背景任务显示目标身份而不切换前台；自动摘要留在原回合 activity。模型窗口显示只用 context-usage.ts 的精确名称容量，未知不猜测；最近父请求之外的累计、摘要/视觉、草稿和回复均不能充当上下文比例。

## 两类页面查看

用户 Preview 读取工作区单个 HTML/HTM/SVG，以短期单次快照送入 sandbox iframe。允许内联脚本/样式，不允许同源、外部网络和相对资产，不启动开发服务器；Free 不扩大预览范围。刷新从磁盘重读，失败清除旧画面，关闭移除 frame；无模型请求、历史变更或执行报告。

预览沿用 UTF-8 文本文件的 1 MiB 限制，最多四次并发读取、八个快照；快照 60 秒过期且只消费一次。创建和消费时核对工作目录，目录变化后的旧快照不可用。

受控 browser 的执行、交互与 JSON/PNG 由 [Browser](BROWSER.md) 负责，Web UI 只认证读取固定证据 ID。JSON 使用 textContent，PNG 经带头 fetch 转 Blob，令牌不进入 URL；关闭释放 URL 并取消读取。预览可在 Plan/read-only 使用，browser 仍遵守命令权限。

## 原生桥接与交互约束

目录 helper 使用系统 PowerShell/.NET、STA 的 IFileDialog，固定 execFile 参数、shell=false，路径经环境传递，输出最多 32 KiB。五分钟期限、断连/关服取消与隐藏 owner 保证有界生命周期；使用 PerMonitorV2 和 TOOLWINDOW 避免多余任务栏窗口。选择结果仍由 Manager 验证，不授予文件/命令权限。

打开器使用隐藏 helper 与环境传递 URL，五秒期限；失败保留终端私有链接，服务继续。退出取消未完成 helper，不关闭用户浏览器。

页面使用系统字体、中性色、共享 logo、本地 Lucide sprite 及许可证，无 CDN。Markdown 只支持当前子集，HTML 当文字；输入法组合不误提交，Enter/Shift+Enter 语义见指南。菜单/弹窗可键盘访问，移动抽屉限制焦点、关闭恢复入口，嵌套 Escape 优先；减少动态效果设置应被尊重。具体尺寸/样式以 CSS 为准，不在架构复制逐像素清单。

## 验证与未实现范围

包迁移回归还覆盖从无关工作目录加载入口、静态资源与原生 helper 定位，以及未公开包路径和 HTTP 路径拒绝。

检查真实 HTTP 的认证/来源/大小/静态路径、忙碌与旧确认、断连、取消、空草稿、跨标签、目录与共享材料变化。Edge 检查使用临时数据和注入模型/目录选择，涵盖桌面/窄屏、主题、焦点、审批和预览；原生选择器单独检查真实 Win32 行为，不能相互替代。真实视觉和模型质量未由这些 UI 检查证明。

浏览器视图调整还需验证节点复用/替换、展开状态、来源身份捕获和实时拖拽门禁；这些检查由 `verify:webui` 使用实际提供的模块执行。项目分组和跨标签迁入使用 `verify:projects`，资料引用及来源显示使用 `verify:documents` / `verify:attachments`，按改动范围选择。离线静态资源检查不能替代真实 DOM 和焦点验证。

原生 Windows helper 已通过实际目录窗口的选择、取消、中止与超时检查，包含 192 DPI 下的 PerMonitorV2、隐藏 owner、无额外任务栏窗口及退出清理。该检查由验证 helper 驱动真实窗口，不代表所有 Windows/DPI 配置；非 Windows、实体手机和其他浏览器仍未完成实机验证。

后续 UI 调整按实际任务确定方案，继续保留共享核心所有权，验证目标操作、键盘、窄屏、错误和取消。尚无确定的新布局或排期。账户、多用户、远程发布、语言切换、运行时模型选择、流式/思考协议、完整 Markdown、Office 高保真查看器、文件恢复和操作重放尚未实现。
