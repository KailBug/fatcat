

<a id="attachments-originals-scope-and-publication"></a>

# Attachments：原件、作用域与发布

[English](../../en/ARCHITECTURE/ATTACHMENTS.md) | 简体中文

[架构总览](README.md) · [资料操作](../GUIDES/MATERIALS.md)

附件层保存不可变原件、作用域关联和历史保留关系。上传成功不等于内容可解析；解析与视觉归 [Documents](DOCUMENTS.md)，项目组织归 [Projects](PROJECTS.md)。

<a id="modules-and-identity"></a>

## 模块与身份

| 源码 | 职责 |
| --- | --- |
| `packages/runtime/src/attachments/record.ts` | 原件/关联/pin/上传目标格式与固定引用 |
| `packages/runtime/src/attachments/store.ts`、`memory.ts` | 持久与非持久原件、发布及访问 |
| `packages/runtime/src/attachments/files.ts` | 无状态的暂存路径、流式字节写入、大小/哈希完整性读取、上传所有权记录读取及原件/派生内容清理 |
| `packages/runtime/src/attachments/catalog.ts` | catalog 读取、校验与发布；不拥有锁或关联策略 |
| `packages/runtime/src/metadata/` | 跨领域 metadata gate、日志编解码、提交与恢复及 JSON 文件操作 |
| `packages/runtime/src/attachments/import.ts` | 通过当前文件权限导入 |
| `packages/commands/src/attachments/commands.ts` | 终端附件命令解析、帮助、输出与删除确认文本；通过 SessionManager 转发作用域操作及取消信号 |
| `packages/runtime/src/attachments/read.ts`、`tools.ts` | 通用 read 包装、文本分页与授权访问 |
| `packages/runtime/src/session/store.ts`、`manager.ts` | 实际 Session 身份、草稿生命周期、发布互斥及跨文件提交协调 |
| `packages/runtime/src/session/attachments.ts` | 接收明确身份的访问适配、传输/清理、文档缓存授权包装；不拥有活动 Session 状态 |
| `packages/webui/src/attachment-http.ts`、`attachments.ts` | 有界上传和宿主资料接口 |

引用使用 `attachment:<uuid>@<sha256>`，文件名不是身份。调用绑定 sessionId、projectId（如有）、locationRevision，并重载实际 Session/Project 核对有效目录和修订。同目录、已知 ID/哈希、UI 当前选择或模型自报 projectId 均不授权；后台与子任务沿真实运行 Session 访问。

原件存于 Session 根的 `attachments/blobs/<id>/<version>`，catalog 保存来源和独立关联。上传者是来源，不是项目资料的生命周期所有者。

<a id="associations-pins-and-lifecycle"></a>

## 关联、pin 与生命周期

| 操作 | 当前语义 |
| --- | --- |
| 项目/独立上传 | 分别发布 Project 共享关联或 Session 私有关联 |
| 草稿浏览/上传 | 浏览项目资料不保存空会话；原件成功发布时一并保存发起草稿 |
| 私有会话迁入 | 确认后关联持久晋升项目，与归属共同恢复 |
| fork | 复制有效私有关联和历史 pin；项目 fork 继续共享 |
| 删除 Session | 释放其私有关联与 pin，不删除项目关联 |
| 移除关联 | 撤销当前范围的发现/读取/预览/下载，保留原件与管理回执 |
| 永久删除 | 明确确认且无其他有效关联或 retained pin 时销毁；留下 tombstone 解释旧引用 |

实际模型读取前保存 pin；历史/attempt 中对获准版本的直接引用也保留 pin。pin 只防止字节被销毁，不授予读取权。移除后旧引用仍保留身份，但重新打开必须被拒绝。compact 保留原始历史 pin，fork 复制，删除相应 Session 才释放。

项目删除会解除成员关系和 pin，只销毁无外部保留关系的原件。删除不会抹去已复制到历史的文字，也不删除项目工作目录。没有自动垃圾回收、保留期或孤立原件管理入口。

<a id="upload-and-text-reads"></a>

## 上传与文本读取

每件原件最多 16 MiB。Web 上传独立于普通 JSON 消息，ticket 最多四个、120 秒有效；发起时固定目标与归属代次，切换 UI 不改目标。目标迁入、改目录或删除则旧传输失效，不自动重投当前会话。字节收完后可取消地等待忙碌会话发布。

