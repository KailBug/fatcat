

<a id="permissions-policy-approvals-and-execution-guards"></a>

# Permissions：策略、审批与执行防护

[English](../../en/ARCHITECTURE/PERMISSIONS.md) | 简体中文

[架构总览](README.md) · [权限模式参考](../REFERENCE/COMMANDS.md#permission-modes)

权限由运行时实施，模型提示只解释当前能力。CLI、TUI、Web UI 和父子任务共用策略，保存历史、Skills、Memory 或工具内容不能授予权限。

<a id="module-responsibilities"></a>

## 模块职责

| 源码 | 职责 |
| --- | --- |
| `packages/runtime/src/permissions/types.ts`、`policy.ts` | 模式、低层策略、启动上限、操作快照和忙碌锁 |
| `packages/runtime/src/permissions/approval.ts` | 唯一待批项、唯一 ID、一次决定及取消收尾 |
| `packages/cli/src/permissions/terminal.ts` | 审批适配与控制字符转义 |
| `packages/runtime/src/permissions/workspace.ts`、`text-file.ts` | 规范路径、模式范围、文件身份和有界文本读取 |
| `packages/runtime/src/permissions/command-risk.ts` | Free to go 的有界词法风险分类 |
| `packages/runtime/src/permissions/web-request.ts`、`browser.ts` | HTTP 地址/下载防护与浏览器审批/本地资源校验 |

工具协议和操作 journal 仍归 Tools，界面只提交模式选择或单次决定。

Shell 进程执行归 `packages/runtime/src/tools/shell/`，包含独立的 Bash、PowerShell 执行器以及共享结果类型和输出上限。执行器不授权命令；`tools/shell.ts` 在调用前应用权限策略并完成审批。生命周期与清理的职责见 [shell 执行边界](TOOLS.md#shell-execution-boundaries)。

<a id="policy-and-access-scope"></a>

## 策略与访问范围

Manual 逐次批准写入和命令；Accept edits 自动允许受控文件修改；Plan 禁止普通文件写入与命令。三者保持工作区和公共 HTTP(S) 边界，Plan 仍可公开研究。Free to go 扩展本地路径及 HTTP(S) 地址范围，普通识别命令自动、危险或不透明命令审批。

普通文件范围拒绝父路径跳转、绝对/设备路径、点开头名称、node_modules、符号链接/junction 和特殊文件；逐级 lstat、realpath 与打开后的类型/dev/ino/链接计数复核。名称隐藏规则不等同于 Windows 隐藏属性。Free 允许工作区外、隐藏、依赖、链接和其他文本扩展名，使用规范绝对路径并去重搜索，仍要求常规文件/目录并保留编码、大小与冲突检查；不能据此推断它沿用普通模式的名称白名单。

旧 permission/shell-permission 组合不会隐式选择 Free。Web deny 独立禁用研究工具，不是 shell 网络防火墙。受控 browser 在所有模式始终限制在工作区，不能随 Free 扩展；其权限归 [Browser](BROWSER.md)。

Memory 写入是有当前用户证据及身份校验的会话元数据操作，Plan/read-only 不禁用它；这不授予普通文件写权限，见 [Memory](MEMORY.md)。

<a id="switching-and-one-time-approval"></a>

## 切换与一次性审批

每次工具执行取得策略快照并持有操作锁，覆盖校验、审批、执行与收尾，防止中途切换范围。Web UI 仅在空闲时切换，同一服务所有标签共用策略；不重建 Tools、Session 或 journal。

显式启动 read-only、shell-deny、web-deny 是不可被网页菜单放宽的上限；起始 plan 模式本身不是永久上限。参数组合规则集中在命令参考。权限与批准只存在当前进程，恢复会话使用当前配置，不恢复旧决定。

ApprovalCoordinator 最多一个待批项。取消、EOF、停止或关闭拒绝待批操作；旧 ID、重复答复和已切换状态不能授权另一动作。文件批准后复查身份/内容，命令批准后复查 cwd。审批展示不得省略命令主体或让控制字符伪装内容。

<a id="free-to-go-command-risk-classification"></a>

## Free to go 的命令风险判断

分类器检查有界 PowerShell 词法、命令名、引号、管道及嵌套形式，不请求模型或外部服务。删除/格式化、危险 Git、存储/安全配置、下载后执行、嵌套解释器、编码/计算命令和未知脚本等要求单次审批。approvalReason 由工具产生，模型不能传入伪造。

Linux 评估执行器不会把该分类器用于 Bash 语法。Free to go 下每条 Bash 命令都需要审批回调，没有回调则在启动前失败。显式 workspace-write/shell-allow 保留文件工具的工作区范围及独立 shell 授权。eval 无界面入口只接受明确的允许/拒绝策略，不等待交互审批；委派工作继承同一运行时策略。

即使低层 shellPermission=allow，Free 的风险命令仍须回调批准；无交互不能自动通过。旧显式 shell-allow 保留兼容行为，不因此获得 Free 的文件/网络范围。

这不是完整 PowerShell AST、安全证明或 OS 沙箱。允许的构建、测试、hooks、可执行文件或模块仍能运行任意代码。环境过滤、路径检查和浏览器路由也不能抵御恶意本机进程或限制当前账户的全部权限。

<a id="verification-and-unimplemented-scope"></a>

## 验证与未实现范围

检查启动上限、空闲切换、操作锁、父子共享、拒绝/取消/重放、路径竞态、DNS/重定向和原入口组合。UI 检查涵盖审批、断连与窄屏；使用注入模型不代表真实模型会始终遵循指导。

未实现 OS 级文件/进程沙箱、模型自动审批、用户规则列表或自动从 Plan 开始实施。新增权限必须覆盖实际执行入口，不能仅修改提示词或界面。
