# 工作区受控浏览器

## 范围与状态

第二步作品检查已在 `feat/webui-dev` 实现。一个模型工具 `browser` 使用 Playwright 执行工作区 HTML/HTM/SVG，返回基本交互后的错误、DOM/几何状态及证据路径。它与用户主动打开的单文件 Preview 并存，复用 CLI/TUI/Web UI、Session、Loop、权限和委派。真实验证结果见 [PROGRESS.md](../PROGRESS.md)。浏览器可执行、截图已保存、工具 completed 或最终自然语言回复均不等于任务通过。

## 模块与调用顺序

| 模块 | 职责 |
| --- | --- |
| `src/browser/protocol.ts` | 有界参数解析、步骤和记录类型 |
| `src/tools/browser.ts` | 工具定义、权限快照、单次审批、并发/次数控制、执行期限、证据发布与进程 journal |
| `src/permissions/browser.ts` | shell 权限上限、固定 Workspace、MIME/编码/大小、打开后文件身份核对及 SHA-256 |
| `src/browser/runtime.ts` | 每次创建/关闭 Playwright browser/context、工作区资源路由、交互、诊断和固定 DOM/几何采集 |
| `src/browser/evidence.ts` | 固定目录下独占创建 JSON/PNG，按 ID 受控读取 |
| `webui/client/browser-evidence.ts` | 认证读取报告/图片、纯文本 JSON 与 Blob 图片弹窗；关闭取消读取并释放 URL |
| `src/skill/browser/local-browser-check/SKILL.md` | 已实现工具的 read → browser → write → browser 验证指导 |
| `scripts/verify-browser.ts` | 真实浏览器、临时文件和注入模型决策的固定验收，不调用模型 API |

工具请求 → 参数/工作区入口校验 → 策略操作锁及 Browser 审批 → 新建 headless 浏览器 → 本地资源路由 → 顺序交互 → DOM/几何与可选 PNG → 关闭浏览器 → 保存证据 → 返回文本结果。失败/取消保留已经建立的记录；参数/权限拒绝不计实际执行。没有持久页面、跨调用 cookie 或用户浏览器配置复用。模型不能指定可执行文件、启动参数、远程调试端口或任意 JavaScript；代码求值仅用于固定的内部状态读取。

`createTools` 第七个可选 `BrowserOptions` 提供 approve 和测试 runner。日常入口始终装配工具，模型按任务选用；程序化旧调用不提供该参数则保持原集合，提供 `{}` 时仍受原 read-only/shell-deny 默认值约束。父子 Tools 和 Skills 包装透传 getBrowserChecks，Loop 发出 browser_record，execution-report 按 ID 去重，并在随后 write_record 时标记旧检查。Session 保存正常工具结果，不保存授权或自动重放操作。

## 权限与运行边界

Browser 是执行页面脚本并写证据的操作。Manual/Accept edits 使用专门的一次 Browser 审批，展示路径、步骤、选择器、视口及截图设置；read-only、Plan、shell-deny 拒绝；显式 shell-allow/Free to go 自动允许。审批覆盖该检查及生成证据，不授权修改页面源码。审批和运行期间锁住模式，取消/旧审批 ID 不得执行。public web 的 deny 不等于 browser deny；Free 也不扩大 browser 文件或网络范围。

每次生成随机 `.fatcat.invalid` 虚拟 origin，使用 context.route 直接从固定工作区受控读取并 fulfill 所有 HTTP 资源，从不 continue 到网络。仅 GET/HEAD 和当前 origin 可用；每个新资源重新检查路径、目录/链接、文件身份、扩展名、大小及 UTF-8。绝对路径、越界、隐藏名称、node_modules、链接/硬链接均拒绝；证据目录本身不向页面提供。缓存同一资源首次读取字节并记录哈希，不是整个工作区的原子快照。

支持 HTML/SVG、JS/MJS、CSS、JSON/TXT、常见 PNG/JPEG/GIF/WebP/ICO 和 WOFF/WOFF2。资源有 CSP、nosniff、no-store、no-referrer；脚本/样式允许本地及内联，图片/字体另允许 data。CSP 禁止外部资源、动态求值、frames、objects、workers 和表单提交。Service Worker 明确 block，WebSocket 路由关闭；页面 WebRTC/WebTransport API 禁用并设置 Chromium UDP 策略，弹窗关闭、对话框 dismiss、下载 cancel。临时浏览器进程仅继承必要系统环境变量，不传 provider Key 或聊天 capability。

