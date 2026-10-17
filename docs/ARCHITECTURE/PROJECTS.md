# Projects：目录、归属与管理

[架构总览](README.md) · [项目操作](../GUIDES/SESSIONS.md#share-a-project)

Project 是显式组织实体，持有统一工作目录。成员 Session 历史独立，共享项目附件与 Memory；同目录不自动成为同项目，也不授予额外文件权限。

## 模块与数据所有权

| 源码 | 职责 |
| --- | --- |
| `packages/runtime/src/project/record.ts` | 项目身份、名称、工作目录、修订及 Project v1 格式校验 |
| `packages/runtime/src/project/store.ts` | 创建与查询策略、修订检查、metadata gate 和项目锁/恢复 |
| `packages/runtime/src/project/files.ts` | 项目记录的有界读取、原子发布和锁 owner 记录读取 |
| `packages/runtime/src/project/operations.ts` | 基础迁入预览、完整预览比较与确认后的记录转换 |
| `packages/runtime/src/session/projects.ts` | 组合迁入所需的 Memory/附件状态，准备未保存项目会话的投影；不持有活动会话或执行提交 |
| `packages/commands/src/project/commands.ts` | 终端项目命令的解析、帮助、输出与按 Manager 绑定的加入确认令牌；业务操作仍调用 SessionManager |
| `packages/runtime/src/project/management.ts` | 目录/删除影响预览、成员指纹和有界目录 patch |
| `packages/runtime/src/session/store.ts`、`manager.ts` | 发现成员、重验修订、协调提交并准备目标 Agent |
| `packages/runtime/src/session/execution.ts` | 实际执行身份及归属代次 |
| `packages/webui/src/projects.ts`、`project-management.ts` | UI 操作预览、一次性确认与入口协调 |

Project v1 存于 Session 根的 `projects/<id>.json`，名称最多 120 字符、记录最多 64 KiB。成员列表从 Session location 派生，不维护另一份成员表；Session 只存 projectId，有效目录从 Project 解析，原 storageWorkspace 不变。旧 Session 格式兼容归 [Session](SESSION.md)。

终端统一入口 `runInteractiveCommand` 直接调用 Project 命令处理器；确认消费及会话切换失效规则见 [Session 的宿主命令边界](SESSION.md)。这些临时令牌与下述 Web UI 管理确认分别维护，不持久化、不授予工具权限。

项目创建验证已有目录，不创建目录或自动切换会话。项目成员不能单独覆盖目录；项目不可用时执行失败，不回退启动目录。目录级 Tools 可以共用，资料授权不能按目录缓存。

## 项目文件与存储协调边界

`files.ts` 只接收明确的项目元数据目录、ID、记录或锁文件路径。读取校验 ID、文件大小、UTF-8/JSON 与记录格式；缺失、损坏和其他存储错误保留各自的错误码。发布沿用 Project v1 与 64 KiB 上限，使用 wx/0600 临时文件，写入、sync、close 后 rename，失败清理本次临时文件。文件函数不创建根目录、获取锁、解析当前 Session 或授予访问权限。

`ProjectStore` 保留创建时的名称/真实工作目录校验、存储目录创建、修订检查，以及列表的 10000 个原始条目上限、文件名筛选和名称/ID 排序。列表只跳过 PROJECT_CORRUPT、PROJECT_NOT_FOUND，直接读取则明确报告；其他存储失败不能变成空清单。不存在的仓库在读取时不创建，读取已有记录也不要求其工作目录仍存在；Session 按当前目录可用性处理项目状态，不静默回退。

锁序仍为 metadata gate → Project 锁 → Session 桶锁。`loadUnlocked()` 和 `withProjectUnlocked()` 是已有 gate 内的真实内部入口，SessionStore 等调用者继续使用，不重复取得 gate；它们不是保留旧路径的兼容导出。文件函数只读取 owner PID，存活检查、回收 gate、重试和释放决定仍由 Store 负责。

项目创建由 Store 调用文件发布并使用 PROJECT_STORAGE 错误；重命名、改目录等管理变更继续通过 AttachmentTransactions 的日志发布，保留原来的执行顺序和恢复错误。两条路径的协调上下文不同，不为复用写入函数改变失败语义。后续维护规则见[开发说明](../DEVELOPMENT.md#project-file-and-storage-boundaries)，跨文件协议见[元数据恢复](ATTACHMENTS.md#元数据提交与恢复)。

## 独立会话迁入

1. 以明确源 Session 和目标 Project 生成预览，验证宿主及持久 owner 空闲，准备目标目录/Agent。
2. 展示旧/新目录、独立历史不合并、私有资料及 Memory 共享、已有任务暂停等影响。资料数量/范围修订/指纹、Memory 状态及目标修订绑定确认。
3. 提交前重载并复查全部身份、修订、领取和集合。预览后上传、移除、编辑 Memory 或更改项目，旧确认失效。
4. 通过元数据恢复日志协调 Session 归属、附件关联和 Memory；成功提交后才更新活动 runtime。已有任务原子暂停，locationRevision 使旧上传和排队激活失效。
5. 下一轮请求收到目录/范围变更说明，旧路径与工具结果作为历史数据；成功回合提交才确认通知已应用。

迁入不移动工作文件、不改写历史、不恢复审批。重复确认同一已完成目标应识别完成状态，其他冲突需刷新预览。响应丢失不能当作提交未发生而再次执行。

未保存且无材料的 Web UI 草稿可以只更新内存项目绑定；保存触发条件统一见 [Session](SESSION.md#管理与跨模块关系)。草稿使用可撤销 scope token，不能让旧上传静默归入新范围。

## Session 接入边界

迁入预览与确认共同使用 `sessionProjectJoinPreview`，每次从传入的 Session/Project 快照开始，先检查迁入归属约束，再通过 Manager 提供的回调读取私有 Memory，最后读取已保存会话的附件共享状态。Memory 回调始终经过现有身份/owner 校验；草稿不查询持久附件范围。完整预览包含数量、修订和指纹，确认重新组装后由 `requireProjectJoinPreview` 比较，不能用数量相同或已缓存的预览代替重验。最终提交继续在原存储锁内校验资料版本。

`projectDraftRecord` 只生成未保存会话的候选记录：目录相同时更新项目名称/修订；目录变化时复用既有迁入记录转换，保留存储桶、增加归属代次、记录待通知变化并暂停任务。它不保存草稿、不替换 runtime、不持有上传令牌或项目成员缓存。

Manager 保留目标加载、持久 owner 检查、Agent 准备、宿主操作互斥和激活顺序。迁入非当前会话不切换前台；已迁入同一项目的确认保持原有幂等返回。改目录在提交前准备 Agent 和必要的草稿目录转换，提交后补充最终项目名称/修订或重载已保存会话；删除当前项目先准备启动目录的替代草稿再提交删除。重命名仍先提交项目，再刷新当前会话，因此刷新失败不撤销已经提交的名称。各操作保持自己的失败边界，不统一为新的事务或通用生命周期服务。

SessionStore 继续发现成员、重验修订并协调提交；ProjectStore 和附件元数据事务仍使用原锁序与向前恢复。终端/Web UI 的一次性确认令牌继续归交互层，与业务预览校验分开。

## 项目管理

Web UI 提供重命名、修改目录和确认删除；共享核心负责行为，CLI/TUI 尚无对应改名/删除命令。管理预览 token 一次性且十分钟过期；目录来自受控选择器，服务端不接受任意自报路径作为确认目标。

| 操作 | 持久影响 |
| --- | --- |
| 重命名 | 更新项目名称/修订，不合并历史 |
| 修改目录 | 更新 Project 及成员归属代次、待通知记录，暂停任务；保留原历史/存储桶/工作文件 |
| 删除 | 删除成员会话和任务、解除资料关联/pin；销毁无外部有效引用的原件，保留工作目录文件 |

改目录只要求新目录有效，可修复旧目录已丢失的项目。同目录选择无变更，当前草稿更新代次但不落盘为空会话；未选中项目的管理不切换当前聊天。删除当前所属项目后返回启动目录的独立草稿。Memory 范围不可访问，但孤立 Memory 磁盘文件目前不物理清理。

提交在 metadata gate 和 Project 锁下重新发现最多 1000 个已保存成员并核对指纹；任一成员仍被存活进程领取、资料集合变化或损坏快照均保守拒绝。批量目录变更使用小型 patch，不把全部历史复制进日志。锁序、日志版本与向前恢复见 [Attachments](ATTACHMENTS.md#元数据提交与恢复)。

## 设计与验证边界

以持久归属决定共享，避免删除上传者导致项目资料丢失；以 locationRevision 区分范围变化与普通历史追加，避免 UI 切换或一次聊天改变上传目标。管理确认只批准组织变更，不授权模型工具写文件或执行命令。

检查范围包括项目/独立身份、同目录隔离、预览取消/过期、非活动会话迁入、草稿、后台/子任务身份、双进程领取、日志发布后故障、成员目录统一更新及外部原件保留。Edge 注入模型/目录选择检查不等于真实模型或原生选择器验收；原生选择器边界见 [Web UI](WEBUI.md)。

`packages/verification/tests/projects/` 的文件/协调回归还覆盖不存在仓库的只读行为、列表与直接读取对损坏/超限/无效 UTF-8/身份不匹配记录的不同处理、sync 与 rename 失败清理，以及活跃/不完整/死亡锁 owner 和修订检查。Session 目录投影、项目异常不回退和跨进程管理恢复继续由既有测试覆盖。

尚无解除项目关联、跨项目迁移、回收站、撤销或物理 Memory 清理。解除/迁移时哪些资料和记忆可带走，需要独立产品决策，不能由当前共享规则推断。
