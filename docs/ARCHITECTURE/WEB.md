# Web：搜索与 HTTP(S) 页面读取

[架构总览](README.md) · [联网操作](../GUIDES/CODING.md#research-public-information)

一个通用 web 工具提供搜索和静态页面读取；天气由同一工具访问公开服务。它不运行浏览器或后台抓取，不能替代 [Browser](BROWSER.md) 的工作区执行。

## 模块与协议

| 源码 | 职责 |
| --- | --- |
| `src/tools/web.ts` | search/fetch 参数、权限、调用期限与结构化结果 |
| `src/tools/web-content.ts` | HTML 文本/链接提取、Bing RSS 与 DuckDuckGo 解析 |
| `src/permissions/web-request.ts` | URL/IP/DNS、连接固定、跳转、解压与下载 |
| `src/skill/web/` | 检索和天气指导，不承担网络授权 |

普通入口显式装配 web allow，程序化 createTools 未传 WebOptions 不增加该工具，传入但省略 permission 默认 deny。父子共享同一策略。

search 输入 query（最多 512 字符）、limit（1–5）和可选 engine/recency。默认 Bing RSS，另支持 DuckDuckGo HTML。recency 只是日期提示，返回 notice 要求核对原文；验证码、格式变化或超时不是成功无结果。retrievedAt 是抓取时间，不能冒充发表时间。

fetch 返回最终 URL、类型、标题、静态正文、链接与 offset/nextOffset。去掉脚本/样式，不执行 JS、不登录、不携带浏览器 Cookie 或自定义秘密头。接受 HTML、JSON、XML、text、Markdown、CSV，拒绝 PDF/图片及未知下载。每次分页重新请求，没有快照/缓存。

## 网络边界

普通模式仅公共 HTTP(S) 标准端口；Free to go 放开本地/LAN 地址及端口，仍只支持 HTTP(S)。所有模式拒绝 URL 凭据和控制字符，URL 最多 2048 字符。

每次 DNS 和跳转重新验证地址；连接 lookup 固定已校验 IP，TLS 仍验证原主机，不在连接时重新解析。普通模式拒绝混合公私 DNS 和 HTTPS 降级，Free 可按指定范围访问。使用原生 Node HTTP(S)，不读取代理环境变量。

| 限额 | 当前值 |
| --- | --- |
| 单次期限 | 默认 15 秒，含 DNS/跳转/正文，支持取消 |
| 重定向 | 最多三次 |
| 原始/解压内容 | 分别 1 MiB |
| 正文页 | 12000 UTF-8 字节，不截断 Unicode |
| 页面链接 | 最多八个；offset 是 UTF-16 字符位置 |

支持有界 gzip/deflate/br 解码，非法编码/类型明确失败。截断 JSON 不能当完整数据，网页变化可能改变翻页内容。旧 web 结果不参与 read 省略，连续查询仍可达到模型预算。

内容以 untrusted/notice 标记，不能改变权限。错误仅返回稳定安全码，不回传服务器错误页或原始异常。Web deny 独立于 shell，并非 OS 网络沙箱。

## 依赖与验证限制

htmlparser2 用于结构提取，ipaddr.js 用于地址范围分类；避免靠正则处理全部 HTML 或手工猜测 IP。天气指导使用 Open-Meteo；服务条件由其[条款](https://open-meteo.com/en/terms)约束，免费公开接口有非商业用途限制。

离线检查注入 DNS/HTTP 并使用本机临时 server，覆盖跳转、地址、解压/大小、取消、脱敏和父子继承。verify:web 单独检查五个固定公网调用，不请求模型。既有 Bing 连通记录不保证其他网络；DuckDuckGo 的超时记录不能当作已在线验收。

无登录、代理配置、动态网页、远程文档解析、自动多引擎重试或全量抓取。真实模型选源、中文地点消歧与检索相关性需另验。
