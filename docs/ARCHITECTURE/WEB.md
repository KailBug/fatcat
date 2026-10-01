# Web：搜索、网页读取与按模式访问范围

## 范围与状态

在 `fix/session-perfection` 实现公开信息查询，服务于用户指定的资料、新闻、天气和链接阅读。沿用单 Session、原 Loop、SDK、CLI / chat / TUI 与有界委派；不增加浏览器引擎、Graph、后台抓取或专用天气/新闻工具。验证事实见 [PROGRESS.md](../PROGRESS.md)。

## 模块与接口

| 模块 | 职责 |
| --- | --- |
| `src/tools/web.ts` | 单个 `web` 工具的 schema、参数、allow/deny、期限、重定向及结构化结果 |
| `src/permissions/web-request.ts` | URL / IP / DNS 边界、固定已验证地址的 Node HTTP(S) GET、压缩流、下载和解码上限；与工作区/进程执行 guard 同级集中 |
| `src/tools/web-content.ts` | HTML 文本/链接提取、Bing RSS 与 DuckDuckGo HTML 结果解析、UTF-8 安全截取 |
| `src/tools.ts` | `createTools` 第五个可选参数 `WebOptions`；未传入则保留程序化调用原工具集合，传入但省略 permission 时 deny |
| `src/cli.ts`、`tui/index.ts` | 普通任务、chat、TUI 显式装配默认 allow；解析 `--web-permission allow|deny`；TUI 显示状态 |
| `src/skill/web/` | web-research 与 weather-lookup 的任务指导，经已有 Skill 构建、发现和 read 加载 |
| `scripts/verify-web.ts` | 显式的五项公网验收，不读取 .env、不调用模型、不发送工作目录数据 |

父子 Agent 共享同一个基础工具和网络权限。网络访问独立于工作目录写权限，`--permission read-only` 仍可查询公开资料，`--web-permission deny` 在执行前拒绝网络工具。共享 PermissionPolicy 的 networkAccess 默认 public；仅显式 Free to go 使用 unrestricted，开放本机/局域网/其他 HTTP(S) 主机与自定义端口。web 从策略取得操作快照，持锁到 DNS、跳转、下载及内容提取结束。CLI/Web UI 的显式 web-deny 排除 Free，但 deny 仍不是系统防火墙，不能阻止用户单独授权的任意 shell 进程联网；模型指导禁止通过 shell 或委派绕过拒绝。

搜索示例：`{"action":"search","query":"Node.js official documentation","limit":3}`。默认 engine=bing，使用 `https://www.bing.com/search?format=rss&q=...`；可指定 engine=duckduckgo 使用 `https://html.duckduckgo.com/html/`。选择 Bing 为默认是因为本机实际可连通；DuckDuckGo 初次在线检查超时，不能视为已在线验证。没有 API Key、自动重试、后台轮询或隐式多引擎扇出。

query 最多 512 字符，limit 为 1–5、默认 5。recency=day/week/month/year 只是发送给服务的日期提示，返回 recencyNotice 提醒核对原文日期；不宣称搜索服务准确落实过滤。`web_search` 包含 provider、query、请求最终 URL、retrievedAt、results 的 title/url/snippet，以及 Bing 实际返回的 pubDate（缺失为 null）。搜索结果可供进一步读取，不能替代原文验证。

读取示例：`{"action":"fetch","url":"https://nodejs.org/en/about/previous-releases"}`。`web_page` 含最终 url、retrievedAt、contentType、title、content、最多 8 个当前访问范围内链接、offset、totalCharacters、truncated 和 nextOffset。HTML 去掉 script/style/head/template 等节点，只提取静态文本和链接；JSON/XML/text 保留文本。网页不执行脚本，不登录，不提交表单，不写文件，不携带浏览器 Cookie、模型凭据或自定义请求头。

## 请求与输出边界

