

<a id="browser-workspace-page-execution-and-evidence"></a>

# Browser：工作区页面执行与证据

[English](../../en/ARCHITECTURE/BROWSER.md) | 简体中文

[架构总览](README.md) · [操作指南](../GUIDES/CODING.md#local-page-checks)

browser 是执行本地页面并生成证据的模型工具，区别于用户主动打开的单文件 Preview。它复用现有 Loop、权限和委派，不访问任意网站。

<a id="modules-and-flow"></a>

## 模块与流程

| 源码 | 职责 |
| --- | --- |
| `packages/runtime/src/browser/protocol.ts` | 参数、步骤和记录类型 |
| `packages/runtime/src/tools/browser.ts` | 策略快照、审批、次数/并发、期限与 journal |
| `packages/runtime/src/permissions/browser.ts` | 固定 Workspace、资源类型/大小/身份与哈希 |
| `packages/runtime/src/browser/runtime.ts` | Playwright 生命周期、路由、交互和固定采集 |
| `packages/runtime/src/browser/evidence.ts` | JSON/PNG 独占写入与按 ID 受控读取 |
| `packages/webui/src/client/browser-evidence.ts` | 认证展示、取消与 Blob URL 释放 |

校验路径/参数 → 单次审批 → 新建 headless browser/context → 本地路由和交互 → DOM/几何/PNG 采集 → 关闭 → 保存证据。没有跨调用 cookie、存储或页面复用；模型不能设置浏览器程序、启动参数、远程调试或任意 JS。

程序化 createTools 未提供 BrowserOptions 时不增加工具；提供后仍受原只读/shell-deny 默认值约束。日常入口装配后由模型选择。

<a id="permissions-and-resource-isolation"></a>

## 权限与资源隔离

Manual/Accept edits 对整次检查审批，包含页面脚本与证据写入，不授权源码修改。Plan/read-only/shell-deny 拒绝，显式 shell-allow/Free 自动允许。执行持有策略锁；web deny 独立，不等于 browser deny。

所有模式均固定工作区，Free 不扩展。随机 .fatcat.invalid origin 的请求通过 context.route 从受控本地文件 fulfill，不放行到网络；只接受当前 origin 的 GET/HEAD。逐资源核对路径、链接/硬链接、身份、扩展名与编码，隐藏/依赖/越界和证据目录拒绝。首次资源字节缓存并记录哈希，不是工作区原子快照。

CSP 允许本地/内联脚本样式及有界资产，拒绝外站、动态求值、frames、objects、workers、表单提交；Service Worker/WebSocket 阻断，WebRTC/WebTransport 禁用，弹窗关闭、对话框 dismiss、下载取消。临时进程不继承 provider Key 或聊天 capability。

这是应用层路由与浏览器限制，不是 OS 网络沙箱、CPU/内存硬配额或漏洞隔离保证。

<a id="protocol-and-resource-limits"></a>

## 协议与资源上限

| 边界 | 当前值 |
| --- | --- |
| 入口 | 工作区相对 HTML/HTM/SVG |
| 操作/选择器 | 各最多 12；click/fill/press/select/wait，交互严格单元素 |
| wait | 单次 ≤2 秒，合计 ≤5 秒 |
| 视口 | 默认 1000×700；宽 320–1600、高 240–1200 |
| 执行期限 | 30 秒，不含审批/证据写盘；启动 8 秒、load 5 秒、单步 2 秒、截图 4 秒 |
| 工具实例记录/并发 | 每实例最多 40 次，一次在运行；随目录级 Tools 缓存保留 |
| 资产 | 100 请求、64 项；单项 2 MiB、合计 8 MiB |
| 诊断 | 20 条、每条 400 字符；截断明确标记 |
| DOM/元素 | 文本 4000 字符、匹配 30 个 |
| 证据文件 | 每个最多 8 MiB |

采集表单值、可见性、viewport rect，SVG 另含 getBBox/getScreenCTM。password 值遮蔽，但截图/普通页面文本不通用脱敏。DOM 与 PNG 顺序采集，动画可能推进，不能当作同帧或完整动画验证。取消关闭浏览器，启动中的取消等待有界启动返回。

<a id="evidence-and-status"></a>

## 证据与状态

文件位于 fatcat-browser-evidence/<32位hex-id>.json/.png，固定目录校验后 wx 创建；先 PNG 后 JSON，不是原子事务，失败可能留部分文件，不返回完整成功链接。没有自动轮转/删除；本地证据包含页面数据、参数、源哈希和时间，不是防篡改证明。

模型收到文字观察与路径，不收到像素，visualVerification=not_performed。工具 ok 只表示可用观察，内部 status 可为 failed；completed 只表示步骤/采集完成，诊断仍可能包含错误或 warning。errorCount 计非 blocked 诊断，不是唯一异常数。

报告按 ID 去重，laterWriteAttempt 只追踪当前回合后续 write，不检测 shell/编辑器改动。Web UI 认证读取固定 ID 的报告/图片；报告用纯文本、图片转临时 Blob，令牌不放 URL。恢复会话不重建 journal，磁盘证据仍在。

<a id="dependencies-verification-and-unimplemented-scope"></a>

## 依赖、验证与未实现范围

Playwright 提供真实浏览器生命周期、交互和 PNG。Windows 使用已安装 Edge，不自动下载；其他平台的 Chromium 路线未实机验收。

verify:browser 使用真实 Edge、临时页面和注入模型，检查交互、几何、证据、网络边界及取消；普通测试注入 runner。没有真实模型看图验证。外部站点、开发服务器、登录、持久页面、模型截图输入和确定性多帧采样尚未实现。
