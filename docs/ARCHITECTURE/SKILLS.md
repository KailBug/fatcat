# Skills：本地发现与按需读取

## 范围与状态

阶段 2D-10 为单个 Session 加入本地 Skills。它复用现有 read、Session 历史和请求预算，不增加模型专用工具或插件运行时。实现与离线验证结果以 [PROGRESS.md](../PROGRESS.md) 为准；没有把新增代码或离线模拟行为视作真实模型选用技能的验证。

格式参考 [Agent Skills specification](https://agentskills.io/specification)，分层加载参考 [官方客户端集成说明](https://agentskills.io/client-implementation/adding-skills-support)。Fatcat 的目录优先级、大小限制和严格校验是本项目选择；不是对所有 Agent Skills 客户端行为的承诺。

## 模块与数据流

`src/skills.ts` 导出 `discoverSkills({ workspace?, userHome?, signal? })`、`withSkills(baseTools, catalog)` 和 `skillCatalogPrompt(catalog)`。`SkillDescriptor` 只含 name、description、uri、scope；`SkillCatalog` 持有 skills、warnings 和按 URI 读取的入口。CLI 启动时发现目录，将 catalog 作为 createAgent 的第四个参数；createAgent 内部包装基础 Tools 并为父子模型添加请求指导。父子模型获得同一元数据目录和读取能力，子任务仍使用独立历史。

启动发现 → 校验各 Skill 的元数据 → 模型请求中提供精简目录 → 模型选择 read → 完整指令作为关联 tool 结果进入本回合 → 成功后保存在 Session 历史。只有已加载的 Skill 正文及实际读取的资源进入消息，不把所有正文预先加入每次请求。

`withSkills` 沿用单个 read 名称；存在工作目录时转发普通路径，无工作目录时只能读取已发现的 `skill://` 路径。基础工具、委派预算、执行记录和取消信号保持原边界。不在 Loop 或 Session 内增加全局已激活技能表。

## 发现与元数据

只扫描下列根目录的一层子目录，优先级从高到低：

1. 显式 `--workspace` 内的 `.fatcat/skills`。
2. 同一工作目录内的 `.agents/skills`。
3. 用户主目录内的 `.fatcat/skills`。
4. 用户主目录内的 `.agents/skills`。

用户主目录默认来自 Node `homedir()`；可通过编程接口 userHome 为离线测试指定临时目录。没有 `--workspace` 时不扫描当前目录或祖先仓库，只发现用户技能。每个根最多 128 个原始条目，超限跳过整个根；最多接受 64 个技能。按稳定顺序发现，同名第一个有效项生效，后续项给出诊断。无效或不可读取的技能不会进入模型目录；诊断不输出文件正文或 YAML 原始异常。

每个技能是包含 `SKILL.md` 的目录。该文件须为有效 UTF-8、最多 32 KiB，具有 `---` 包围的 YAML frontmatter。name 必须为 1–64 个小写 ASCII 字母、数字或连字符，不能有首尾或连续连字符，并与目录名称完全相同；description 必须是非空字符串，最多 1024 字符。拒绝重复键、别名和自定义 YAML 标签。可选字段不赋予额外行为，特别是 allowed-tools 不构成授权。

使用 `yaml@2.9.1` 解析 frontmatter，避免手写解析器对引号、多行和 YAML 结构做不可靠推断；保留现有运行时与包管理器。支持格式的范围由离线测试约束，不自动修复无效 YAML，也不宣称完整兼容其他客户端的扩展字段。

## read 协议与资源

模型目录提供形如 `skill://code-review/SKILL.md` 的 URI。调用：

```json
{"path":"skill://code-review/SKILL.md"}
```

返回 `kind: "skill"`、name、path、baseDirectory 和包含 frontmatter 的完整 content。SKILL.md 不接受 offset、limit 或 query；超限即拒绝，不能把一部分指令当成完整激活。独立的 kind 使旧 read 投影只省略 file / directory / search 数据时保留技能指令。

相对引用以技能根为基准，使用同一 read：

```json
{"path":"skill://code-review/references/checklist.md"}
```

资源文件、目录与 query 沿用普通 read 的分页、文本扩展名、1 MiB 文件上限、16 KiB 页预算及搜索限制，见 [TOOLS.md](TOOLS.md)。资源结果保留原 file / directory / search 类型，较早回合中的资源页仍可被请求投影省略；模型需要时重新读取当前内容。二进制图片、任意扩展名或无限制目录访问不在支持范围。

URI 不接受向上遍历、百分号编码、反斜杠、隐藏路径段或未知技能名。只允许已发现技能目录中的内容；根、祖先及技能路径中的链接/junction，以及 SKILL.md 文件硬链接均拒绝，激活时重新检查。Skill 根下的资源仍通过 workspace 式检查。普通 read 对 `.env`、`.git` 等隐藏路径的拒绝没有放宽。这些是应用层检查，不是对抗恶意并发本机进程的 OS 沙箱。

## 选择、权限与 Session 所有权

模型按描述选择技能并先读取指令；用户可以在普通提示中写 `$code-review` 或按用途提出任务。`$name` 是模型可见的提示约定，当前没有确定性的解析注入或 `/skill-name` 命令。`--listSkills` 是无凭据、无网络的本地目录检查，可结合 `--workspace` 使用。

读取 Skill 只提供任务指导；用户指令、现有授权、预算和取消边界保持有效。元数据不能自动增加工具或预授权。脚本只是可读取资源，不自动执行；若模型另提 shell 命令，仍经过原命令审批与执行限制。用户安装的技能内容及元数据可能发送给当前供应商；应自行选择可用的本地技能。

成功回合保存完整 Skill 结果；失败或取消不保存本轮加载，已有成功历史保持。`/reset` 清除指令历史，固定目录仍在，请求需要时重新读取；写入和命令事实照旧保留。目录在启动后不热刷新，新建或更改元数据后需重启。没有独立激活缓存，重复读取会再次使用当前文件并消耗工具历史与预算。子任务不继承父已加载正文，需要按自己的任务重新加载。

## 验证边界与未实现内容

离线验收覆盖发现、确定优先级、无效 YAML、路径/链接/字节限制、URI 资源读取、无 workspace 的工具暴露、父子目录、失败/reset 与 context 保护。请求预算同时计入目录和已加载正文；指令保留可能使请求继续超限，仍由 MODEL_CONTEXT_LIMIT 结束，不能悄悄删除技能要求。

本轮不实现远程注册表、自动下载安装、插件管理、技能自动执行、热刷新、权限扩展、会话持久化或任务成功率评估。真实模型能否恰当地选择、读取并遵循技能，不能仅由注入模型测试证明。