- 默认范围仅 GET 公开 HTTP(S) 的标准端口，拒绝本地名称、环回、内网、链路本地、组播、保留及 IPv6 转换地址；Free 放开这些地址与端口范围。所有模式仅支持 HTTP(S)，拒绝 URL 用户名/密码和控制字符；URL 最多 2048 字符，片段不发送。
- 每个跳转按同一操作范围分别校验 URL 与所有 DNS 结果；默认混合公开/私有结果也拒绝，Free 接受有效 IP/family。HTTP(S) transport 的 lookup 固定到已验证 IP，TLS 仍按原主机验证，不在连接时重新解析。最多跟随 3 次跳转；默认拒绝 HTTPS 降级到 HTTP，Free 可按指定目的地降级。
- 生产实现使用原生 Node HTTP(S) 直接连接；不读取环境代理配置或提供模型指定代理的能力。需要代理才能到达的站点可能不可用，本次未实现代理转发和浏览器模式。
- 整个工具调用的 DNS、连接、跳转及正文读取共享默认 15 秒期限，支持父子取消。程序化可注入 transport/resolver 和 1–60000 ms 期限用于测试；CLI 通过权限模式选择目的地范围，不开放注入 transport/resolver。
- 原始传输和解压后内容各最多 1 MiB；支持 gzip、deflate、br。有界文本解码采用 Content-Type charset，缺失按 UTF-8；不支持或非法编码失败。只接受 HTML、JSON、XML、plain text、Markdown 和 CSV，不接受 PDF/图片或未声明类型的下载。
- content 每页最多 12000 个 UTF-8 字节，不截断 Unicode 字符；offset/nextOffset 是提取文本中的 JavaScript 字符位置（UTF-16 单元），模型应直接沿用 nextOffset。标题、摘要、链接数量和 URL 长度另有界；最终完整模型请求继续受原 maxRequestBytes 限制。
- 每次 fetch 分页重新请求，不提供缓存/快照。网页变化可能改变分页位置，截断 JSON 不能当成完整 JSON。旧 web 结果当前不参与旧 read 投影，连续联网查询仍可能达到模型请求预算。
- 错误不回传网络异常正文、服务器错误页或凭据；返回 WEB_TIMEOUT、WEB_UNAVAILABLE、WEB_HTTP、WEB_CONTENT_TYPE、WEB_RESPONSE_LIMIT、WEB_REDIRECT_LIMIT、WEB_URL_NOT_ALLOWED、WEB_SEARCH_UNAVAILABLE 等稳定错误。用户取消沿用 CANCELLED，结束当前回合。RSS 格式不符、验证码或页面格式改变都不能伪装成搜索成功。

公开内容以 untrusted=true 和 notice 标注，经关联 tool 结果进入模型历史。内容中的指令不授予权限；查询和 URL 不应包含私人文件或凭据。工具事件继续只记录工具名、ID、成功/失败，execution_report 汇总工具次数，不新增正文日志或伪造访问成功事实。响应中的 retrievedAt 是抓取时间，不能冒充新闻发表时间或天气数据时间。

## Skill 与依赖决策

web-research 指导选源、原文阅读、新闻日期核对、引用与失败说明。weather-lookup 通过通用 fetch 使用 Open-Meteo 地理编码和少量预报字段，核对地点、时区、数据时间和单位；当前值是模型数据，预报不是实测。所有描述仍为模型指导，不保证真实模型总会正确选择或引用。

保留 Node.js 24、pnpm 11.21.0、TypeScript 和 openai SDK。新增并锁定 `htmlparser2@12.0.0`（HTML/XML 实体和结构解析）与 `ipaddr.js@2.5.0`（特殊 IP 范围识别），避免用正则代替 HTML 解析或自行维护不完整地址规则。没有引入浏览器、外部搜索 SDK 或模型供应商内置联网协议。

参考：[Bing RSS 搜索官方说明](https://blogs.bing.com/search/2005/1/RSS-Feeds-for-Search-Results/)、[DuckDuckGo 非 JavaScript 页面](https://duckduckgo.com/duckduckgo-help-pages/features/non-javascript)、[Node 24 HTTP](https://nodejs.org/docs/latest-v24.x/api/http.html)、[htmlparser2](https://github.com/fb55/htmlparser2)、[ipaddr.js](https://github.com/whitequark/ipaddr.js)。公开搜索入口没有本项目可承诺的 SLA；Bing RSS 限个人非商业用途，部署其他用途需选择符合服务条款的搜索来源。

天气参数和用途依据：[Open-Meteo Forecast](https://open-meteo.com/en/docs)、[Geocoding](https://open-meteo.com/en/docs/geocoding-api)、[服务条款](https://open-meteo.com/en/terms)。公开免费接口面向非商业用途，商业使用及限额按服务条款处理。

## 验证边界

自动测试使用虚构模型凭据、注入 DNS/HTTP 及本机临时 HTTP server，不访问外网。覆盖解析、关联结果、权限继承、Skill 加载、Session 保留、CLI 默认与禁用、TUI 状态、公开地址检查、跳转、压缩、上限、取消及脱敏。`pnpm run verify:web` 单独访问固定公开搜索、Node 页面、Berlin 地理编码与天气接口，最多五次工具调用，不调用模型；它不证明模型自主选工具、中文地点消歧、所有搜索结果相关性或所有网络环境可用。
