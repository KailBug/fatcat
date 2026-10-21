

<a id="use-local-skills"></a>

# 使用本地 Skills

[English](../../en/GUIDES/SKILLS.md) | 简体中文

[文档首页](../README.md)

Skills 通过本地 `SKILL.md` 提供任务指导，不会自动执行，也不授予文件、Shell 或网络权限。

<a id="discover-and-use-a-skill"></a>

## 发现与使用 Skill

在 chat 或 TUI 中运行 `/skills` 可列出发现的元数据，不请求模型、不改变历史；启动这些界面仍需供应商配置。按名称提出相关工作流，Agent 可在需要时读取完整指令。

```powershell
pnpm start --prompt 'Use $workspace-editing to inspect this workspace and make a focused change.'
```

PowerShell 中用单引号保留字面的 `$skill-name`。提及 Skill 用于引导模型选择，并非确定性的命令路由。加载后的指令可能进入模型请求和保存的历史。

<a id="add-a-workspace-skill"></a>

## 添加工作区 Skill

在选定工作区创建 `.fatcat/skills/<name>/SKILL.md`，例如：

```markdown
---
name: review-notes
description: Review Markdown notes for broken internal references and unclear instructions.
---
Read the relevant notes, check their local links, and report concrete corrections.
```

目录名必须与声明名称一致。名称使用 1–64 个小写字母、数字和单连字符，不能以连字符开头或结尾。描述上限为 1024 字符，Skill 文件上限为 32 KiB。发现阶段先读取元数据，正文通过受控 read 工具加载。修改目录元数据后应重启，确保重新发现。

发现顺序为工作区 `.fatcat/skills`、工作区 `.agents/skills`、用户主目录对应根目录，最后是内置目录。同名 Skill 中第一个有效项生效。不搜索父目录，也不自动下载。无效条目会产生诊断。每个发现根目录最多 128 项，目录总计最多 64 个 Skills。

<a id="built-in-guidance"></a>

## 内置指导

| Skill | 任务 |
| --- | --- |
| `workspace-editing` | 检查与修改工作区文件 |
| `focused-delegation` | 定义有边界的独立子任务 |
| `context-recovery` | 在读取省略或摘要后恢复相关事实 |
| `verification-handoff` | 检查修改并报告证据 |
| `web-research` | 研究与引用公开来源 |
| `weather-lookup` | 明确天气地点/日期并报告来源 |
| `local-browser-check` | 使用受控浏览器证据检查工作区页面 |

内置文件位于 `packages/runtime/src/skill/<subsystem>/<skill-name>/SKILL.md`。目录解析、诊断与来源边界见 [Skills 架构](../ARCHITECTURE/SKILLS.md)；权限由运行时落实，不由指令授予。
