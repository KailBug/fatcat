

<a id="command-reference"></a>

# 命令参考

[English](../../en/REFERENCE/COMMANDS.md) | 简体中文

[文档首页](../README.md) · [配置](CONFIGURATION.md) · [快速开始](../QUICK_START.md)

<a id="startup-flags"></a>

## 启动参数

运行 `pnpm start --help` 查看当前 checkout 的帮助。`pnpm start` 先构建；以下命令假定从仓库根目录运行。

| 参数 | 含义 |
| --- | --- |
| `--help`、`-h` | 无需模型凭据打印帮助；无参数也打印帮助 |
| `--version`、`-v` | 打印包版本，无需凭据，不创建会话 |
| `--checkConfig` | 验证本地供应商配置，不请求供应商 |
| `--prompt <text>` 或位置文本 | 执行单次任务 |
| `--chat` | 连续终端对话 |
| `--tui` | 交互式终端 UI，要求终端 |
| `--webui` | 本地浏览器 UI |
| `--port <number>` | Web UI 端口，1–65535；默认 `127.0.0.1` 的 3210 |
| `--workspace <directory>` | 选择任务工作区；相对路径基于启动目录 |
| `--continue`、`-c` | 继续选定存储中的最近会话 |
| `--resume [id-or-name]`、`-r` | 恢复会话；没有选择值时显示选择器/列表 |
| `--name <name>`、`-n` | 为选定/新会话命名 |
| `--project <id-or-name>` | 在已有项目中新建会话 |
| `--fork-session` | 从 continue/resume 选中的已完成历史分支 |
| `--no-session-persistence` | 新运行仅保留在内存 |
| `--permission-mode <mode>` | 选择下述组合权限模式 |
| `--permission <policy>` | 旧文件策略：`ask`、`read-only`、`workspace-write` |
| `--shell-permission <policy>` | 旧命令策略：`ask`、`deny`、`allow` |
| `--web-permission <policy>` | Web 工具 `allow`（默认）或 `deny` |
| `--automation <path>` | 运行独立自动任务配置 |
| `--check-automation` | 无需模型凭据验证该配置 |

<a id="startup-combinations"></a>

## 启动组合

- 只能选择一种模式：帮助、版本、配置检查、chat、TUI、Web UI、自动任务或单次任务。`--prompt` 不能与位置 prompt 文本合用。
- 没有其他模式或 prompt 时，会话选择/命名/项目参数隐式选择 chat。`--continue` 与 `--resume` 互斥；`--fork-session` 要求其中之一。
- `--no-session-persistence` 不能与 resume、continue、fork 或项目选择合用。名称不能为空。
- `--project` 不能与 resume/continue 合用。显式工作区必须与项目目录一致；项目会话不能单独覆盖。
- `--workspace` 和权限参数要求执行模式。`--port` 要求 Web UI，`--check-automation` 要求 `--automation`。
- 独立自动任务要求全新的持久化会话，不能与选择、命名、项目、fork 或不持久化选项合用。
- `--permission-mode` 不能与 `--permission` 或 `--shell-permission` 合用。Free to go 不能与 web deny 合用。Read-only 若指定 Shell 策略，只能为 deny。

不存在启动 `--skills`、`--sessions` 或 `--subagent` 开关。使用 chat/TUI 的目录/列表命令及普通任务驱动的委派。

没有选择值的 `--resume` 在 stdin 或 stderr 不是终端时列出已保存会话并退出，无需模型凭据。交互式终端中询问 ID/名称，`/exit` 取消选择。列出会话或显示帮助前仍检查参数组合错误。TUI 要求终端 stdin/stdout，拒绝 `TERM=dumb`。解析和启动顺序的维护要求见[开发指南](../DEVELOPMENT.md)。

<a id="permission-modes"></a>

## 权限模式

| 模式 / Web UI 标签 | 受控文件修改 | 命令 | 文件与 HTTP(S) 范围 |
| --- | --- | --- | --- |
| `default` / Manual | 每次询问 | 每次询问 | 工作区 / 公网 |
| `acceptEdits` / Accept edits | 自动工作区写入 | 每次询问 | 工作区 / 公网 |
| `plan` / Plan | 拒绝 | 拒绝 | 工作区读取 / 公网研究 |
| `freeToGo` / Free to go | 扩大本地访问范围后自动写入 | 普通可识别命令自动；危险或不透明形式询问 | 工作区外本地访问 / 允许私有地址和自定义端口 |

旧参数默认 `--permission ask` 和 `--shell-permission ask`。`workspace-write` 仅预授权写入；`read-only` 同时禁止命令；`--shell-permission allow` 预授权命令。Web deny 禁用研究工具，不阻止 Shell 联网。

