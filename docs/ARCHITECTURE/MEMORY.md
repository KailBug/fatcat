# Memory：直接用户事实、作用域与修订

当前开发安排（2026-10-14）：用户将重心调整为 runtime 重构、Web UI 调整和 TUI 建设。本文的已实现 Memory 能力保留为兼容基线，后续增强和广泛质量评估暂缓；阶段 4 仍未整体完成。runtime / UI 改动影响 Memory 时，按实际边界做必要回归。近期工作线见 [ROADMAP.md](../ROADMAP.md#当前开发重心2026-10-14)。

状态：2026-10-14，`feat/rag-dev` 从 `0b71003` 继续资料与 Memory 计划阶段 4。当前增量已实现自然语言中的直接用户事实保存、可选主机管理命令、独立存储、通用读取、当前状态投影及迁入项目后的自动共享；固定真实 DeepSeek 场景已通过，见第 6 节，完整检查的最终结果以 [PROGRESS.md](../PROGRESS.md) 为准。模型自动提炼、合并与语义冲突处理尚未实现，广泛真实任务中的选择和使用质量尚待评估，不能据本增量将阶段 4 整体标为完成。范围与验收目标见 [ROADMAP.md](../ROADMAP.md)，资料研究见 [RAG.md](RAG.md)。

## 1. 当前闭环与模块所有者

用户在 chat、TUI 或 Web UI 直接陈述需要持续使用的事实、偏好、定义或决定，例如“你记住小狗喜欢 CSGO”，父模型通过现有通用 `write` 的 Memory 地址保存，不要求先输入 `/memory`。模型依据当前用户原话选择是否持久化及范围；主机验证来源、实际执行身份、修订与预算。后续父模型及委派请求读取最新有效记录，通过已有 `read` 展开有界清单或当前修订。

`/memory` 保留为可选管理入口：主机可直接查看、增加、修改和删除，不请求模型、不增加成功对话历史。自然语言保存走原 Agent Loop，工具结果属于该回合历史，不新增专用 Memory 工具或单独模型调用链。

父请求明确说明当前 Memory 写入能力可用，旧 assistant 回复中的“只能用 `/memory`”或“没有记忆写入能力”是历史能力声明，不能覆盖本次 SDK 实际工具 Schema。Memory 的保留地址修改 Session/Project 元数据，工作区 read-only/Plan 的文件限制及 file-write 审批不禁用该路径，普通文件权限继续生效。当前有效 Memory 中与提问相关的事实应先于通用世界知识使用，项目其他 Session 没有原聊天历史也能使用同一项目事实。

| 模块 | 实际职责 |
| --- | --- |
| `src/memory/record.ts` | 作用域、记录、来源与修订类型，严格解码及容量约束 |
| `src/memory/store.ts` | 独立作用域快照、修订冲突、进程锁、原子发布、内存模式及幂等迁入 |
| `src/memory/commands.ts` | 显式 `/memory` 命令解析、清单、来源和历史修订展示 |
| `src/memory/tools.ts` | 扩展通用 `read`，每次模型请求重新装配当前有效状态 |
| `src/memory/write.ts` | 仅父会话的通用 `write` Memory 地址、参数与证据校验、持久结果回传 |
| `src/session/agent-session.ts` | 当前用户回合的证据和来源、8 次尝试上限、callId 幂等缓存及自动任务拒绝 |
| `src/session/manager.ts` | 主机操作串行化，绑定实际执行身份与允许作用域，生成来源及迁入预览 |
| `src/session/store.ts` | 在共享 metadata gate 内重新验证 Session、Project、归属代次和有效目录 |
| `src/attachments/transaction.ts`、`store.ts` | 协调 Session/附件/Memory 的迁入决定、发布与故障恢复；不持有 Memory 正文 |
| `src/agent.ts`、`src/commands.ts`、`webui/controller.ts` | 共享父子 Agent 装配及三入口主机命令分发 |
| `src/workspace-agent.ts` | 实际 CLI/TUI/Web UI 使用的工作区 Agent 工厂；可选第三个 fetch transport 参数用于同一生产路径的注入与真实请求验收 |

沿用 TypeScript、Node.js 24、pnpm 11.21.0、现有模型 SDK 和简单 Loop，没有新增依赖、Embedding、数据库或检索框架。Memory 不依赖附件解析或 RAG，原件、派生内容、会话历史和 Memory 分别管理。

## 2. 自然语言保存、可选命令与来源

父会话使用以下保留地址，不增加新的工具名：

| 通用 `write` 地址 | 当前行为 |
| --- | --- |
| `memory:new` | 保存到实际执行 Session 的私有范围，或它所属的项目范围 |
| `memory:global:new` | 仅用于用户明确要求全局或跨项目使用的偏好 |
| `memory:<uuid>@<revision>` | 修改当前 active 修订；`content` 为精确空字符串时删除 |

Memory 写入参数仅为 `path`、`content`、`memoryEvidence`。证据必须是当前用户请求中的非空原文摘录，最多 2 KiB UTF-8；不能使用历史用户消息、工具、网页、子任务、assistant 或 compact 摘要的内容作为新的来源。主机从实际运行回合获取 Session、来源和归属，模型不能传入这些身份或另一个项目 ID。普通文件路径继续使用原 write 参数、权限、审批与执行记录，不能附带 `memoryEvidence`。

证据完全匹配当前输入只证明出处，不证明语义正确、用户意图或全局范围授权。实现没有用关键词/正则判断“是否想记住”的分类器：父模型按指导识别用户直接提供、适合后续使用的事实、定义、偏好及决定，尤其执行明确的记忆请求；不能把模型自己的推断或外部材料自动提炼成长期事实。只有工具返回成功后才可声称已保存。

可选管理命令为：

```text
/memory
/memory list
/memory show <id>
/memory add session|project|global <text>
/memory update <id> <revision> <text>
/memory delete <id> <revision>
```

命令 `add` 必须明确选择范围。独立 Session 可新增 `session` 或 `global`；项目 Session 可新增 `project` 或 `global`，不再新增私有 `session` 条目。两种入口的修改、删除都使用 UUID 和当前修订号，作用域由主机当前可见记录确定。过期修订、已删除或不可见条目明确失败；删除后的记录不能直接恢复成 active。

每条记录保留 UUID、作用域、当前修订、active/deleted 状态、更新时间和完整 `changes`。每个修订保存当次内容、状态及 `source = { sessionId, request, turn, evidence?, requestExcerpt? }`。自然语言入口记录当前实际用户请求和匹配的 evidence，`turn` 为此前已完成的模型用户回合数加一。原请求超过 2 KiB 时保存有界证据摘录作为 request，并明确 `requestExcerpt: true`，不伪装成完整请求。主机命令保留命令原文，`turn` 为当时已完成模型回合数，新会话为 0；它不是命令计数或工具调用次数。旧记录没有可选证据字段仍可解码。修改后可通过 `/memory show` 查看早期来源与内容；本增量没有固定文件来源或附件 pin。

每个实际用户回合最多 8 次通过证据校验的 Memory 变更尝试，失败写入也占尝试额度；同 callId、同参数在当前串行回合内返回已提交结果，不重复写入，不同参数复用 ID 明确拒绝。Loop 原有的模型重复 callId 拒绝规则不变。新增内容与当前范围某个 active 条目的正文完全相同时直接返回既有记录，保留原来源和修订；不进行语义去重、自动合并或 tombstone 复活。

删除新增一个正文为空的 tombstone，保留历史审计；模型读取不返回已删除正文或历史修订。`/memory show` 属于用户主动查看历史的主机操作，仍可展示已删除条目的旧内容。删除不是物理擦除，也不能抹去已存在于原对话或 compact 摘要中的文本。

持久化是已发生的独立副作用。Memory 已保存后，后续模型请求、取消或 Session 检查点提交失败不会回滚该条目；下一次请求读取当前有效记录，不自动重放前次变更。模型推断、工具结果和 compact 摘要不会自主写入，不能因重复提到某事实就把它当作新的用户来源。

## 3. 作用域与实际执行身份

独立会话读取自己的 Session 范围及 global；项目会话读取项目范围及 global。global 是同一存储根中的显式全局范围，不由目录相同、偏好内容或模型推断自动产生。不同项目、同目录独立会话和猜测到的 UUID 均不构成读取授权。

`SessionManager.activate` 在目录 Tools 缓存外绑定 `MemoryAccess`。`SessionStore.withMemorySession` 持有 metadata gate，重新加载当前 Session/Project，核对 Session ID、Project ID、locationRevision、projectRevision 和有效 workspace，再执行 Memory 操作。工作区变更、删除或过期身份不能继续使用旧访问器。后台任务使用其绑定 Session；子请求继承父请求作用域，浏览器当前选择不改变执行对象。

Memory 文本只是用户数据，不能授予文件、命令或网络能力，不能改变权限模式、启动上限、审批或预算。两种保存入口操作的是受控 Memory 元数据，不以工作区文件 write 权限为前提；普通文件修改继续落实原权限。自然语言变更仅绑定当前父会话的活动用户回合，并在 metadata gate 内重新核对实际 attempt 的 ownerPid、startedAt 和 running 状态；子任务只读 Memory，自动任务变更被拒绝。此处的作用域隔离是 Memory 接口边界，沿用现有 shell/Free to go 的本机访问说明，不构成 OS 沙箱。

无持久化模式使用 Manager 独立的内存 MemoryStore，global 也只在该 Manager 生命周期内共享，不读写持久全局记录。新草稿的查询不保存空 Session；首次主机修改先保存来源 Session，自然语言回合沿用执行前的 Session 持久领取，再发布 Memory。若 Session 保存成功而 Memory 写入失败，可能留下一个已保存的会话，不会发布无来源私有条目。

## 4. 最新状态、通用读取与预算

`read` 支持 `memory:list` 和 `memory:<uuid>@<revision>`，不增加独立模型工具。清单包含当前 ID、范围、修订和 active/deleted 状态；支持从零开始的 offset、默认 20/最大 64 的 limit，以及对 active 正文的大小写敏感字面 query。清单最多 16 KiB，`nextOffset` 指示后续页。精确引用只返回当前 active 修订及来源，旧修订和删除条目返回 `MEMORY_STALE`，不可见 ID 返回 `MEMORY_NOT_FOUND`。

`withMemoryContext` 在每次实际父子请求前重新读取记录，将完整当前 manifest 和部分 active 正文加入请求副本。notice 的序列化上限为 24 KiB，其中正文集合最多 8 KiB；正文未放入 notice 的 active 条目可继续通过 `read` 展开。模型 SDK 继续检查加入这些内容后的完整请求字节数，超限不会绕过原预算或静默遗漏 manifest。

当前 manifest 明确取代历史中的旧 Memory 有效状态：不在当前范围、修订过期或已删除的条目不能因恢复、fork、旧 read 结果或 compact 摘要重新生效。请求 notice 不写入成功历史，普通工具读取结果仍按既有规则保存在历史中；保留历史不代表旧条目继续有效。该机制提供当前状态证据，不承诺真实模型一定不会重复旧对话中的事实。

| 存储/请求边界 | 当前上限 |
| --- | --- |
| 每作用域记录数 | 64，包含 tombstone |
| 每修订正文 | 1 KiB UTF-8 |
| 每修订来源请求 | 2 KiB UTF-8 |
| 每条记录修订数 | 32，最后一个修订保留给删除 |
| 每作用域 JSON 文件 | 64 MiB，包含正文、来源及证据的 JSON 转义开销 |
| 每用户回合的模型变更尝试 | 8；同 callId 的已提交相同结果复用 |
| 通用读取清单页 | 16 KiB；最多 64 项 |
| 每次请求 notice / 其中正文 | 24 KiB / 8 KiB |

持久文件位于 Session 存储根的 `memory/`，按 `session-<uuid>.json`、`project-<uuid>.json`、`global.json` 分开保存。Store 使用有限读取、格式/身份/修订校验、`store.lock` 和临时文件同步后 rename；跨进程更新以锁及预期修订保护，取消、损坏或写盘失败不会用空记录替换旧数据。运行配置凭据不进入这些记录。

## 5. 迁入、fork 与删除生命周期

2026-10-14 用户已明确：独立 Session 迁入项目时，全部既有私有 Memory 自动归项目所有，供所有项目 Session 使用。这取代此前“默认保留私有、另行选择分享”的建议。迁入预览展示 active 私有条目数量和共享影响，确认绑定全部条目的 ID/修订/状态指纹；Memory 在预览后变化时要求重新预览。

迁入保留 UUID、原来源和全部修订，仅改变顶层 scope；deleted 条目及历史一并迁入，不能重新生效。预览的 `memoryFingerprintExpected` 随 Session 保存传入同一 metadata gate，在日志发布前重新核对私有记录并预检目标容量/冲突，避免预览与保存之间的并发修改被静默共享。随后发布包含 `memoryMove = { sessionId, projectId }` 的 v3 恢复日志。日志是持久决定：先幂等发布项目 Memory、清空原私有范围，再发布新的 Session 归属及附件关联。读者必须先恢复日志，不能观察半完成迁入；恢复会去重已经发布的相同记录，拒绝相同 ID 的不一致内容。v1/v2 日志继续兼容恢复；旧程序不能忽略 v3 的 Memory 决定，升级时须停止旧实例。

独立 Session fork 只复制历史，不复制私有 Memory；项目 fork 继续读取同一项目 Memory，global 范围不变。删除记录来源 Session 不删除项目/global Memory。删除独立 Session 或整个项目后，对应私有/项目范围不能再通过 Memory 接口访问，旧执行身份失败；本增量保留磁盘上的孤立范围文件，不进行物理清除或垃圾回收。项目删除仍不删除工作目录文件。

## 6. 验收映射与剩余范围

以下说明本增量与路线图验收的关系；最终命令结果及失败/修正记录集中于 [PROGRESS.md](../PROGRESS.md)。离线测试使用临时数据、虚构凭据和注入模型。`memory-factory.test.ts` 直接使用生产 `workspaceAgentFactory` 及 SDK 传输，覆盖 Manual、read-only、Plan 三种模式：加载含过时拒绝回复的合成历史，校验当前工具 Schema、能力覆盖说明及元数据权限，再根据请求中的实际能力选择 write/read；另一项目成员独立历史读取、重新创建工厂后恢复、同目录其他项目隔离，以及原目录 Tools 缓存不受污染均在该层检查。

`pnpm run verify:memory:live` 已通过固定真实 DeepSeek 验收：合成会话先保存旧的“只能用 `/memory`”回复，再提交中文原话“你记住狗狗最喜欢玩CSGO，听见没？”；真实模型完成一次 Memory 写入，项目 P 的独立会话 B 和重启后的 B 均使用 CSGO 事实，项目 Q 请求没有该事实或 Memory。此次共 5 个真实请求，服务报告输入 29494、输出 574、总计 30068 tokens。脚本只使用临时合成材料，通过 DeepSeek 专用 `loadLiveConfig`，排除用户 Skills，最多 16 请求、总时限 120 秒、单请求 20 秒；不读写真实用户会话作为测试夹具，也不切换到其他供应商。

`pnpm run verify:memory` 已通过真实 Windows Edge 的桌面 1280 和移动 390 宽度回归，覆盖自然语言保存、来源、共享预览的取消/确认、私有迁入项目、两个独立项目聊天使用当前事实、自然语言纠正/删除及可选主机命令；页面无运行错误，9 个模型回复均为注入数据，没有调用真实 API。完整离线运行结果以 PROGRESS 为准。用户此前真实记录的只读核对发现旧回复没有执行 Memory 工具、没有形成条目；该核对未修改用户历史或补写 Memory。固定真实场景通过不代表广泛自然语言保存质量、多供应商或完整阶段 4 已验收。

| 路线图 | 当前实现与检查位置 | 剩余边界 |
| --- | --- | --- |
| S4-01 项目跨会话使用 | 自然语言通用 write、独立历史/重启共享、范围隔离；`memory-conversation` / `memory-factory` 及固定 DeepSeek live 场景 | 固定场景已验，广泛真实任务与其他供应商质量待评估 |
| S4-02 私有与显式 global | 明确范围的命令、持久/内存隔离；`memory-store` / `memory-session` | 不自动将私有/项目条目提升为 global；语义判断由模型负责 |
| S4-03 修改删除与旧历史 | 当前修订读取、tombstone、请求 notice、恢复/fork/compact 历史失效；`memory-tools` / `memory-session` | 审计及旧对话文本不物理擦除 |
| S4-04 推断与权限 | 当前用户证据、长请求摘录、子任务/自动任务拒绝、原文件权限；`memory-conversation` / `memory-runtime` / `memory-write` | 证据匹配不等于语义授权分类；模型不得提炼外部或自身推断 |
| S4-05 恢复、冲突、失败 | 修订/容量/锁/取消/I/O、第二 Node 进程、回合限额/失败后保留及迁入日志；`memory-store` / `memory-runtime` / `memory-migration-transaction` | 物理孤立范围清理未实现 |
| S4-06 迁入自动项目所有 | 预览指纹、目标容量预检、来源保留及幂等重放；`memory-session` / `memory-store` / `memory-migration-transaction` | 不提供保留私有选项；解除关联和跨项目迁移仍未开放 |

本增量不包含自动提炼、自动合并、冲突语义处理、向量索引、相关性排序或后台全量扫描。当前正文按有界枚举装配，不宣称已经按任务完成语义选取；自然语言保存依赖父模型选择直接用户事实并通过有界通用 write 执行。固定真实场景已验证旧能力拒绝后的保存与跨会话使用；后续增强与广泛质量评估当前暂缓，恢复本方向时再扩大代表性任务和供应商质量评估，并决定筛选与容量演进。不为这些计划预建接口或依赖，阶段 4 尚未整体完成。
