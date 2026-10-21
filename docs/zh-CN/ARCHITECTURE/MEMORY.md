

<a id="memory-user-facts-scope-and-revisions"></a>

# Memory：用户事实、作用域与修订

[English](../../en/ARCHITECTURE/MEMORY.md) | 简体中文

[架构总览](README.md) · [Memory 操作](../GUIDES/MATERIALS.md#remember-facts-across-conversations)

Memory 保存当前用户直接提供的持久事实、定义、偏好和决定，独立于历史摘要、附件和 RAG。父模型可通过通用 write 保存，主机命令是可选管理入口。

<a id="module-responsibilities"></a>

## 模块职责

| 源码 | 职责 |
| --- | --- |
| `packages/runtime/src/memory/record.ts` | 作用域、来源、完整修订及持久记录格式校验 |
| `packages/runtime/src/memory/store.ts` | 内存状态、存储锁、记录变更与修订冲突、容量规则及迁移协调 |
| `packages/runtime/src/memory/files.ts` | 作用域文件有界读取、原子发布、锁 owner 记录读取及文件大小上限 |
| `packages/runtime/src/memory/tools.ts` | 通用 read 与每次请求的当前状态 notice |
| `packages/runtime/src/memory/write.ts` | 通用 write 保留地址、证据及能力指导 |
| `packages/commands/src/memory/commands.ts` | 用户主动管理，不请求模型或增加成功历史 |
| `packages/runtime/src/session/memory.ts` | 会话可见作用域、作用域内增改删规则、模型写入请求转换及迁入统计；不持有活动会话状态 |
| `packages/runtime/src/session/manager.ts` | MemoryStore 实例、宿主互斥、草稿保存与激活、按执行身份绑定访问及每次操作的校验入口 |
| `packages/runtime/src/session/agent-session.ts` | 当前父用户回合、变更额度、callId 结果复用 |
| `packages/runtime/src/session/store.ts` | 实际执行身份及持久 attempt owner 重验 |
| `packages/runtime/src/metadata/transaction.ts` | 项目迁入中的幂等 Memory 转移 |

目录 Tools 缓存外绑定 MemoryAccess；每次操作按 Session/Project、locationRevision、projectRevision、有效 workspace 重验。子任务继承可见范围但不能修改，自动任务也不能修改。

`session/memory.ts` 接收明确的 MemoryStore、执行身份和变更来源，处理来源 sessionId 一致性、作用域选择、相同 active 内容复用及增改删；它不是独立授权入口。Manager 的 memoryOperation 必须包住整个读取与修改过程，持久模式由 SessionStore.withMemorySession 在元数据锁内重验，非持久模式由 Manager 核对当前 sessionId、locationRevision 及可选回合 owner。不能只在创建访问对象时校验，也不能在读取与写入之间释放既有校验边界。

Manager 提供 listMemories、changeMemory 宿主操作；MemoryChange 直接从 `session/memory.ts` 导入，不经 manager 转导出。首次宿主修改仍先保存并激活草稿，再执行 Memory 变更；后者失败不撤销已保存会话，操作开始前取消则不保存草稿。模型写入请求的默认私有/项目作用域按捕获的执行身份转换，证据、八次额度和 callId 结果仍由 AgentSession 管理。

MemoryAccess 的闭包在 activate 时捕获原身份及必要的草稿快照，每次 list 重新进入 Manager 校验，不缓存清单或授权。持久会话切换后旧绑定仍指向原会话；原会话迁入项目、改变作用域或被删除后按存储校验拒绝访问。非持久绑定则要求当前活动会话仍匹配。迁入预览在受校验的读取后计算 active 数量及全记录指纹，不能因数量为零而排除 tombstone。

<a id="saving-and-provenance-contracts"></a>

## 保存与来源契约

write 的 memory:new 保存到实际私有/项目范围；memory:global:new 只用于明确全局请求；`memory:<uuid>@<revision>` 修改当前条目，空正文删除。不增加专用模型工具，只有成功工具结果才能证明已保存。

自然语言变更须带 memoryEvidence，逐字匹配当前实际用户请求。主机核对 running attempt 的 ownerPid/startedAt，记录 source 的 sessionId、request、turn、evidence。长请求只保存有界证据摘录并标 requestExcerpt；turn 是此前完整回合数加一。主机命令记录命令原文与当时已完成回合数，来源语义不同。

证据匹配证明输入出处，不机械证明语义意图或全局授权；模型负责选择直接用户事实，不能自主提炼网页、工具、assistant 或摘要。当前能力说明优先于旧对话中的“不能保存”回复，但不能成为其他工具授权。

每用户回合最多八次通过证据校验的变更尝试，失败也占额度。同 callId/同参数复用已提交结果，不同参数拒绝；完全相同 active 正文返回既有记录，不做语义合并或复活 tombstone。保存是独立副作用，后续模型失败、取消或 Session 保存失败不会回滚。

<a id="scopes-and-current-state"></a>

## 作用域与当前状态

独立会话读取自身与 global，项目会话读取项目与 global；global 仅属于所选存储根，不由目录相同自动产生。项目会话新增项目或明确 global 记录，不再新增私有条目。

Memory 属于受控元数据，Plan/read-only 不禁用它；不授予普通文件、命令或网络权限。这是接口隔离，不是 OS 沙箱。无持久化 Manager 使用独立内存 store，global 也不访问磁盘全局记录。草稿查询不落盘，首次主机修改先保存来源 Session。

read 支持 memory:list 及当前 UUID@revision；清单可做 active 正文字面 query。旧修订/删除返回 MEMORY_STALE，不可见 ID 返回 MEMORY_NOT_FOUND。/memory show 可查看历史修订；删除不是物理擦除，历史文本仍可能存在。

每次父子模型请求重新加载当前 manifest 与部分 active 正文。notice 不写入成功历史，遗漏正文可再 read；不存在、过期或删除的记录不能因旧 read、fork 或 compact 恢复有效。该机制提供状态依据，不保证模型永不重复旧事实。

上下文预览使用 MemoryAccess.preview，复用相同的 manifest、正文预算与 notice 组装，但通过只读 metadata/Memory 门禁读取。它保留执行身份与作用域校验，不创建缺失目录、不恢复事务、不回收陈旧锁；只获取和释放短暂同步锁。没有提供只读 preview 的注入访问器使上下文估算未知，不退回普通 list。普通模型执行继续使用 list 的既有恢复语义，详见 [Context](CONTEXT.md) 与 [Metadata](METADATA.md)。

<a id="storage-and-lifecycle"></a>

## 存储与生命周期

| 边界 | 上限 |
| --- | --- |
| 每作用域记录 | 64，含 tombstone |
| 正文；来源请求/证据 | 1 KiB；各 2 KiB UTF-8 |
| 每条修订 | 32，最后一次保留给删除 |
| 作用域文件 | 64 MiB |
| read 清单 | 16 KiB；默认 20、最多 64 项 |
| 请求 notice / 正文集合 | 24 KiB / 8 KiB，继续计入完整请求预算 |

memory/ 下分 `session-<uuid>.json`、`project-<uuid>.json` 和 `global.json`，使用有界解码、修订锁及原子发布。损坏或写入失败不以空数据覆盖。

私有 Session 迁入 Project 时全部记录（含 tombstone、来源和修订）转移，预览展示 active 数量并绑定全记录指纹；提交前检查目标容量/冲突。v3 恢复日志先幂等发布项目 Memory、清空私有范围，再协调 Session/附件归属，不允许半提交观察。协议详见 [元数据恢复](METADATA.md)。

独立 fork 不复制私有 Memory；项目 fork 继续共享。删除来源 Session 不删除项目/global 记忆。删除所属 Session/Project 后对应范围不可访问，但孤立磁盘文件保留，没有物理清理。

<a id="scope-file-and-storage-coordination-boundaries"></a>

## 作用域文件与存储协调边界

`files.ts` 接收明确的 Memory 目录、作用域、记录、锁文件路径及取消信号。作用域读取复用 `record.ts` 的 key 和记录校验，保留符号链接拒绝、64 MiB 上限、严格 UTF-8/JSON 和作用域匹配检查；仅不存在返回空记录，损坏数据不能被当成空文件覆盖。发布保留 v1 的 `{ version, scope, records }` 形状与现有文件名，使用 wx/0600 临时文件，写入、sync、close 后再次检查取消，才 rename 为正式文件；失败清理本次临时文件并保留原错误语义。

`MemoryStore` 继续持有非持久 Map 与串行队列、根目录创建、磁盘锁、重试和死进程锁回收，以及增改删、修订/容量检查和迁移规则。文件函数不创建根目录、获取锁或决定当前 Session/Project，也不构成授权入口。非持久分支继续隔离实例、复制输入/输出且不落盘；当前身份、回合额度和 callId 复用仍由 Session 层维护。

锁 owner 读取只返回有界文件内的有效 PID 或未知结果，取消仍传播；PID 存活检查、回收 gate 和释放顺序留在 Store。Memory 的取消点、链接检查及错误转换与附件 JSON 文件操作不同，因此保留自己的文件函数，不共用通用存储框架或兼容转导出。

Windows 上独占创建锁时，旧锁等待删除可能返回 `EPERM`；仅该获取阶段沿用最多 40 次、间隔 25 ms 的可取消重试，不据此回收或删除别人的锁。持续拒绝访问仍报 `MEMORY_IO`；`EEXIST` 保留原 owner 检查与忙锁 `MEMORY_CONFLICT`。锁创建成功后的 owner 写入失败直接清理本次锁并报错，不进入获取重试。

迁移预检与合并仍在原锁内完成。发布项目范围后才能清空私有范围；后一步失败不回滚已经发布的项目数据，重放继续按原身份和内容去重或拒绝冲突。跨 Session/附件归属的恢复决定仍属于 MetadataTransactions，不能由文件函数独立迁移。后续维护规则见[开发说明](../DEVELOPMENT.md#memory-file-and-storage-boundaries)。

<a id="verification-and-unimplemented-scope"></a>

## 验证与未实现范围

检查生产装配下的自然语言 write/read、当前证据、Plan/read-only 例外、子/自动任务拒绝、旧能力回复、修订/tombstone、重启与同目录隔离、失败后保留及迁入恢复。固定真实 DeepSeek 样例曾验证保存、独立项目历史共享、重启和其他项目隔离；Edge 回归的模型回复为注入。

`packages/verification/tests/memory/` 的文件/协调回归覆盖文件已打开后的作用域及锁 owner 读取取消、sync 后发布前取消不覆盖原数据且释放 Store 锁、项目已发布而私有范围清空失败后的重放。既有测试继续覆盖损坏/超限文件、修订冲突、内存隔离、真实第二进程写入和锁恢复；文件边界重组不以真实模型或浏览器检查代替这些契约。

这些结果不代表广泛自然语言选择/使用质量或其他供应商质量已验收。自动提炼、语义合并、冲突消解、按任务语义筛选、文件来源/pin、索引和物理历史清理尚未实现；增强与广泛评估暂缓。恢复时先明确代表性任务及容量演进。
