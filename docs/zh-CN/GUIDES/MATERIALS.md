

<a id="attachments-documents-and-memory"></a>

# 附件、文档与 Memory

[English](../../en/GUIDES/MATERIALS.md) | 简体中文

[文档首页](../README.md) · [会话与项目](SESSIONS.md)

<a id="add-and-read-materials"></a>

## 添加与读取资料

Chat/TUI 中可导入当前文件访问策略允许的文件：

```text
/attach "notes.md"
/attachments
```

Web UI 通过附件控件上传。单个原件上限 16 MiB，浏览器最多同时上传四个。导入/上传保存不可变原件及作用域关联，不请求模型，也不移动工作区文件。接受附件也会保存 Web UI 草稿会话。

独立会话资料私有，项目会话共享项目资料。Fork 保留附件关联。私有会话移入项目时，经确认后共享已有资料。后续编辑工作区文件不会静默改变已附加版本。

可让 Fatcat 列出资料、读取指定文档、定位段落或摘要指定页。读取会报告范围与覆盖率；有界搜索或摘录不代表审阅全文。引用标识固定原件版本；解析文档还包含解析器版本和来源位置。没有跨文件向量检索。

<a id="supported-content"></a>

## 支持的内容

| 格式 | 可用读取 | 限制 |
| --- | --- | --- |
| UTF-8 `.txt`、`.md`、`.markdown` | 带行引用的原文 | 分页且有界 |
| CSV、TSV | 行与单元格 | 不推断类型或计算值 |
| PDF | 原生页文本；选定渲染页用于视觉分析 | 纯图片页可能需要视觉能力 |
| DOCX | 正文标题与段落 | 不含页眉、脚注和批注 |
| XLSX | 单元格、原始值和公式 | 缓存值未验证；不重算公式、不解释日期格式 |
| PPTX | 幻灯片文字与备注 | 不解释布局或嵌入媒体 |
| PNG、JPG、JPEG | 使用支持该能力的当前模型进行视觉分析/转写 | 纯文本模型不能分析图片 |
| 旧版 Office、GIF、WebP、BMP、TIFF 及其他不支持类型 | 保存原件 | 分析前需转换为支持格式；不分析加密或启用宏的文档 |

视觉任务可要求分析图片，或明确选择一至四页 PDF。当前模型必须支持所需能力，Fatcat 不会静默切换供应商。默认型号 `deepseek-flash` 支持图片输入；`deepseek-v4-pro` 和 `qwen-plus` 仅支持文本。支持的模型名见[供应商能力规则](../ARCHITECTURE/PROVIDERS.md)。

视觉分析与其他模型调用共用请求/usage 预算。转写可创建带固定来源的可复用派生产物。本地解析、来源预览和缓存派生读取本身不调用付费视觉 API。注入供应商检查不证明真实视觉质量或账户可用性。精确解析、预算与来源规则见[文档架构](../ARCHITECTURE/DOCUMENTS.md)。

<a id="remove-materials"></a>

## 移除资料

`/attachment remove <reference>` 移除当前作用域的关联，撤销该作用域通过旧引用的访问，但保留原件及已复制到历史中的文字。其他作用域不变。

`/attachment delete <reference>` 预览永久删除；审阅后才追加 `--confirm`。外部活跃关联或保留的历史/fork 引用可能阻止删除，确认不绕过这些检查。Web UI 同样区分移除和永久删除。没有自动垃圾回收。见[附件生命周期](../ARCHITECTURE/ATTACHMENTS.md)。

<a id="remember-facts-across-conversations"></a>

## 跨对话记忆事实

可使用自然语言，例如“记住这个项目使用 pnpm”或“将该偏好更新为包括 Windows PowerShell”。父 Agent 可依据当前用户消息中的明确事实或请求保存、修改、删除 Memory。应检查实际操作结果；模型承诺不等于记录已保存。

Memory 默认属于当前私有会话或项目作用域。全局保存要求用户明确提出。项目会话在独立历史间共享项目 Memory。私有会话加入项目时经确认共享活跃 Memory；fork 不复制私有 Memory。子任务和自动触发不能修改 Memory。

Memory 修改属于受管对话元数据，read-only/Plan 下仍可使用，不授予文件或命令权限。模型发起的修改每个用户回合最多八次经证据校验的尝试；本地管理命令不需要模型回合。保留当前记录、来源证据和修订；修改或删除记录不擦除历史磁盘内容或对话中的已有文字。

用 `/memory` 检查条目，显式管理见 [Memory 命令参考](../REFERENCE/COMMANDS.md#memory-commands)。每个作用域最多 64 条记录（含墓碑），单条内容 1 KiB、最多 32 个修订。临时会话将 Memory 状态保留在内存。不自动语义提取/合并，也不物理清理历史。作用域、来源证据和验证限制见 [Memory 架构](../ARCHITECTURE/MEMORY.md)。
