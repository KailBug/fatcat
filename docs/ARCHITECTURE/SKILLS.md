# Skills：发现、指导与按需读取

[架构总览](README.md) · [使用与编写](../GUIDES/SKILLS.md)

Skills 是本地任务指导，不是权限系统、插件运行时或确定性工作流。模型先看到元数据，按任务读取正文；内置 Skill 清单在操作指南维护。

## 模块与构建

`src/skills.ts` 负责 discoverSkills、元数据校验、目录指导及受控 read 包装。内置源在 `src/skill/<subsystem>/<name>/SKILL.md`；`scripts/copy-skills.ts` 校验并复制构建资源，运行时按模块相对路径定位，不依赖 cwd。

`src/agent.ts` 的 workspaceAgentFactory 在目录选择时重新发现；即使复用基础 Tools，也会刷新 Skill catalog 并重新装配 Agent，见 [装配边界](AGENT_LOOP.md)。普通运行没有文件热监听。metadata 修改后重启确保刷新，内置改动还须重新构建。没有独立“激活”缓存；重复 read 使用当前文件并消耗上下文预算。

## 发现与命名

优先级为 workspace 的 .fatcat/skills、.agents/skills，随后 user home 的同名根，最后内置 catalog。同名第一个有效项生效；不扫描祖先目录。程序化未提供 workspace 时不自行选择 cwd。

工作区/用户根扫描一层，内置扫描 subsystem/name 两层；每个扫描目录最多 128 个原始条目，整个 catalog 最多 64 项。顺序稳定，坏条目给安全诊断，不输出 YAML 原文或异常。

SKILL.md 要求有效 UTF-8、最多 32 KiB 和 YAML frontmatter。name 与目录匹配，1–64 个小写 ASCII 字母/数字/单连字符；description 非空、最多 1024 字符。拒绝重复键、别名、自定义标签；allowed-tools 等字段不授予行为。采用 yaml 解析器是为可靠处理引号、多行和结构，不声称兼容其他客户端全部扩展。

## 通用 read 协议

所有来源使用 skill://name/SKILL.md，subsystem 只是组织信息，不进入 URI。正文返回 kind=skill、name、path、baseDirectory 与完整 content；禁止 offset/limit/query，不能把截断指令当完整加载。

资源使用 skill://name/relative-path，按技能根解析并复用普通文件/目录/搜索分页与限制。URI 拒绝向上遍历、百分号编码、反斜杠、隐藏段和未知技能；根与祖先链接/junction、SKILL.md 硬链接均拒绝，读取时重新核对。普通工作区 read 不因存在 Skill 开放任意隐藏目录。

元数据只用于选择；正文和资源是任务资料，不扩大工作区、shell、网络、委派或预算。子任务有同一元数据目录，但无父已加载正文，需自己 read。

## 上下文关系与验证

完整正文作为普通工具结果进入成功历史。旧 read 省略不处理 kind=skill，但引用资源可省略；显式/自动 compact 可将其所在旧回合概括成有损摘要，完整原文仍在，必要时重读。目录与正文都计入请求预算，保留指令也可能使请求超限，不能因此扩大限制。

检查优先级、无效 YAML、路径/身份/字节限制、无 workspace 装配、资源 URI、父子隔离、构建复制、其他 cwd 启动及 Context 行为。注入模型不能证明真实模型始终选对或遵循 Skill，也不能证明任务质量改善。

没有远程注册表、自动下载安装、热刷新、技能自动执行或权限扩展。新增内置指导只针对已经实现的子系统，不创建未来占位内容。
