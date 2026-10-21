

<a id="documents-parsing-vision-and-stable-provenance"></a>

# Documents：解析、视觉与稳定来源

[English](../../en/ARCHITECTURE/DOCUMENTS.md) | 简体中文

[架构总览](README.md) · [格式支持与操作](../GUIDES/MATERIALS.md#supported-content)

Documents 从获准附件生成可定位内容，不创建另一套 Agent Loop，也不按格式增加模型工具。原件与授权归 [Attachments](ATTACHMENTS.md)。

<a id="modules-and-data-flow"></a>

## 模块与数据流

| 源码 | 职责 |
| --- | --- |
| `packages/runtime/src/documents/parse.ts` | worker 分派、并发、期限和取消 |
| `types.ts`、`limits.ts` | 解析单元、定位与资源边界 |
| `archive.ts`、`xml.ts`、`ooxml.ts` | 有界 ZIP/XML 与现代 Office 内容提取 |
| `text.ts`、`pdf.ts`、`images.ts` | 文本/标题、PDF 页文字与渲染、PNG/JPEG 解码 |
| `cache.ts` | 不可变快照、版本索引和转写页指针 |
| `read.ts` | 范围读取、字面搜索、视觉选择、覆盖和引用 |
| `vision.ts` | 当前聊天模型的图片请求适配与用量，能力归 [Providers](PROVIDERS.md) |
| `packages/runtime/src/session/attachments.ts` | 将明确的执行身份适配为原件/派生缓存访问；宿主预览与模型读取共用授权包装 |

执行身份获准读取原件 → 加载/生成原生解析快照 → 通用 read 按任务选择范围、搜索或指定页视觉 → 返回单元/覆盖/来源 → Session 保存工具结果。缓存读取和源预览不会隐式发起视觉请求。

<a id="parsing-and-reading-contracts"></a>

## 解析与读取契约

用户格式矩阵归操作指南。架构必须保留以下差异：

- PDF 提取页级文字，不保证版面顺序；扫描页保留缺字说明，不能当作成功空页。视觉按明确页号渲染。
- DOCX 提取正文标题、段落和表格内段落，不推断 Word 页码或完整表格布局；不包含页眉脚注等未支持内容。
- XLSX 保留 sheet/cell/rawValue/valueType，公式保留表达式和未验证缓存，formulaStatus=not-calculated。不应用显示格式、不重算或连接外部工作簿。
- PPTX 提取幻灯片文字与独立备注定位，不渲染母版、图表或动画；Office 视觉需先转换为支持的页面格式。
- PNG/JPEG 实际解码、白底透明图与有界缩放；默认读取不会自动 OCR。旧 Office、宏/加密文档及不支持格式明确拒绝解析。
- OOXML 只读受限包，不解压到磁盘，不访问外部关系；拒绝 ZIP64、分卷、不支持压缩、CRC/大小异常、非法 XML、DTD 和外部实体。

read 可选择 pages、sheet、section、unit、parserVersion、mode 和视觉 question。页/幻灯片从 1 开始，offset 从零计解析单元（搜索时计匹配单元）；sheet/section 精确匹配，query 是大小写敏感字面查询。

结果报告返回/所选/总单元、nextOffset、warnings 与 coverage.uncovered。搜索不等于全文覆盖；解析警告、缺页或模型生成内容不得伪装为完整原生提取。大文字确定性拆成带原位置的 part 单元；超大 Excel 原始字段转为同单元格的具名续页，不静默截断或冒充已计算。

<a id="fixed-references-and-derived-cache"></a>

## 固定引用与派生缓存

引用为 `attachment:<uuid>@<original-sha256>#parse=<snapshot-version>&unit=<unit-id>`。原生解析版本当前是 documents-v1；派生版本由内容、位置、生成方法、模型及警告共同标识。解析行为变化必须更新 parserVersion，旧引用缺少快照报 DOCUMENT_VERSION_UNAVAILABLE，不自动指向新版；文本行引用继续兼容。

native-text、model-transcription、model-description 分别表示原生文本、模型转写和描述。后两者保留 provider/model，不编造坐标或置信度。描述不会自动成为可搜索的完整转写，直接看图不要求预先全文 OCR。

快照存于 `attachments/derived/<id>/<original-version>/`，index.json 记录保留版本和最新转写页。相同版本只复用相同内容；索引发布中断可在同版本保存时修复，损坏明确失败。SessionManager 解析目标，`session/attachments.ts` 对 cache load/transcripts/save 逐次包装授权与取消检查，外发和发布前重新核对范围；解析/网络在 metadata gate 外执行。包装只绑定本次身份，不能因已读到原件字节而复用永久授权，也不能随 UI 切换改用另一会话。宿主预览不增加模型读取 pin，执行中的模型读取仍在读取原件时保存 pin。

`cache.ts` 直接使用 `metadata/files.ts` 的有界 JSON 读取和原子发布，不依赖事务协调器。共享文件机制不改变缓存索引的修复方式、版本生命周期或逐次授权；跨文件提交决定仍由 [Metadata](METADATA.md) 维护。

删除原件同时清理相应派生目录；移除关联撤销缓存访问，pin 仍按原件规则保护。非持久模式使用 MemoryDocumentCache。新视觉任务不能借旧描述声称已执行。

<a id="resource-and-model-budgets"></a>

## 资源与模型预算

| 边界 | 上限 |
| --- | --- |
| 原件；ZIP 部件/展开量 | 16 MiB；2000 件 / 32 MiB |
| XML 大小/节点/深度 | 8 MiB / 200000 / 128 |
| 提取文字与定位；单元数 | 4 MiB；20000 |
| 单元定位元数据 | 4096 JSON 字节 |
| PDF；每次视觉选页 | 200 页；1–4 个唯一页号 |
| 图片解码；渲染 | 1600 万像素；最长边 2048、400 万像素 |
| 视觉输入 | 最多四张、合计 8 MiB；当前资料逐页请求 |
| worker | 30 秒、最多两个活动 worker、256 MiB V8 old-generation |
| 快照；每原件缓存 | 8 MiB；64 版本 / 32 MiB |
| 非持久派生缓存 | 全部原件合计 64 MiB，与原件缓冲分别计数 |
| read 返回 | 约 16 KiB 完整单元分页，默认 100、最多 200 单元 |
| 模型输出 | 关闭思考时请求上限 2048 token；强制思考模型为含推理在内的 16384 token；结果文字上限 32 KiB（见[协议预算](PROVIDERS.md#capability-catalog-and-session-contract)） |

V8 上限不约束全部原生解码内存，也不是 OS 沙箱。取消终止 worker。视觉辅助请求消耗当前父/子回合额度、完整 JSON 字节和期限，保留最终回答机会；图像 base64 只存在临时请求，不写会话。部分页成功可保留快照，失败/未覆盖页明确报告，已消耗用量不回滚。

<a id="dependencies-and-verification-limits"></a>

## 依赖决策与验证限制

pdfjs-dist 用于 PDF 文字和渲染，@napi-rs/canvas 用于原生 Canvas/图片，saxes 用于严格 XML；Office 使用 Node zlib 和窄包解析，不依赖 Office、Python 或大型 RAG 框架。xml.ts 保留窄类型边界，不关闭全仓 strict。版本以 package.json 为准。

已有检查使用已知结构的合成文档做本地解析/渲染，并用注入 SDK 和 Edge 验证预算、来源、授权与 UI。未运行真实视觉 API，不能承诺 OCR、复杂图表、代表性业务材料或账号可用性。检查入口见[开发说明](../DEVELOPMENT.md)。

独立 OCR、原生 PDF/Office 模型输入、Office 页面渲染、公式重算、音频和检索尚未实现。后续选择取决于真实样例与定位/成本需求，见 [RAG](RAG.md)。
