

<a id="sessions-projects-and-context"></a>

# 会话、项目与上下文

[English](../../en/GUIDES/SESSIONS.md) | 简体中文

[文档首页](../README.md) · [命令参考](../REFERENCE/COMMANDS.md)

<a id="continue-a-conversation"></a>

## 继续对话

```powershell
pnpm start --chat --name review
pnpm start --continue
pnpm start --resume review
pnpm start --resume review --fork-session --name alternative
```

`--continue` 从选定存储的所有工作区桶中选择最近更新的会话。`--resume` 按 ID 或名称选择；名称有歧义时使用 ID。没有其他模式或 prompt 时，会话选择参数启动 chat。单独 `--resume` 提供终端选择器，输出重定向时提供列表，无需模型凭据；真正启动 chat/TUI 仍需已配置凭据。

Chat/TUI 中，`/sessions` 列出已保存会话，`/resume <id-or-name>` 切换，`/rename <name>` 命名，`/fork [name]` 从已完成历史分支。`/new [name]`、`/clear`、`/reset` 保留旧会话并新建会话。在项目内，新会话仍属于该项目；`/new --standalone [name]` 离开该作用域。

Fork 是对话分支，不是 Git 分支或文件复制。它复制已完成历史和附件关联，不复制私有 Memory 或自动任务。项目 fork 继续使用共享项目资料和 Memory。切换会话不会撤销工具效果，也不会清空工作区缓存的 journal 或进程遥测。会话消费单独计量：resume 恢复该会话保存的累计值和观测；fork 保留模型选择，但重新开始累计且不继承最近请求观测。

不需保存的运行可加 `--no-session-persistence`，但不能通过启动参数恢复、fork 或加入项目。见[启动组合](../REFERENCE/COMMANDS.md#startup-combinations)。

<a id="web-ui-drafts"></a>

## Web UI 草稿

新建未命名的 Web UI 聊天在浏览资料、检查 Memory/上下文或修改目录/项目绑定时保持未保存。普通任务在执行前保存它；接受附件、命名、fork 或创建自动任务也会保存它。本地 Memory 修改命令在修改记录前先保存来源会话，因此修改失败仍可能留下已保存的空聊天。使用 `--no-session-persistence` 时，这些状态仅保留在内存。

<a id="select-or-change-a-workspace"></a>

## 选择或修改工作区

新的独立会话默认使用启动目录，可由 `--workspace <directory>` 覆盖。恢复会话还原其目录。相对启动路径基于启动目录解析。

```text
/workspace
/workspace "D:\work\example"
```

Chat/TUI 中，第一条显示当前目录，第二条修改独立会话目录。相对变更基于当前工作区解析。无效路径不改变已有工作区。Web UI 在路径控件和会话菜单提供 **Change workspace**，通过原生 Windows 目录选择器操作；要求交互式桌面，取消或选择器过期均不改变会话。

修改目录保留历史、文件和最初的会话存储桶，不移动文件、不重置工具 journal、不合并会话。项目会话使用共享项目目录，不能单独覆盖。

<a id="share-a-project"></a>

## 共享项目

Project 将独立对话组织到同一工作目录、共享附件和共享 Memory 下。相同目录中的会话不会自动成为项目，也不共享历史。

```text
/project create "Example" "D:\work\example"
/projects
/project use Example
/project
```

创建要求目录已存在，不切换当前会话。`use` 新建项目会话。启动时可用 `pnpm start --chat --project Example` 选择已有项目。Web UI 侧栏支持创建、分组聊天和项目管理。

将独立会话移入项目：

```text
/project join Example
/project confirm <token-from-preview>
```

确认前审阅预览，也可用 `/project cancel` 取消。现有私有附件关联和活跃私有 Memory 将变为项目共享。历史仍然独立；工作区文件和旧来源路径不移动。现有自动任务暂停供复核。若会话、项目或资料变化，陈旧确认会被拒绝，应重新请求预览。

Web UI 的 **Move to project** 和拖放使用相同确认。项目重命名、修改目录和删除属于 Web UI 管理操作。修改项目目录影响所有成员，但不移动文件。删除项目会移除成员会话、任务和符合条件的未引用资料，保留工作区文件及仍被其他地方引用的原件。目前没有脱离项目或跨项目迁移操作。见[项目架构](../ARCHITECTURE/PROJECTS.md)。

<a id="context-management"></a>

## 上下文管理

在 chat、TUI 或 Web UI 输入框中：

```text
/context
/compact Preserve the API constraints and remaining test failures.
```

`/context` 在本地报告完整历史/投影对话的 JSON 字节和消息数，不含动态指导、工具定义与执行 journal，也不是 token 计量。

`/compact [focus]` 使用当前模型摘要较旧的已完成回合，保留最近一个已完成回合及全部原始历史。Focus 上限为 2048 UTF-8 字节。摘要最多请求 `min(HARNESS_MAX_ITERATIONS, 8)` 次，遵守相同请求字节限制。摘要有损，必要时应重新读取当前文件和加载 Skills。

自动压缩默认启用。省略旧读取后仍不能满足本地请求字节预算时，Fatcat 可对符合条件的较旧历史压缩一次，然后继续同一回合。被拒绝的尝试、摘要和续跑共用该回合请求额度，不重放已执行工具。供应商 HTTP 错误、超时或 token 阈值不会触发该恢复。设置 `HARNESS_AUTO_COMPACT=false` 可只使用手动压缩。

过小请求预算、单个过大最近回合或过大 journal 仍可能阻止续跑。后续工作失败时仍报告摘要 usage。成功摘要先保存再续跑，续跑取消也保留摘要。取消/无效摘要或保存失败保留之前投影。完整历史仍计入会话文件上限。见[上下文架构](../ARCHITECTURE/CONTEXT.md)。

<a id="storage-and-recovery"></a>

## 存储与恢复

会话默认位于用户 `.fatcat/sessions`，按工作区分桶。`FATCAT_SESSION_DIR` 覆盖存储根目录，也涵盖项目和共享资料状态。列表覆盖该存储全部桶。会话文件上限 64 MiB，明文包含 prompt、工具结果和已加载 Skill 正文。权限及供应商凭据不从历史恢复；避免将秘密写入对话。

Resume 使用当前宿主凭据和权限，并恢复保存的模型与思考选择。仅未保存模型选择的记录使用启动默认值。保存的连接不可用时不会静默回退：历史仍可阅读，但执行要求连接可用或显式切换模型。不自动重放中断操作。阅读警告、检查当前文件/进程后再决定如何继续。Revision 冲突或其他进程的 running claim 可拒绝写入；不要覆盖竞争会话文件。崩溃后删除陈旧锁前，先检查报告的锁和所有者 PID。

仅支持当前 v4 会话格式。更早格式不加载、不迁移，其文件不会自动重写或删除。避免不同版本混合写入。删除会话不恢复工作区文件，可能留下未引用附件原件，也没有自动保留期清理。见[会话架构](../ARCHITECTURE/SESSION.md)与[资料生命周期](MATERIALS.md#remove-materials)。