uploadId 用于幂等，stageToken/PID lease 标明传输所有者；同 ID 并发拒绝，旧请求只能清理自己的 part。死进程 lease 可在同 ID 重试时回收，无后台扫描全部残留数据的保证。

宿主入口由 SessionManager 解析目标；内部访问适配及 AttachmentUploadTarget 类型归 `session/attachments.ts`，调用者直接从所属模块导入。传输不占用宿主操作互斥区，完成后由 Manager 排队、检查取消及草稿令牌，再调用仓库发布。发布成功或失败都按本次 stageToken 清理；大小不匹配不发布草稿，可使用原 uploadId 重试。状态归属与后续扩展规则见 [Session](SESSION.md#management-and-cross-module-relationships)。

read 的 attachment:list 查询只过滤文件名；UTF-8 文本/Markdown 按完整行分页，默认 100、最多 200 行，页上限 16 KiB，单行超限明确失败。清单最多扫描 1000 项。固定版本仍有覆盖/未读信息；搜索命中不代表全文已审阅。非文本格式和解析引用见 Documents。

非持久原件最多 1000 件、四个 pending 上传，原件及待传缓冲合计最多 64 MiB；退出丢失。这不是 Node 进程总内存上限。

<a id="staging-and-publication-coordination-boundaries"></a>

## 上传暂存与发布协调边界

`AttachmentStore` 保留上传生命周期：校验目标与元数据、领取上传所有权、重验 stageToken、决定幂等返回或冲突、重载目标会话、准备草稿、变更 catalog 并提交。`files.ts` 只接收明确路径、附件目录、字节流、取消信号或预期大小/哈希；不接收整个 Store，不创建上传管理器、会话状态或授权缓存。

暂存按三个阶段执行：先在 metadata gate 内检查 PID/旧领取并保存新的所有权记录；离开 gate 后流式接收字节，保持 16 MiB 上限、取消检查、哈希计算及 sync/close；随后重新进入 gate，确认 token 仍匹配才发布暂存元数据。文件函数返回大小和哈希不代表上传已发布。接收失败先关闭句柄，再由 Store 按捕获的 token 清理；清理自己的 part 后重新读取所有权，仅匹配时才删除对应 json/lock，旧请求不能清除新重试的领取。

`completeUpload` 继续在原短锁中完成身份重验、草稿准备、原件校验/搬入、关联变更和提交。原件字节先就位，再发布可见关联；准备草稿不等于已经保存草稿。上传幂等、已有 blob 的重试校验和失败后的向前恢复仍遵循既有顺序。文件函数不解析当前 Session/Project，不决定 pin、关联或删除权限；内容完整性校验不能替代 Store 的访问授权。

`record.ts` 维护固定引用和暂存格式，`catalog.ts` 维护 catalog 文件操作，`files.ts` 维护原件路径与清理。跨领域提交归 `metadata/`，AttachmentStore 持有附件目录并在原 gate 内直接调用 catalog 文件函数。非持久附件、Session 接入和 Web 上传交互仍由原模块维护；不为物理文件操作引入通用存储框架或兼容转导出。后续维护规则见[开发说明](../DEVELOPMENT.md#attachment-file-and-publication-boundaries)。

跨领域锁序、日志格式、提交顺序与恢复错误由 [Metadata](METADATA.md) 维护。附件层继续拥有原件与关联生命周期，文档派生内容不能代替原件身份。

<a id="verification-and-unimplemented-scope"></a>

## 验证与未实现范围

检查上传取消/重试所有权、草稿发布、身份变化拒绝、共享/隔离、pin 非授权、固定版本、移除/永久删除、故障发布及真实第二进程恢复。`packages/verification/tests/attachments/` 的边界回归还覆盖接收暂停时 metadata gate 可用、旧流结束后不破坏新重试、输入流失败清理及暂存内容损坏不能发布草稿；`packages/verification/tests/metadata/` 的日志/文件回归覆盖持久身份与临时投影分离、版本兼容、决定前冲突拒绝、读取与恢复错误边界，以及 JSON 大小/UTF-8/失败发布清理。项目成员 patch 与 Memory 迁入的中断恢复分别保留在 `packages/verification/tests/projects/`、`packages/verification/tests/memory/`。Edge 资料检查使用临时材料和注入模型，不证明文档理解质量。

尚无强制销毁仍被历史保留的原件、后台清理、跨项目资料迁移或存储加密。原件、派生内容、会话与 Memory 不能合并为同一生命周期。
