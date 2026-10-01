# 本地 Web UI

## 范围与现状

阶段 2D-13 根据用户要求增加 `pnpm start --webui`，在本机浏览器使用现有编码 Agent。参考 ChatGPT 网页的侧栏、居中对话与底部输入结构，使用 Fatcat 自有文字与配色。CLI、chat、TUI 保留。实现不增加 Graph、通用渠道框架或新模型协议；验证事实以 [PROGRESS.md](../PROGRESS.md) 为准。

## 模块与所有权

| 模块 | 职责 |
| --- | --- |
| `src/cli.ts` | 模式互斥、`--webui` / `--port` 参数、已有配置和权限选项；动态加载 Web UI。 |
| `webui/index.ts` | 创建相同的 Tools、Skills、Agent 和 SessionManager，注入浏览器审批回调；SIGINT/SIGTERM 停止服务与活动回合。配置只向浏览器暴露显式白名单字段。 |
| `webui/controller.ts` | 单活动回合、显示用 transcript、当前状态、最多一项待批操作及版本号；2D-14 复用 SessionManager 持有会话列表与新建/切换/命名/分支；停止/关闭时取消模型与审批；生成独立报告。 |
| `webui/server.ts` | 原生 Node HTTP、loopback 监听、随机 capability、来源校验、请求体上限、静态资源白名单及 JSON 路由。 |
| `webui/client/app.ts` | DOM 视图、草稿、多行输入、轮询、重连、审批按钮、会话列表与操作、窄屏侧栏及会话详情；不执行工具或保存模型历史。 |
| `webui/client/session-menu.ts` | 针对所点会话的一份右键菜单，持有菜单定位、键盘导航、关闭和焦点恢复；操作由 app 提交到原控制器。 |
| `webui/client/markdown.ts` | 小型 Markdown 子集，以 DOM textContent/text node 渲染不可信内容；不启用 HTML，不使用 innerHTML。 |
| `webui/public/`、`scripts/copy-webui.ts` | HTML/CSS 资源与构建复制；TypeScript 直接编译到 dist/webui/client，不引入打包器。 |
| Session / Loop / Tools / execution-report | 保留成功模型历史、循环、工具校验/执行、独立 journals 和可核对的回合事实。 |

浏览器提交 → HTTP 校验 → 控制器 → SessionManager.run → Session / Loop / 模型 / 工具 → 事件与执行报告 → 状态快照 → 浏览器显示。工具待批时通过已有回调等待一次性决定，浏览器批准后仍由原工具复查权限、路径、文件冲突和取消。

## HTTP 和本地访问边界

- 固定监听 `127.0.0.1`，默认 3210，CLI 可通过 `--port` 使用 1–65535。没有外网监听配置，启动失败返回安全错误。
- 每次启动产生 32 字节随机 capability，只以 URL fragment 打印。页面读取后移除 fragment，并在当前标签 sessionStorage 保存，以 Bearer header 访问 API；不存储 provider Key。有链接的标签共享同一服务会话。
- 所有请求验证精确 Host；带 Origin 的请求只允许实际本地 origin。API 必须有正确 capability，不开放 CORS。页面 CSP 限制脚本/样式/连接为自身、禁止 frame 和外部资源，另设置 no-store、nosniff 和 no-referrer。
- 静态 GET 仅 `/`、`/styles.css`、`/app.js`、`/markdown.js`、`/session-menu.js`、`/favicon.svg`，不映射任意磁盘目录。JSON 请求体最多 64 KiB，prompt 最多 32768 UTF-8 字节；仅接受指定字段和类型。连接数最多 32，header/request 限时 10 秒，连接空闲限时 15 秒。
- `GET /api/state` 返回显示快照并支持 ETag/304。前台每约 700ms、后台每约 3 秒轮询；这是状态更新，不是 provider token 流。
- `POST /api/message`、`/api/stop`、`/api/reset` 和 `/api/approval` 处理回合与审批。运行中提交或 reset 返回 409；approval ID 不匹配或重复使用返回 409。有效写入/命令仍受原 permission 和 shellPermission 限制。
- 2D-14 的 `/api/session/new`、`/api/session/resume`、`/api/session/rename` 和 `/api/session/fork` 复用同一 capability、来源与 JSON 参数校验。state 包含当前会话与工作目录列表；管理操作期间使用忙碌保护，运行或审批中拒绝切换和新建。
- 同阶段菜单增量加入 `/api/session/delete`，使用所点会话 ID 与菜单快照 revision；rename/fork 可带目标 id，省略仍操作当前会话。删除复用 Store 锁、修订和工作目录隔离，不向模型提供删除工具。旧 revision 无法删除其他进程已更新的会话。
- 管理操作失败时尽力刷新保存列表，保留原错误及当前历史/报告；列表、菜单和详情使用同一保存元数据。修订冲突后用户可重新打开菜单确认最新 revision，删除再次读取该 ID 并在 Store 锁内复查，不自动恢复或重放当前历史。其他进程的变更没有后台推送。