Web UI 可在空闲时切换模式。显式 read-only、shell-deny 或 web-deny 启动限制仍为上限；仅以 `--permission-mode plan` 启动允许后续切换。会话历史和 Skills 不能恢复或授予审批。

Shell 执行不受 OS 沙箱隔离。Free to go 命令风险检查是启发式，不能证明构建脚本或可执行程序安全。受控浏览器始终留在工作区内并遵循 Shell 权限；Plan/read-only/shell-deny 禁止执行。Memory 元数据操作在 Plan/read-only 下仍可用，不授予文件访问。见[权限架构](../ARCHITECTURE/PERMISSIONS.md)。

<a id="chat-and-tui-commands"></a>

## Chat 与 TUI 命令

每条命令独占一行。除明确标为模型工作的命令外，都在本地执行；它们不是通用 Shell 命令。Web UI 通过会话/项目/资料/自动任务控件操作，不暴露全部终端命令；输入框也接受下述上下文和 Memory 命令。

| 命令 | 效果 |
| --- | --- |
| `/help`、`/exit` | 显示命令；退出 |
| `/status`（仅 TUI） | 显示完整配置和指标定义 |
| `/new [--standalone] [name]` | 保留旧会话并新建，可选离开项目作用域 |
| `/clear`、`/reset` | 在当前作用域新建会话 |
| `/sessions`、`/resume [id-or-name]` | 列出或切换已保存会话；无参数 resume 列表 |
| `/rename <name>`、`/fork [name]` | 重命名；从已完成历史分支 |
| `/workspace [path]` | 显示/修改独立会话工作区 |
| `/projects`、`/project` | 列出项目；显示当前作用域 |
| `/project create "name" "directory"` | 围绕已有目录创建项目 |
| `/project use <id-or-name>` | 新建项目会话 |
| `/project join <id-or-name>` | 预览将当前私有会话及资料移入项目 |
| `/project confirm <token>`、`/project cancel` | 确认/取消该预览 |
| `/attachments`、`/attach "path"` | 列出作用域资料；导入允许的文件 |
| `/attachment remove <reference>` | 移除当前作用域关联 |
| `/attachment delete <reference> [--confirm]` | 预览/确认符合条件的永久删除 |
| `/skills` | 列出已发现 Skill 元数据 |
| `/cron [list]` | 列出会话绑定任务 |
| `/cron pause <id>`、`/cron resume <id>`、`/cron delete <id>` | 管理任务 |
| `/cron <description>` | 向模型发送调度请求 |

切换会话保留已完成文件/命令效果及进程 journal。项目迁入经确认后共享私有附件和 Memory。破坏性管理操作前阅读[会话](../GUIDES/SESSIONS.md)、[资料](../GUIDES/MATERIALS.md)和[自动任务](../GUIDES/AUTOMATION.md)。

<a id="context-commands"></a>

## 上下文命令

Chat、TUI 和 Web UI 输入框可用：

| 命令 | 效果 |
| --- | --- |
| `/context` | 本地对话字节/消息数，不是 token usage |
| `/compact [focus]` | 模型生成较旧已完成回合摘要；focus 最多 2048 UTF-8 字节 |

自动恢复、预算和取消见[上下文管理](../GUIDES/SESSIONS.md#context-management)。

<a id="memory-commands"></a>

## Memory 命令

Chat、TUI 和 Web UI 输入框可用，也支持自然语言记忆。

| 命令 | 效果 |
| --- | --- |
| `/memory [list]` | 列出当前作用域 Memory |
| `/memory show <id>` | 检查记录及修订 |
| `/memory add session\|project\|global <text>` | 显式保存到选定作用域 |
| `/memory update <id> <revision> <text>` | 替换当前修订 |
| `/memory delete <id> <revision>` | 使用当前修订删除 |

只选择一个作用域值，不要输入字面的竖线分隔备选。见 [Memory 操作与限制](../GUIDES/MATERIALS.md#remember-facts-across-conversations)。

<a id="exit-status-and-output"></a>

## 退出状态与输出

| 代码 | 含义 |
| --- | --- |
| 0 | 任务成功/正常退出、帮助、配置有效；自动任务也可能在有失败尝试时耗尽预算 |
| 1 | 配置、模型、协议或预算失败；chat/TUI 可因之前失败回合返回失败 |
| 2 | 用法错误或空任务 |
| 130 | 界面退出时的取消 |

任务回答到 stdout，事件、执行报告和审批提示到 stderr。`pnpm start` 还输出包/构建信息。自动任务需检查逐次 JSON 结果，不能只看进程退出码。TUI 取消后可保持界面打开；之后正常退出不会抹去失败/取消回合。见[界面操作](../GUIDES/INTERFACES.md)。
