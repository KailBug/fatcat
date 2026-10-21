

<a id="configuration-reference"></a>

# 配置参考

[English](../../en/REFERENCE/CONFIGURATION.md) | 简体中文

[文档首页](../README.md) · [快速开始](../QUICK_START.md) · [命令](COMMANDS.md)

配置在启动时读取。`pnpm start` 先从仓库根目录加载 `.env`，再由启动器恢复调用目录。现有环境变量优先于 env 文件。直接运行 `node packages/cli/dist/cli.js` 不会隐式加载它；需要时使用 Node 的 `--env-file-if-exists=.env`，路径相对当前目录解析。

凭据只存于本地环境变量或被忽略的 `.env`，不要把真实密钥复制到 prompt、文档或日志。`pnpm start --checkConfig` 仅验证本地值，不测试账户或联系供应商。更改凭据或端点配置后需重启加载。Web UI 可以在已配置的模型连接之间切换会话选择，见[模型控件](../ARCHITECTURE/WEBUI.md#model-thinking-and-context-controls)。

<a id="providers"></a>

## 供应商

`HARNESS_PROVIDER` 选择 `deepseek`（默认）、`kimi`、`mimo` 或 `qwen`。

| 供应商 | 必需密钥 | 模型变量与默认值 | 地区 |
| --- | --- | --- | --- |
| DeepSeek | `DEEPSEEK_API_KEY` | `DEEPSEEK_MODEL=deepseek-flash` | 无地区选项 |
| Kimi | `MOONSHOT_API_KEY` | `KIMI_MODEL=kimi-k2.6` | `KIMI_REGION=cn`（默认）或 `global` |
| MiMo | `MIMO_API_KEY` | `MIMO_MODEL=mimo-v2.6-flash` | 按量 API，不是 Token Plan |
| Qwen | `DASHSCOPE_API_KEY` | `QWEN_MODEL=qwen-plus` | `QWEN_REGION=cn`（默认）、`intl`、`us`、`eu`、`jp`、`hk` |

`HARNESS_PROVIDER` 选择启动默认供应商，`--checkConfig` 校验该配置。宿主也会读取其他供应商的环境配置并建立 `ModelConnections`；配置无效或缺少凭据的连接不可供切换。不回退到其他供应商密钥或 `OPENAI_API_KEY`。地区密钥必须匹配地区。可选值缺省时使用默认值；选中配置显式为空则无效。校验前会 trim 字段。

Qwen 可选 `QWEN_WORKSPACE_ID`，为小写 DNS 标签（1–63 个字母、数字或连字符，首尾必须是字母/数字）。设置后选择 workspace 专属 PAYG 端点。`cn` 为北京、`intl` 为新加坡、`us` 为弗吉尼亚、`eu` 为法兰克福、`jp` 为东京、`hk` 为香港。不设 workspace ID 时，只有 `cn` 和 `intl` 可用已有 DashScope 端点。凭据必须属于选定 workspace 和地区；应用不会探测或回退到其他端点。Workspace 标识为公开配置，不是凭据。保留现有配置时不设置此变量；显式空值无效。

当前 Qwen 备选包括 `qwen3.8-max`、`qwen3.8-flash`、`qwen3.7-plus`，现有启动默认值不变。Kimi K3 和 K2.7 Code 已支持主 Agent 执行与会话推理历史回放。无状态文档请求使用模型的强制思考协议。目录不保证账户权限、地区模型可用性或在线验证。

共享 OpenAI-compatible 客户端使用非流式 Chat Completions。新会话采用目录默认思考策略：支持 medium 时优先 medium，仅支持 off/on 时默认 on，其他采用型号明确默认值或 off。显式 Config.thinking 与已保存的会话选择优先。精确端点、请求字段、模型版本、图片能力、退役通知和订阅专用入口见[供应商架构](../ARCHITECTURE/PROVIDERS.md)。协议检查使用假凭据和注入 transport，不证明真实账户访问或任务质量。已有真实模型验证脚本仍专用于 DeepSeek。

<a id="request-budgets"></a>

## 请求预算

| 变量 | 未设置时运行时默认值 | 接受值 / 用途 |
| --- | --- | --- |
| `HARNESS_MAX_ITERATIONS` | `32` | 正十进制安全整数；每回合父请求额度 |
| `HARNESS_REQUEST_TIMEOUT_MS` | `60000` | 不超过 2147483647 的正整数；请求超时毫秒 |
| `HARNESS_MAX_REQUEST_BYTES` | `262144` | 不超过 16777216 的正整数；序列化模型请求体字节 |
| `HARNESS_AUTO_COMPACT` | `true` | `true` 或 `false`；本地请求溢出后一次有界自动历史压缩恢复 |

仓库 [.env.example](../../../.env.example) 显式设置 `HARNESS_MAX_ITERATIONS=128`，复制它即选择 128，不改变运行时缺省默认值。无效、空或越界值会使配置校验失败。

请求字节不是供应商 token。系统指导、工具、历史、journal 和视觉载荷都计入序列化请求。较旧成功读取的载荷可用显式标记省略，完整保存历史仍保留。[上下文管理](../GUIDES/SESSIONS.md#context-management)说明进一步压缩及仍会失败的情况。委派有自己的有界请求，总供应商调用数可超过父迭代额度。

<a id="automation-json"></a>

## 自动任务 JSON

`--automation <path>` 加载选定工作区内的 UTF-8 JSON，即使 Free to go 也如此。配置文件适用普通 1 MiB 文本文件限制；监控路径相对工作区，不是配置目录。各层均拒绝未知字段。`--check-automation` 验证配置和监控路径，不联系模型。可运行示例和进程生命周期见[自动任务指南](../GUIDES/AUTOMATION.md#standalone-json-runner)。

| 顶层字段 | 必需 / 默认 | 契约 |
| --- | --- | --- |
| `version` | 必需 | 必须为 `1` |
| `maxRuns` | `20` | 整数 1–1000；所有任务的触发尝试总数 |
| `maxRuntimeSeconds` | `86400` | 整数 1–604800；整体运行寿命，含执行中工作 |
| `tasks` | 必需 | 1–32 个任务对象 |

| 任务字段 | 必需 / 默认 | 契约 |
| --- | --- | --- |
| `id` | 必需 | 唯一，1–64 字符；ASCII 字母/数字开头，后续为字母、数字、`_` 或 `-` |
| `prompt` | 必需 | 非空白，最多 16000 个 UTF-16 代码单元 |
| `trigger` | 必需 | 以下对象之一 |
| `maxRuns` | `20` | 整数 1–1000；单任务尝试数，同时受总上限限制 |

每种触发器必须有 `type`，只接受该类型的字段：

| `type` | 字段 |
| --- | --- |
| `interval` | 必需 `seconds`：整数 60–604800；首次触发在一个间隔后 |
| `at` | 必需 `time`：真实 ISO 日期/时间，含秒和 `Z` 或数字偏移；可选毫秒必须恰好三位 |
| `cron` | 必需 `expression`：最多 256 字符，五个数字字段（分钟/小时/日/月/星期）；可选 `timezone`：`local`（默认）或 `UTC` |
| `file_changed` | 必需 `paths`：1–32 个唯一、明确的工作区相对文本路径，每个最多 512 字符；可选 `debounceMs`：整数 1000–60000，默认 1000 |

Cron 支持 `*`、列表、范围和步长；星期日为 0 或 7，日期与星期同时受限时按 OR 匹配。不支持名称、秒字段或具名 IANA 时区。配置总共最多监控 64 个不同文件，见[文件变化限制](../GUIDES/AUTOMATION.md#file-change-triggers)。

独立运行器启动时已过期的一次性时间跳过，超出运行寿命的时间不会触发。失败触发同时消耗两种尝试额度，重启重置独立计数。绑定会话任务复用触发 schema，但 ID 自动生成，并有持久化的尝试数/过期时间；其一次性时间必须在未来且早于过期。通过对话或 UI 创建，不通过编辑此 JSON 创建。

<a id="local-storage-and-interface-settings"></a>

## 本地存储与界面设置

| 变量 | 用途 |
| --- | --- |
| `FATCAT_SESSION_DIR` | 覆盖用户主目录默认 `.fatcat/sessions` 存储根目录，含项目/资料/Memory 状态 |
| `FATCAT_WEBUI_OPEN_BROWSER=0` | 禁止自动打开 Web UI 启动链接 |
| `FATCAT_VERIFY_SCREENSHOTS` | 将 `verify:webui` 与 `verify:webui-models` 截图保留在指定目录 |
| `NO_COLOR` | 禁用 TUI 颜色，不改变模型行为 |

pnpm start 启动器使用 `INIT_CWD` 在仓库根构建并加载 env 文件后恢复调用目录，直接 CLI 执行忽略它。目录变更和明文保留限制见[会话](../GUIDES/SESSIONS.md#storage-and-recovery)；仅验证使用的设置见[开发指南](../DEVELOPMENT.md)。
