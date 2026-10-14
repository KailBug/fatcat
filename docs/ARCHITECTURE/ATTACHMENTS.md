# 持久附件与共享读取：阶段 2

状态：2026-10-13，沿用 `feat/rag-dev`，从 `03b56d8` 实现资料计划阶段 2。本文记录实际模块和边界；验收结果以 [PROGRESS.md](../PROGRESS.md) 为准。阶段 3 的解析和视觉实现见 [DOCUMENTS.md](DOCUMENTS.md)；Memory、Embedding、音频仍未实现，研究与依赖保留在 [RAG.md](RAG.md) 和 [ROADMAP.md](../ROADMAP.md)。

## 可用范围

Web UI 的 Attachments 面板提供上传、进度、取消、重试、清单、文本分页、来源预览、原件下载、移除关联和确认永久删除。chat/TUI 通过共享命令 `/attach "path"`、`/attachments`、`/attachment remove <reference>` 和 `/attachment delete <reference> --confirm` 使用同一核心；CLI 恢复会话后的模型读取也走该核心。导入源文件只读，不搬动或修改原路径。

单原件最多 16 MiB。允许保存 `.txt/.md/.markdown/.csv/.tsv/.pdf/.doc/.docx/.xls/.xlsx/.ppt/.pptx` 及 `.png/.jpg/.jpeg/.gif/.webp/.bmp/.tif/.tiff`；扩展名决定服务端媒体类型，不信任浏览器提供的 MIME。阶段 2 原有逐行文本读取继续兼容；阶段 3 扩展 UTF-8 CSV/TSV、现代 Office、PDF 和 PNG/JPEG 的解析/视觉路径，格式与覆盖矩阵见 DOCUMENTS.md。旧 Office 和额外图片格式仍仅保存/下载；接收成功不表示文件已被解析或完整分析。

阶段 2 当时没有新增依赖或 API 请求；阶段 3 的解析依赖和按任务触发的当前聊天模型图片请求分别记录于 DOCUMENTS.md/PROVIDERS.md，无独立 OCR 配置。原件在选定的本地 Session 根中以明文保存，与既有明文历史采取相同本地信任边界；这不是多用户服务或 OS 文件隔离。上传不会授予工具任意目录访问权。