上述为应用层路由与浏览器限制，不是 OS 网络沙箱、浏览器漏洞隔离保证或 CPU/内存配额。页面仍可运行自己的脚本；本机其他进程、浏览器内部网络以及文件检查与打开间的竞争不由此设计完全隔离。不得把该工具称为允许任意不可信站点安全执行的环境。

## 协议、预算与证据

- `path` 为工作区相对 HTML/HTM/SVG；最多 12 个 click/fill/press/select/wait 步骤和 12 个 CSS 选择器。交互定位严格匹配单元素；press 仅开放固定普通键。每次 wait ≤ 2 秒，累计 ≤ 5 秒。
- 默认视口 1000×700，可选宽 320–1600、高 240–1200；截图默认开启，捕获视口而非整页。每次只采样交互完成后的一个状态，不支持确定性时间定位或多帧序列。
- 执行 AbortSignal 期限 30 秒，不含等待用户审批与证据写盘；启动另限 8 秒、页面 load 5 秒、单步默认 2 秒、截图 4 秒。取消触发关闭浏览器，finally 等待关闭；启动中的取消需等有界启动返回。没有用墙钟统计替代清理完成确认。
- 每个 Tools 进程最多 40 个执行记录，只允许一个检查在运行；资产请求最多 100 次，最多 64 项资源，每项 2 MiB、总计 8 MiB。超限资源被阻止并产生诊断。
- 最多 20 条诊断，每条 400 字符；采集 pageerror、console error/warning、请求失败、受限操作和 action/capture 失败。errorCount 包含非 blocked 诊断（包括 warning），不是唯一异常数；截断单独标注。
- DOM 文本最多 4000 字符、匹配元素最多 30 个；包括文本、表单值、可见性、viewport rect，SVG 另有 getBBox 与 getScreenCTM。password 输入值单独遮蔽，但截图及其他页面文本不做通用脱敏。状态与 PNG 依次采集，动画可能已推进，不能保证来自同一帧。

证据写入 `fatcat-browser-evidence/<32位随机十六进制ID>.json/.png`，固定工作区目录、链接检查、wx 独占创建，单文件最多 8 MiB。先写 PNG 再写 JSON；两文件不是原子事务，写盘失败可能留下部分文件，不返回完整成功链接。没有自动删除或轮转；文件包含页面数据、操作参数、时间、加载源哈希和观测值，需要用户按任务保管。模型只收到结构化文字和文件路径，不包含图像像素，visualVerification 固定 not_performed。

工具结果 ok 表示得到可用观测，内部 status 可能 failed。completed 仅表示交互/采集完成，运行错误可同时存在；模型应检查诊断、完成步骤和截断，修复后重新运行同一场景。laterWriteAttempt 只提示本回合已观察到的后续 write，不检测 shell、编辑器或其他进程变化。磁盘文件是本地证据而非防篡改证明。

Web UI 的认证 GET `/api/browser-evidence/<id>/report|screenshot` 只映射固定 ID 和扩展名，沿用 Host/Origin/capability 检查并限制文件读取。报告作为 pre.textContent 展示；图片经带 Authorization 的 fetch 生成临时 Blob URL，令牌不进入图片路径。聊天 CSP 仅为图片新增 blob，不开放页面脚本。进程内报告可见时有按钮，恢复旧会话不重建报告，但证据文件仍存在。

## 依赖与后续

新增并精确固定 `playwright@1.63.0`（含 playwright-core），原因是需要真实浏览器生命周期、路由隔离、可定位交互、错误事件和 PNG；沿用 Node 24、pnpm 11.21.0、TypeScript 和现有模型 SDK。Windows 使用已安装 Edge（channel msedge、headless、chromiumSandbox true），不自动安装浏览器；其他系统使用手动安装的 Playwright Chromium，当前未实机验证。

参考官方 [Browser 支持](https://playwright.dev/docs/browsers)、[Network / Service Worker](https://playwright.dev/docs/network) 和 [Page API](https://playwright.dev/docs/api/class-page)。图像输入、完整动画/多时刻采样、外部站点、开发服务器、登录和持久页面均未实现；按后续具体任务再扩展，保持一个通用工具与现有 Loop。
