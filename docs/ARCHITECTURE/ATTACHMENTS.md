# Attachments：原件、作用域与恢复

[架构总览](README.md) · [资料操作](../GUIDES/MATERIALS.md)

附件层保存不可变原件、作用域关联和历史保留关系。上传成功不等于内容可解析；解析与视觉归 [Documents](DOCUMENTS.md)，项目组织归 [Projects](PROJECTS.md)。

## 模块与身份

| 源码 | 职责 |
| --- | --- |
| `src/attachments/record.ts` | 原件/关联/pin/上传目标格式与固定引用 |
| `src/attachments/store.ts`、`memory.ts` | 持久与非持久原件、发布及访问 |
| `src/attachments/transaction.ts` | metadata gate、跨文件提交决定与恢复 |
| `src/attachments/import.ts` | 通过当前文件权限导入 |
| `src/attachments/read.ts`、`tools.ts` | 通用 read 包装、文本分页与授权访问 |
| `src/session/store.ts`、`manager.ts` | 实际 Session 身份、草稿发布及操作协调 |
| `webui/attachment-http.ts`、`attachments.ts` | 有界上传和宿主资料接口 |

引用使用 `attachment:<uuid>@<sha256>`，文件名不是身份。调用绑定 sessionId、projectId（如有）、locationRevision，并重载实际 Session/Project 核对有效目录和修订。同目录、已知 ID/哈希、UI 当前选择或模型自报 projectId 均不授权；后台与子任务沿真实运行 Session 访问。

原件存于 Session 根的 `attachments/blobs/<id>/<version>`，catalog 保存来源和独立关联。上传者是来源，不是项目资料的生命周期所有者。

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

## 上传与文本读取

每件原件最多 16 MiB。Web 上传独立于普通 JSON 消息，ticket 最多四个、120 秒有效；发起时固定目标与归属代次，切换 UI 不改目标。目标迁入、改目录或删除则旧传输失效，不自动重投当前会话。字节收完后可取消地等待忙碌会话发布。

uploadId 用于幂等，stageToken/PID lease 标明传输所有者；同 ID 并发拒绝，旧请求只能清理自己的 part。死进程 lease 可在同 ID 重试时回收，无后台扫描全部残留数据的保证。

read 的 attachment:list 查询只过滤文件名；UTF-8 文本/Markdown 按完整行分页，默认 100、最多 200 行，页上限 16 KiB，单行超限明确失败。清单最多扫描 1000 项。固定版本仍有覆盖/未读信息；搜索命中不代表全文已审阅。非文本格式和解析引用见 Documents。

非持久原件最多 1000 件、四个 pending 上传，原件及待传缓冲合计最多 64 MiB；退出丢失。这不是 Node 进程总内存上限。

## 元数据提交与恢复

锁序为 **metadata gate → Project 元数据锁 → Session 桶锁**；同进程同根排队，跨进程明确 busy。锁只覆盖本地元数据，不跨模型、用户确认或流式上传。每次公开读取/修改先恢复已有提交决定，不能绕过半提交。

transaction.ts 先持久写 pending.json，再发布 Session/catalog、项目变更、成员 patch/删除及原件 purge。普通提交写日志 v2，包含 Memory 迁入时写 v3，读取兼容 v1/v2；这些版本与 Session v2、Project v1 独立。已发布日志是持久决定，失败后向前完成，不重放模型或工具。恢复不成功则明确阻塞。

catalog 上限 16 MiB，日志 96 MiB，Session 快照 64 MiB。先保存完整原件，再发布可见关联；决定前失败可能留下不可发现 blob，但不得出现可见悬空原件。相同 uploadId 重试不增加第二份关联。Memory 的幂等迁入细节见 [Memory](MEMORY.md)。

锁回收只在核查 owner 已退出后进行；PID 重用/不完整锁可保守拒绝。文件同步与 rename 提供本地恢复机制，不保证任意断电、磁盘损坏或恶意本机进程下无损。升级前停止旧实例，旧协议实例不能同时写入。

## 验证与未实现范围

检查上传取消/重试所有权、草稿发布、身份变化拒绝、共享/隔离、pin 非授权、固定版本、移除/永久删除、故障发布及真实第二进程恢复。Edge 资料检查使用临时材料和注入模型，不证明文档理解质量。

尚无强制销毁仍被历史保留的原件、后台清理、跨项目资料迁移或存储加密。原件、派生内容、会话与 Memory 不能合并为同一生命周期。
