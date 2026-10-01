# 权限模式、审批与工具安全

## 已实现范围

`src/permissions/` 与 `src/session/` 同级，集中权限类型、运行时模式、单次审批和共用执行安全规则。CLI、chat、TUI 和本地 Web UI 复用同一 Tools；父子任务没有独立授权。验证结果见 [PROGRESS.md](../PROGRESS.md)。

前三种基础模式参考 [Claude Code 官方权限文档](https://code.claude.com/docs/en/permission-modes)；按用户要求增加 Fatcat 的 Free to go，共四个选择：

| 参数值 / 网页名称 | 文件修改 | PowerShell | 目的 |
| --- | --- | --- | --- |
| `default` / Manual | 每次审批 | 每次审批 | 查看具体操作后决定 |
| `acceptEdits` / Accept edits | 自动允许受控 write | 每次审批 | 减少编码过程中的文件确认 |
| `plan` / Plan | 禁止 | 禁止 | 阅读和提出方案，切换模式后再实施 |
| `freeToGo` / Free to go | 自动允许本地文本读写，包含工作区外 | 普通命令自动；危险或不透明命令审批 | 以当前用户权限执行本地开发任务，开放 HTTP(S) 地址范围 |

Manual、Accept edits、Plan 保留原工作区及 Skill 目录边界、公开 HTTP(S) 地址与标准端口限制。Plan 不隐式关闭公开研究，仍禁止全部命令；Accept edits 不自动批准 shell 中的文件操作。Free to go 的 read/write/shell cwd 可使用工作区外绝对或相对路径，允许隐藏条目、依赖目录、链接及任意文本扩展名；web 可访问环回、局域网、自定义端口及其他 HTTP(S) 地址。它不授予 Windows 用户原本没有的系统权限，也不增加二进制编辑或非 HTTP(S) 网络协议。

各模式仍保留 UTF-8、文件/下载/输出大小、请求预算、期限、取消、文件身份和写入冲突检查。Free 的链接按 realpath 定位，工具结果和 journals 使用规范绝对路径，搜索对规范目录/文件去重避免链接循环。新建不覆盖已有文件，编辑仍要求唯一精确片段。Skill URI 及资源协议保留既有校验。

## 模块边界

| 模块 | 实际职责 |
| --- | --- |
| `src/permissions/types.ts` | 权限模式、低层权限、启动上限、写入/命令请求和审批回调类型 |
| `src/permissions/policy.ts` | PermissionPolicy、旧权限组合映射、可选模式、启动限制、授权判断和执行期间的权限锁 |
| `src/permissions/approval.ts` | ApprovalCoordinator：最多一个待批操作、唯一 ID、一次决定、取消和拒绝收尾 |
| `src/permissions/terminal.ts` | 终端审批适配器及安全预览：转义控制字符、有界文件内容、完整命令 |
| `src/permissions/workspace.ts` | 固定规范工作区及动态文件范围；默认名称/链接限制，Free 本地 realpath 定位 |
| `src/permissions/text-file.ts` | 有界 UTF-8 读取、默认扩展名规则及各模式的文件身份复查 |
| `src/permissions/command-risk.ts` | 有界 PowerShell 词法风险检查，返回危险/不透明命令的一次审批原因 |
| `src/permissions/process.ts` | 原生 PowerShell 环境白名单、有限输出、期限、取消与进程树清理 |
| `src/permissions/web-request.ts` | 按模式验证 HTTP(S) 地址和 DNS；固定连接 IP、重定向复查、有界下载与解压 |

工具的参数协议、实际读写/命令结果及 journals 留在 `src/tools/`；写入暂存/发布与冲突核对属于具体文件操作。终端输入、TUI 编辑器、浏览器选择器及审批内容展示留在各交互入口。交互只提交选择或一次决定，不能绕过工具的路径、编码、取消、预算和副作用检查。

## 运行状态与数据流

CLI 的 `--permission-mode` 可用于任务、chat、TUI、Web UI；不与 `--permission` / `--shell-permission` 混用。没有该选项时原启动方式保持：默认 ask/ask；旧参数可继续设置特殊组合，非三种原标准组合在网页标注 Custom permissions。旧 workspace-write/allow 组合不会推断成 Free，仍使用工作区/公共网络范围；只有显式选择 `freeToGo` 才扩展范围并执行危险命令检查。

Web UI 启动创建一个 PermissionPolicy，传入 createTools 第六个可选参数，并注入同一个控制器。`POST /api/permission-mode` 仅接受一个有效 mode 字段，沿用 capability、Host、Origin 和请求大小校验。控制器在活动回合、审批、会话管理或关闭期间拒绝切换；页面在相同条件及断连/提交期间禁用选择器。切换影响所有标签，下一次工具调用读取同一策略，不重建 Tools、Session 或 journals。

启动时显式 `--permission read-only` / `--shell-permission deny` 成为网页切换上限，不会被菜单放宽。`--web-permission deny` 禁用 web 并排除 Free；与 `--permission-mode freeToGo` 混用在配置前报用法错误。`--permission-mode plan` 只是起始模式，空闲后可切换到其他可用模式。每次 read/search/write/shell/web 从策略取得操作快照并锁住选择，直到校验、审批、执行及收尾结束，避免检查和执行期间更换访问范围。

父子模型每次请求取得当前模式及有效权限，Plan 附加只读方案指导，Free 说明工作区外路径、网络范围和命令审批。指导仅用于请求副本，不进入成功历史；执行安全不依靠模型服从文字。Skills、用户聊天内容和恢复历史均不能选择模式或批准操作。

Web UI、TUI 和终端通过共用审批协调器结束一次请求；界面仍检查是否处于有效交互和活动回合。取消、EOF、停止或关闭会拒绝待批操作；旧 ID 和重复答案不能批准后续操作。文件批准后仍复查实际文件身份和内容，命令批准后仍复查 cwd，保持原冲突、输出及清理规则。

权限选择和待批操作仅在当前进程内。新建/切换/恢复会话保持当前策略，重启使用本次启动设置，不保存或恢复旧批准。模式不撤销已经发生的文件修改或命令。PowerShell 继续以当前 Windows 用户权限执行，可访问工作区外及网络；这里的模式不是 OS 沙箱。

## Free to go 的命令审批

`classifyCommandRisk` 在 cwd 检查及进程启动前分析最多 4000 字符的命令，不请求模型、网络或外部扫描器。识别词法引号/转义/注释、管道/分号和命令名称，覆盖删除/清空文件与注册表、格式化/分区、强制 Git 清理/重置/推送、关闭安全控制与系统服务等已知命令。下载内容交给 Invoke-Expression、嵌套解释器、编码执行、计算命令、未知脚本/可执行工具及不能可靠解释的语法要求审批。普通 pnpm 构建/测试、Git 查询和文件读取等识别命令自动运行。

风险理由由工具产生为 `ShellRequest.approvalReason`，模型不能自行提交这个字段。即使当前 shellPermission=allow，风险命令仍必须通过现有一次性 approve 回调；无交互、拒绝、取消、旧 ID 或缺少回调均不会启动进程或建立执行记录。终端/TUI/网页展示完整命令、cwd、期限和英文原因；终端无交互时不建议用旧 allow 参数绕开保护。

这是保守启发式，不是完整 PowerShell AST 或系统沙箱。允许的包脚本、测试、构建工具、Git hooks、被替换的可执行文件以及工具内部副作用仍可能执行任意操作；名称识别不能证明它们安全。未知或不透明命令的审批比已知普通命令更保守。当前没有模型 Auto 审查、用户规则列表、自动计划实施或后台执行；Plan 不因存在此分类器而自动开放命令。

## 验证与限制

离线测试使用虚构凭据和注入模型/网络，检查实际临时文件、父子共享、授权切换、启动上限、忙碌拒绝、审批取消/重放、路径边界和原入口回归。浏览器检查桌面/窄屏/深色、菜单键盘与断连状态；具体已通过内容以 PROGRESS 为准。没有把模拟模型验证当作真实模型验收，没有引入新依赖或修改锁文件。
