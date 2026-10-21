

<a id="metadata-cross-domain-commits-and-recovery"></a>

# Metadata：跨领域提交与恢复

[English](../../en/ARCHITECTURE/METADATA.md) | 简体中文

[架构总览](README.md) · [开发规范](../DEVELOPMENT.md#metadata-journal-and-transaction-boundaries)

`packages/runtime/src/metadata/` 协调 Session、Project、附件关联与 Memory 迁入的跨文件提交。它属于 runtime 内部，不是独立 package，也不拥有活动会话、上传、领域校验或用户确认状态。

| 模块 | 职责 |
| --- | --- |
| `metadata/transaction.ts` | MetadataTransactions：同根排队、进程锁、提交预检、持久决定及有序恢复 |
| `metadata/journal.ts` | MetadataCommit 与纯日志编解码、跨记录一致性校验 |
| `metadata/files.ts` | 显式路径上的有界 JSON 读取与原子发布 |
| `attachments/catalog.ts` | 附件 catalog 读取、格式校验与发布，不持有锁或决定关联 |
| `attachments/files.ts` | 附件原件定位、暂存字节操作与原件/派生内容清理 |

<a id="calls-and-state-ownership"></a>

## 调用与状态所有权

SessionStore、ProjectStore、AttachmentStore 继续按原有入口和锁范围准备领域变更；AttachmentStore 保留关联、pin、上传和删除决策，通过 MetadataTransactions 提交。SessionStore 仍通过附件仓库的 metadata 入口协调会话操作；ProjectStore 使用同一个根目录的协调器，所有实例共享同根队列与进程锁。MemoryStore 继续拥有作用域锁、冲突校验和幂等迁入。不要新增一份会话、catalog 或事务状态缓存。

协调器的 MetadataSessionAccess 只接收 Session 发布与删除回调；AttachmentSessionAccess 由 `attachments/store.ts` 定义，另含实际上传需要的 load 和 prepareDraft。缺少注入回调时，协调器仍按固定 Session 桶直接发布/删除。附件目录和 catalog 访问由附件层维护；协调器仅在应用决定时调用领域文件操作，不提供附件路径或 catalog 查询接口。

源码归属调整不迁移磁盘数据：进程锁仍在根目录 `metadata.lock`，日志仍在 `attachments/pending.json`，catalog、原件、派生内容及各领域记录路径均不变。已有 ATTACHMENT_*、SESSION_* 等错误码和信息保留，避免改变调用者识别和恢复提示。文档缓存只复用 JSON 文件函数，不因此进入共享事务或获得资料访问权。

<a id="metadata-commits-and-recovery"></a>

## 元数据提交与恢复

锁序为 **metadata gate → Project 元数据锁 → Session 桶锁**；同进程同根排队，跨进程明确 busy。锁只覆盖本地元数据，不跨模型、用户确认或流式上传。每次公开读取/修改先恢复已有提交决定，不能绕过半提交。

上下文预览是显式的只读例外：withMemorySession 经同一 metadata gate 校验执行身份，preview 模式只检查 pending.json 是否存在，存在即拒绝而不恢复、不越过半提交。它不创建缺失根目录、不回收陈旧锁；只允许已有目录中的短暂同步锁，不写领域记录。MemoryStore 的 preview 读取同样不建目录或恢复锁，普通执行和管理入口保留原有恢复语义。相关用途见 [Context](CONTEXT.md)。

`journal.ts` 以显式提交描述构造磁盘形状，并从未知数据解码、校验版本、成员 patch、项目变更冲突及 Memory 迁入与 Session 身份的一致性；复用各记录模块的校验，不读取当前仓库或创建状态所有者。普通提交写日志 v2，包含 Memory 迁入时写 v3，读取支持 v1/v2/v3；这些日志版本与 Session v4、Project v1 独立；日志内嵌会话记录只接受当前 Session 格式。

`MetadataTransactions` 编码并校验完整提交、检查各记录大小后，先持久写 `pending.json`，再按既有顺序执行 Memory 迁入、Session 快照、Project 快照、成员 patch、catalog、Session 删除、Project 删除和原件/派生内容 purge，全部成功后才删除日志。保存的是原始编码日志，执行的是校验结果，不将解码后的运行时记录重新序列化为日志。已发布日志是持久决定，失败后向前完成，不重放模型或工具；锁、提交顺序、幂等重放及 Session 发布/删除回调仍由协调层管理。

`files.ts` 仅执行调用者指定路径和大小上限的 UTF-8/JSON 读取，或临时文件写入、sync、close、rename 与清理。optional 读取只将不存在视为空；文件损坏、超限及其他读取错误仍拒绝。附件暂存、事务与文档缓存直接使用它，不通过事务模块转导出，也不因此共享授权或事务生命周期。日志读取错误保留 `ATTACHMENT_CORRUPT`；读到 JSON 后解码或执行失败则报告 `ATTACHMENT_RECOVERY_PENDING`，保留日志并阻止后续操作。后续维护规则见[开发说明](../DEVELOPMENT.md#metadata-journal-and-transaction-boundaries)。

catalog 上限 16 MiB，日志 96 MiB，Session 快照 64 MiB。先保存完整原件，再发布可见关联；决定前失败可能留下不可发现 blob，但不得出现可见悬空原件。相同 uploadId 重试不增加第二份关联。Memory 的幂等迁入细节见 [Memory](MEMORY.md)。

锁回收只在核查 owner 已退出后进行；PID 重用/不完整锁可保守拒绝。文件同步与 rename 提供本地恢复机制，不保证任意断电、磁盘损坏或恶意本机进程下无损。升级前停止旧实例，旧协议实例不能同时写入。

<a id="verification"></a>

## 验证

`packages/verification/tests/metadata/` 维护日志版本、记录一致性、决定前拒绝、读取/恢复错误边界，以及 JSON 大小、UTF-8 和失败发布清理。上传、跨进程锁与原件销毁场景仍在 `tests/attachments/`，Session 读取恢复在其相关契约测试中；项目成员 patch 和 Memory 迁入中断恢复分别在 `tests/projects/`、`tests/memory/`。迁移内部接口时同步修改所有调用者，不保留旧附件事务模块转发。