这不是多用户或远程服务器。链接持有者可查看当前会话并操作授权范围；本机其他用户与程序的隔离不由此应用提供。浏览器页面关闭不会自动停止模型或拒绝审批，用户可以重新打开带令牌的链接继续；终端 Ctrl+C 才关闭服务。

## 状态和交互

控制器保存显示状态，SessionManager 持有活动会话并保存完整成功历史及最近未完成回合。失败/取消的提示和错误可见，但不替换成功模型历史。New chat 创建新的持久会话，原会话仍在列表；切换、命名、分支通过同一 Manager，运行/审批中拒绝操作。工具事实独立保存，不撤销修改/命令、不重置 journals 上限。单会话最多 100 个显示回合，需要 New chat 后继续；每回合活动保留最近 100 项，完整报告保留写入、命令和父子请求事实。

会话操作集中在左侧每一行的右键菜单：详情、命名、分支和删除。右键和 Shift+F10 / ContextMenu 不会先切换活动会话；操作明确绑定该行 ID，删除还带打开菜单时的 revision。详情只读取 state 中的该会话元数据及本次启动配置，不请求模型或恢复历史。删除前浏览器确认；删除未活动会话保留当前历史、显示与草稿，删除活动会话后进入新建的空会话，不重放任何操作。分支所点会话会打开新分支，命名未活动会话不会切换。

菜单只在需要时显示，定位限制在视口内；支持方向键、Home/End、Enter、Escape 和焦点恢复，点击外部、列表滚动、窗口缩放或目标修订改变后关闭。执行/审批中禁用变更操作，详情仍可读取。当前工作区移到 composer 底部、Workspace context 右侧；长路径省略显示，完整路径与权限在 title 和详情可见。原侧栏命名/分支按钮、工作区卡片和详情按钮已移除。

审批展示完整旧/新文本或命令、cwd、timeout；独立按钮只允许一次操作，普通聊天输入不能成为批准。命令明确提示非 OS 沙箱。拒绝、取消和关服均结束待批 Promise；取消信号继续传播给父子模型与工具。取消后的回合必须真正完成收尾才能提交下一轮。

Enter 提交，Shift+Enter 换行，composition 期间不提交；执行时允许保留下一条草稿。刷新从服务器恢复显示快照，草稿不持久化。基础 Markdown 支持标题、列表、引用、粗体、行内/块代码与 HTTP(S) 链接，任意 HTML 和其他链接协议保持文本。窄屏侧栏可展开，跟随系统深浅色及 reduced-motion。

执行报告直接来自 createTurnReporter，不根据自然语言声称推断测试成功；未知用量仍为 null。报告含父/子请求数量、有效 token 报告覆盖、请求字节、上下文整理、写入与命令结果。当前不实现 TUI 的完整缓存指标面板或费用估算。

## 技术选择与限制

沿用 Node 24 / pnpm 11.21.0 / TypeScript 和 openai SDK；Node HTTP、浏览器原生 DOM 与 CSS 足以承载此单页及单活动 Session 增量，因此没有增加前端框架、HTTP 框架、打包器或依赖，不修改 pnpm-lock.yaml。tsconfig 加入 DOM 类型及 webui 源文件，build 复制固定 HTML/CSS 文件。

字体参考 [Claude Code Docs](https://code.claude.com/docs/en/overview)（2026-10-01 核对）：页面实际使用 Anthropic Sans 正文与 Anthropic Serif Display 标题，标题为正常字重、无额外字间距。Fatcat 采用同一衬线/无衬线层次，字体栈先使用本机已有的同名字体，回退到 Georgia / Times 标题与 Arial / Helvetica / Segoe UI 正文；代码继续使用等宽字体。没有打包第三方站点字体或加入外部加载，保持既有 CSP 与离线页面能力；回退字体不承诺逐像素相同。

2D-14 的会话历史保存在本地 Store，可从当前工作目录列表或启动参数恢复；各标签共享一个活动会话。审批、活动报告、统计和实时 Tools journals 仍在进程内，服务停止后不恢复。没有多用户账户、远程发布、运行中换模型、流式答案、思考协议、附件、完整 Markdown 表格/嵌套语法、文件检查点或工具重放。浏览器状态不等于模型输入历史，也不保证任何自然语言任务结果正确。

测试覆盖控制器、实际 HTTP 与 CLI、真实临时文件/固定 PowerShell；模型与用量使用注入夹具。浏览器验证及真实模型验证分别记入 PROGRESS，不沿用其他入口的历史 API 验证宣称本轮已在线验收。