追加的项目管理支持确认级联删除：项目/成员关联与成员 pin 一并解除，只有没有外部有效关联或 pin 的原件才销毁；其他会话引用的原件保留并在确认前计数。项目工作目录中的文件完全不参与删除。改项目目录不移动附件原件，但所有成员及当前草稿的目录代次更新，旧上传必须重新发起。细节见 [PROJECTS.md](PROJECTS.md#8-追加项目管理增量2026-10-13)。

## 模块和所有者

| 模块 | 实际职责 |
| --- | --- |
| `src/attachments/record.ts` | 原件身份、版本、作用域、上传记录、绑定、保留引用及有界解码 |
| `src/attachments/store.ts` | 流式暂存、不可变原件、关联授权、pin、迁入/fork/删除的资料部分 |
| `src/attachments/transaction.ts` | 短元数据锁、同进程排队、跨所有者提交日志与读前恢复 |
| `src/attachments/memory.ts` | 无持久化模式的临时原件、私有关联、预算与释放；不会把临时会话或文件写盘 |
| `src/attachments/import.ts` | 复用 Workspace 和实时权限快照读取本地二进制源，核对文件身份/大小/时间和取消 |
| `src/attachments/read.ts`、`tools.ts` | UTF-8 解码、有界行读取/字面搜索、来源和覆盖范围；包装现有通用 `read` |
| `src/session/manager.ts` | 发起目标捕获、上传发布与 Session 操作协调、三入口共用管理；绑定实际执行身份 |
| `src/session/store.ts` | Session 快照/历史/归属/执行领取；与附件事务共用提交边界 |
| `src/agent.ts` | 在目录 Tools 缓存之外，向父子工具装配同一个已绑定 Session 的资料访问器 |
| `webui/attachments.ts`、`attachment-http.ts` | 短期上传 ticket、认证和有界 HTTP 流；不自行推导项目所有权 |
| `webui/client/attachment-upload.ts`、`attachments.ts`、`markdown.ts` | 上传行生命周期、资料界面、严格引用链接与按当前 Session 重新授权的预览 |

Project 持有项目身份与统一工作目录，附件 catalog 持有原件及项目/私有关联，Session 持有原历史。阶段 3 的解析快照存于 attachments/derived，原件实际永久销毁时由同一恢复事务删除派生目录；缓存读取/发布均重新检查原件授权。索引及 Memory 仍未实现，未混入原件或历史。

## 身份、读取和覆盖

每次新导入有独立 UUID，内容版本为 SHA-256；同名上传不会覆盖旧内容。引用形式为 `attachment:<uuid>@<sha256>`，文本来源追加 `#L起始行-L结束行`。读取原件时核对实际大小和哈希；损坏/丢失返回错误，不能把旧来源指向替换文件。上传重试的 `uploadId` 只对相同目标、名称和字节幂等，不等于按文件名去重。

通用 `read` 的 `path: "attachment:list"` 发现当前执行范围资料；此处 `query` 只过滤文件名。读取精确版本引用时，`offset` 从零起按行分页，默认 100、最多 200 行，正文/条目页最多 16 KiB；保留完整行、原始换行和行号。单行超预算明确失败，不能跳过后声称已完整读取。对具体文件的 `query` 是区分大小写的字面搜索，offset 计匹配行；返回的全扫描标记不表示模型阅读或审查了全文。清单扫描最多 1000 项，超限显式报错。

结果携带总行数、当前范围、`nextOffset`、截断与 coverage。模型按任务继续分页或搜索后展开；提示要求不能把片段当全文。Web UI 展示该次预览的范围和未显示部分，回答中的合法引用可打开指定版本/行。**尚无逐回合读取事件汇总或自动证明模型已覆盖全文的机制**；自然语言回答质量仍需实际模型验收。历史 Context 裁剪只缩减请求副本，保留版本路径和原工具参数，重读再次经过当前授权。

## 作用域和生命周期

所有调用带 `sessionId + locationRevision + projectId?`，服务端读取真实 Session 再确认身份。项目成员访问 Project 绑定，独立会话访问自己的绑定；同一目录、已知文件 ID、UI 当前选择或模型声称某项目均不授予访问。后台和子任务沿实际运行 Session 绑定；不可用 Project/目录不回退至启动目录。

| 操作 | 已实现行为 |
| --- | --- |
| 项目上传 | 原件关联直接属于 Project；上传者 Session 只是来源 |
| 独立会话上传 | 私有关联只授权该 Session |
| 草稿浏览 | 项目内未保存的新会话可列出、预览和下载已有共享资料，不因此保存空会话 |
| 草稿上传 | 成功发布原件时一并保存发起草稿；取消/失败不保存，切换 UI 仍发布到发起目标 |
| 独立会话迁入 | 预览附真实资料数量、范围修订和指纹；确认后私有关联晋升项目，与 Session 归属共同恢复。期间上传/移除使旧预览失效 |
| fork | 私有 fork 复制有效关联与来源 pin，之后各自管理；项目 fork 仍使用共享范围。历史显式复制，自动任务不复制 |
| 删除 Session | 释放该 Session 私有关联和 pin；保留 Project 关联及其他 Session pin。不会销毁项目原件或级联其他会话 |
| 移除关联 | 退出当前作用域的清单并撤销其读取/预览/下载；保留管理回执和原件，其他有效关联不受影响 |
| 永久删除 | 用户明确确认后，可同时移除本作用域关联并销毁字节；其他有效关联或任意 retained pin 存在时拒绝，保留 tombstone 供解释旧引用 |

模型实际读取前先持久记录该 Session 的 pin；成功历史或未完成 attempt 中直接引用可访问版本也会保留 pin。pin 仅防止原件被销毁，**不是额外访问授权**；移除当前绑定后，历史文本及引用身份仍在，重新打开会报当前不可访问。compact 不释放原始历史 pin，fork 复制 pin，删除相应 Session 才释放其 pin。

暂不实现自动垃圾回收、保留期或孤立文件管理入口。删除最后一个私有 Session 后，原件可能成为保守保留的孤立数据；如需销毁未引用原件，应在删除 Session 前操作。模型读过、历史仍保留的原件不能强制删除；未来销毁历史引用的产品策略另行设计，不以手工修改 catalog 作为正常用法。

## 上传、事务与故障

Web 上传与普通 JSON 消息分离，上传 ticket 最多 4 个、120 秒期限；请求最多 16 MiB，普通 JSON 仍为 64 KiB/10 秒。浏览器原始 Session/项目/归属代次在初次上传和重试保持不变。目标迁入、变更目录或删除后拒绝旧传输，用户从新范围重新选择文件，不静默重新归属。取消上传不会取消模型回合；字节传完而 Session 忙时，可取消地等待当前操作结束后发布，不替换正在执行的 runtime。

每次传输另有 `stageToken` 与 PID lease，暂存路径包含该 token；上传 ID 用于幂等，token 用于传输所有权。并发同 ID 拒绝；旧请求只能清理自己的 part，不删除后一次重试的 lease 或 metadata。正常失败、取消和完成清理本次暂存。进程退出后的旧 lease 可在同 ID 重试时回收；没有后台扫描全部残留 part/tmp/孤立 blob 的机制，不能承诺崩溃后一律零残留。

持久结构位于 `<SessionRoot>/attachments/`：`catalog.json`、`blobs/<id>/<version>`、`staging/`、短暂的 `pending.json`；根目录 `metadata.lock` 协调 Session 和附件。catalog 最多 16 MiB，提交日志最多 96 MiB，Session 快照仍最多 64 MiB；解码另有限制条目数量。无持久化模式最多 1000 原件、4 个 pending 上传，原件与待传缓冲合计最多 64 MiB（不等于 Node 总进程内存上限），退出即丢失。

锁序为 **共享 metadata gate → Project 元数据锁 → Session 桶锁**，只覆盖本地元数据操作，不跨模型、用户确认或流式网络接收。同进程同根调用排队；其他进程持锁时明确 busy，死 PID 锁经独占 recovery guard 回收。PID 重用/不完整锁可能保守拒绝，不能等同于 OS 进程出生身份保证。

迁入、fork、删除、首次带资料保存草稿使用实际提交日志：先持久写入已决定的 Session/catalog 变更，再发布各文件。项目管理扩展为 v2 日志，同时保存 Project 变更、有界成员目录 patch 或批量删除，仍能读取 v1 日志。所有 Project、Session 与附件读写先恢复日志，故障后读者不会绕过半提交；已决定的操作向前完成，不重放模型或工具。日志无法恢复时明确阻塞并要求恢复存储访问。永久删除的 metadata tombstone 与原件 purge 同样由日志恢复。

原件先进入不可变路径，之后决定 metadata 提交；决定前失败可能保留不可发现的 blob，不能声称绝无孤立文件。原子 rename/文件同步是本地崩溃恢复协议，不是任意硬件断电/磁盘损坏后的无损保证。响应丢失时核对已提交结果；相同 uploadId 不增加第二份可见关联。

Session v2 和旧 v1 读取兼容保留，原存储桶不搬移。**升级前关闭旧 Fatcat 实例**：阶段 1 程序即使能解码 v2，也不知道新的 metadata gate、pin 和恢复日志，不能与阶段 2 同时写同一存储根。

## 验收映射

| 路线图 | 当前证据入口 |
| --- | --- |
| S2-01/02 项目共享、独立隔离、迁入及上传者删除 | attachment-store、attachment-lifecycle、attachment-commands、webui-attachments；同目录项目/私有和直接已知引用越权 |
| S2-03 发起目标、切换、取消、归属变化 | lifecycle/store、Web HTTP 流测试和真实 Edge 上传暂停/切换；draft 专项补充未持久化目标变化 |
| S2-04/05 恢复、fork、pin、移除及删除 | store/lifecycle/commands，实际恢复后固定版本读取及引用拒绝 |
| S2-06 限额、格式、导入权限、重试 | tools/store/memory/commands、HTTP 与真实 Edge 下载；无真实外部服务 |
| S2-07 后台与子任务 | 注入 SDK 的后台父子实际 read，UI 选另一项目仍拒绝已知外部引用 |
| S2-08 一致提交与并发 | 注入发布失败、真实第二个 Node 进程在 Session 发布后退出、读前恢复、传输 ownership 与旧清理 |

`pnpm run verify:attachments` 使用真实 Windows Edge、本地临时资料和注入模型，覆盖上传、分页、原件下载、来源定位、私有范围、切换/取消、未支持格式、移除/删除及移动界面。离线、真实浏览器与真实模型效果分别报告，不将资料持久化验收当作文档解析或 RAG 已完成。
