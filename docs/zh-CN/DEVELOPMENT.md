

<a id="development-and-verification"></a>

# 开发与验证

[English](../en/DEVELOPMENT.md) | 简体中文

[文档首页](README.md) · [仓库规则](../../AGENTS.md) · [架构](ARCHITECTURE/README.md)

<a id="local-checks"></a>

## 本地检查

在原生 Windows 上使用 Node.js 24.x 和 pnpm 11.21.0，从仓库根目录执行：

```powershell
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm run build
pnpm test
```

`typecheck` 检查包边界，构建五个产品包（JavaScript/声明及 runtime 内置 Skills）、verification JavaScript 与原生探针、独立 eval 包，再对根启动适配器做无产物类型检查。`build` 完成相同依赖构建和资源复制，再编译根启动适配器。`test`、`start` 和专项验证均先构建。根 `pnpm test` 经 pnpm 顺序执行 eval 和 verification 离线套件。请顺序运行这些命令，避免争用构建输出。按修改范围选择检查；纯文档通常只需链接、引用和 diff 检查。

普通测试使用假凭据和注入模型 transport，不加载 `.env` 或联系供应商，可使用真实临时文件与固定 PowerShell 命令，不启动 Edge。离线协议测试不验证凭据、连通性、模型质量或真实视觉行为。

模型契约位于 `@fatcat/runtime/model-types`，工具定义位于 runtime `tools/types.ts`。边界检查将 OpenAI SDK 导入限制在 `model.ts`、`model-adapters/chat-completions.ts`、`model-protocol.ts`。注入 Model 和持久历史使用规范消息；HTTP 夹具使用 verification `tests/support/chat-protocol.ts` 的独立 wire 类型。模型检查覆盖准备/发送的精确 JSON、完整编码字节、图片和可恢复非法参数。会话测试覆盖当前格式、持久工具历史、中断 attempt 和不重放的恢复；没有旧格式转换或兼容套件。

Windows 上使用 OS 分配端口的 HTTP 夹具可能在发请求前偶发 Node fetch `bad port`。保留失败日志，重跑时区分它与路由/断言失败。重跑通过并不解决现有端口分配限制。

启动与本地配置检查使用 `pnpm start --help` 和 `pnpm start --checkConfig`；配置校验不联系模型。安装见[快速开始](QUICK_START.md)，环境变量见[配置参考](REFERENCE/CONFIGURATION.md)。

<a id="workspace-package-boundaries"></a>

## Workspace 包边界

pnpm workspace 包含私有根应用、`@fatcat/runtime`、`@fatcat/commands`、`@fatcat/tui`、`@fatcat/webui`、`@fatcat/cli`，以及仅开发使用的 `@fatcat/verification`、`@fatcat/eval`。Runtime 拥有共享执行、能力状态和持久化；commands 拥有共享宿主命令分发、能力处理器、确认状态、会话标签及参数/输出辅助。TUI 在 `packages/tui/src` 拥有 App、视图、遥测和终端生命周期；Web UI 在 `packages/webui/src` 拥有 HTTP、Controller、浏览器视图和资源；CLI 在 `packages/cli/src` 拥有参数解析、启动编排、终端 chat/input 和审批展示。Verification 在 `packages/verification` 集中维护离线测试、夹具、专项运行器及依赖。根目录保留 pnpm 启动适配、workspace 编排、文档与示例。

通过明确包子路径导入 runtime，例如 `@fatcat/runtime/agent`、`@fatcat/runtime/session/manager`，指向已构建 `.js`/`.d.ts`，不使用源码别名；包内使用相对导入。依赖方向为根启动适配器 → CLI → TUI/Web UI → commands → runtime；CLI/客户端也可直接使用 commands/runtime。CLI 可加载 TUI/Web UI，客户端不能依赖 CLI，也不能互相依赖或依赖根应用代码。Commands 只能导入 runtime 导出及自身相对模块。产品包不能导入 verification/eval 或根 scripts；runtime 不反向依赖 commands/客户端，commands 不依赖客户端。禁止跨包相对路径及导入他包 src/dist，不保留旧根 runtime、command、TUI、Web UI、CLI 转发模块。

导出映射面向实际宿主消费者。白盒测试和专项验证可用 `@fatcat/runtime/internal/*`，这是明确不稳定的验证表面，不是生产 API 或旧路径兼容层。不要仅为测试扩大宿主导出；新增真实宿主消费者时审查并显式添加子路径。包边界不改变 Session、Store、权限或事务所有权。

Commands 在 `@fatcat/commands` 导出分发器，在 `/automation`、`/context`、`/memory`、`/session` 导出能力入口，在 `/session/labels` 导出标签，直接映射实现模块，不设兼容 barrel 或注册器。Project/Attachment 处理器及参数辅助保持包私有，因为外部消费者目前使用统一分发。

TUI 仅通过 `@fatcat/tui` 导出 runTui，启动器在 CLI 校验和输入交接后惰性加载。测试/原生验证使用 `@fatcat/tui/internal/*`，生产不得使用。导入不能启动输入、安装信号处理或执行模型请求。

Web UI 通过 `@fatcat/webui` 导出 runWebUi，CLI 在参数校验后惰性加载。`@fatcat/webui/internal/*` 仅供验证。HTTP、Controller、显示契约、浏览器模块、静态资源和原生目录 helper 留在该包，保持状态所有者。服务/helper 资源相对构建模块定位，不依赖 cwd；导入不监听、不打开浏览器、不注册信号或请求模型。

Verification 为无库导出/barrel 的私有开发包。tests/、verify/、scripts/ 编译到自身 dist 对应位置，不需声明。五个产品包及外部夹具/浏览器依赖都是直接开发依赖。产品包不得声明 verification 依赖（含 devDependency）或导入其文件。只有 verification 可消费产品 internal/*；测试与运行器同样接受边界检查。

根 pnpm test 和 verify:* 保持命令名、参数、env-file 行为，先构建再调用对应可执行入口。构建/安装/类型检查 verification 不执行运行器。离线入口从模块定位包根，只发现 tests/**/*.test.ts，浏览器/原生/网络/live 在清单之外。scripts/copy-resources.mjs 将原生探针复制入构建。启动适配回归有意执行根 dist/scripts/start.js，版本回归读根 manifest，live 读取仍用 examples/workspace；这些是明确 checkout 资源，不是运行时代码导入。

CLI 的 `@fatcat/cli` 导出可调用 runCli，`@fatcat/cli/entry` 为执行 argv 的进程入口，直接映射所属模块。验证用 `@fatcat/cli/internal/*` 检查 parser/chat/terminal；进程测试通过 import.meta.resolve 定位可执行入口，不依赖相对构建目录。可调用入口导入时不得执行 argv 或接管输入。VERSION 读取相邻 CLI manifest，边界检查要求与根版本一致，应一起更新。

浏览器模块仍为通过显式 HTTP 白名单提供的 ESM。可 type-only 导入 runtime/server 类型，实际 emitted imports 必须留在 dist/client。`packages/webui/scripts/copy-assets.mjs` 检查字面导入并复制资源，计算型导入需显式审查。不要暴露服务端文件、source map、声明或原生 helper。保留 URL、capability 和 CSP；包导出不扩大静态白名单。

每个外部依赖由使用它的包直接声明。Runtime 拥有模型、解析、网络和浏览器依赖；TUI 拥有固定 pi-tui；verification 直接声明终端/文档夹具及浏览器检查的开发依赖。保留固定版本和共享锁文件。`pnpm install --frozen-lockfile` 链接 workspace；`pnpm run check:boundaries` 检查当前静态/字面导入、导出使用和直接依赖，typecheck/build 自动运行。计算型加载无法静态推断，须单独审查。

`tsconfig.base.json` 维护严格 ESM/NodeNext 设置。产品 src 编译至各自 dist 并带声明，verification 不带声明，根仅编译启动适配器。根 typecheck/build 选择 ./packages/*，由 pnpm 按依赖顺序构建（runtime、commands、独立 TUI/Web UI、CLI、verification），不依赖陈旧声明。Runtime copy-skills.mjs 校验复制到 dist/skill，运行时相对模块定位。Web 资源和目录脚本复制到自身 dist。共享品牌源 images/logo/mini-logo.png 留在仓库，构建时复制进 Web；运行包不读取根图片或源码目录。迁移时保留 worker 入口、资源和调用目录行为。

产品离线测试集中在 `packages/verification/tests/`。harness/runtime-package.test.ts 覆盖包解析、公开/阻止路径和无关 cwd；commands-package.test.ts 检查导出及同一 Manager 跨入口确认失效；tui-package.test.ts 检查无副作用导入/私有路径；webui-package.test.ts 检查导入、私有路径、无关目录 HTTP/原生资源；cli-package.test.ts 检查可调用入口与私有路径，现有 CLI 子进程/Skills 检查覆盖入口资源。迁包后仅清理对应过时产物，核对源码/编译清单，运行 typecheck/离线测试，并用注入模型验证受影响原生终端和 Edge。公网/live 检查有独立范围。

独立私有 `@fatcat/eval` 在 packages/eval/src 维护协议/统计，tests 维护测试/夹具，scripts 维护离线入口，编译至自身 dist，不产声明/公开导出。目前没有运行时依赖。产品不能依赖 eval（含 devDependencies）；eval 与 verification 互不依赖，eval 不允许消费产品 internal/*。未来 Session 适配器须声明实际 runtime 依赖并使用审阅导出。普通导入/构建/测试不加载凭据、不联系供应商、不启动实验。

Eval 已纳入 workspace glob、根依赖构建、锁文件和含测试/scripts 的边界扫描。其测试入口同样按当前源清单发现，缺编译输出或空清单即失败。不新增跨包 helper 或兼容 barrel。已实现契约和未实现执行见 [Eval](ARCHITECTURE/EVAL.md)。

<a id="internal-interfaces-and-compatibility"></a>

## 内部接口与兼容

内部 API、命名、路径可为明确所有权而调整，同一增量更新全部生产调用、测试、验证脚本和文档。从所属模块导入 helper/类型，删除仅为历史路径保留的转发和 re-export。明确公共 facade 或外部消费者可构成兼容理由，但需记录契约/原因，不能视每个 exported symbol 为永久。

除非任务明确改变，保留用户命令/输出、恢复、状态所有权、权限、取消及副作用顺序。开发期会话格式可调整而不保留旧 reader/migration；不得自动删除/改写已有用户文件。上线后按[项目边界](PROJECT.md)建立兼容要求。

<a id="cli-parsing-and-startup-boundaries"></a>

## CLI 解析与启动边界

cli.ts 保持 argv/退出码入口。`packages/cli/src/cli/options.ts` 拥有定义、帮助、可选 resume 规范化、隐式 chat 和组合校验，返回类型化数据，不加载配置/存储/输入/信号。cli/run.ts 拥有编排及错误/清理；导入两者都不能执行 argv。包根映射 run.ts，/entry 映射 cli.ts；保留可调用/可执行区分及根适配器/子进程的真实入口，不加旧路径转发。

保留校验与提前返回顺序：语法/组合错误先于 help/version；管道无选择值 resume 先列会话，再检查空 prompt、TTY 或供应商。配置检查和自动任务文件/监控路径保持阶段，不把所有校验塞进 parser 或为本地操作提前加载凭据。默认权限和实施仍归 PermissionPolicy，解析不授权。

启动器拥有取消控制器和临时 TerminalInput；chat 复用 picker 输入，TUI/Web UI 启动前关闭，避免争抢。保留信号注册、取消转发、stdout/stderr、finally 清理顺序。只有 scripts/start.ts 恢复 pnpm 调用目录，直接 CLI 忽略继承 INIT_CWD。不引入客户端启动框架或将 Session 状态移入启动器。

Parser/子进程回归在 `packages/verification/tests/cli/`，包含竞争错误、-- 字面值、可选 resume、无凭据路径和启动目录。输入交接改动除 typecheck/离线外，运行下述注入模型 Windows 终端检查。[架构](ARCHITECTURE/README.md)维护模块，[命令](REFERENCE/COMMANDS.md)维护语法。

<a id="host-command-boundaries"></a>

## 宿主命令边界

共享命令在 packages/commands/src 按能力维护解析、帮助、输出：project/commands.ts、attachments/commands.ts、automation/commands.ts 及 Context/Memory。使用显式处理器，不引入注册器/插件框架。会话/工作区命令在 session/commands.ts，文本解析/转义在 utils/command.ts，标签在 session/labels.ts。

commands.ts 直接组合 Project/Attachment 分发和帮助；runSessionCommand/sessionCommandHelp 仅会话。包外标签从 @fatcat/commands/session/labels、Cron prompt 从 @fatcat/commands/automation 导入。新处理器将未匹配输入留给调用方，保留校验顺序、错误码/信息、输出、取消和 switched；移动 parser 不静默改语法。

处理器调用既有 SessionManager，不拥有另一 active record、不加持久化、不绕权限/锁。临时确认属于命令交互，绑定 Manager/预览，保留成功/失败下的消费和失效时机。自然语言 /cron 仅准备 prompt，本地管理不得调用模型。[Session](ARCHITECTURE/SESSION.md)维护路由与状态。

行为测试随能力归属，入口解析随客户端。检查统一分发、能力处理及跨领域生命周期，特别是切走再返回后的确认失效。使用注入模型/临时存储，确认本地命令不进入模型历史。

<a id="session-capability-boundaries"></a>

## Session 能力接入边界

接入规则放在 session/attachments.ts、memory.ts、automations.ts、projects.ts。传明确 Store、身份、来源或快照，不传整个 Manager、不新建 active record 所有者。Manager 保留选择/操作锁/草稿持久化/激活；AgentSession 保留回合，Store 保留持久与事务。内部导出随归属迁移并更新调用者。

Memory 整个作用域读取/变更必须处于 Manager 身份/owner 门禁及持久 metadata 锁内。绑定实际执行会话，每次重验；不缓存授权、不替换为 UI 选择。保留草稿保存、取消、来源、额度、结果复用和独立已提交副作用。memory/ 测试覆盖捕获绑定与含 tombstone 的迁入指纹。见 [Session](ARCHITECTURE/SESSION.md)、[Memory](ARCHITECTURE/MEMORY.md)。

Automation 的投影、资格、截止信号和变更校验在 session/automations.ts。Manager 加载刷新记录、查 owner、选前台/后台目标并持有锁/释放顺序；AgentSession 独占领取计数与收尾，scheduler 持有租约/队列/基线。不缓存资格、不把计数移 helper、不因后台切前台、不新增 task store。automation/ 回归覆盖过期触发、领取前后取消、隔离与释放。见 [Automation](ARCHITECTURE/AUTOMATION.md)。

Projects 预览/确认共用完整组装，但每次新读 Memory/附件；Memory 保留身份门禁，最终修订保留事务内验证。草稿 helper 仅准备记录；Manager 保留锁、目标、Agent 准备/激活。改目录先准备草稿，删除活动项目先准备替代，rename 刷新失败不撤销提交。不将整个 Manager 包装为 Project service 或迁入事务锁。projects/ 回归覆盖范围、陈旧预览、草稿和失败。见 [Projects](ARCHITECTURE/PROJECTS.md#session-integration-boundaries)。

<a id="session-snapshot-and-storage-boundaries"></a>

## Session 快照与存储边界

session/snapshots.ts 仅文件机制：明确 root/bucket、桶发现、有界读取、物理桶验证、原子发布和删除。复用 record.ts 当前编解码，不解析项目、选择会话、缓存或另建 Store。关闭快照句柄后 Store 才解析当前项目；读取不能写数据或创建缺失存储。

SessionStore 保留查询、投影、操作验证、锁、revision/owner 和跨文件协调。条目上限、排序、选择匹配、重复检测、损坏处理留在各操作。普通列表可跳过损坏，直接 ID 报错，项目管理拒绝可能隐藏成员的扫描；不以宽松列表发现成员。

发布/删除 helper 不是 Store save/delete 的替代，仅通过既有锁内事务回调调用；保留 storageWorkspace、大小、模式、sync/rename/cleanup 和错误。不要迁入 metadata/project/bucket 锁或恢复，不泛化 Store 为通用文件系统框架，不加兼容转发。

回归放 session/，项目/附件事务留在能力下。运行 typecheck/离线，覆盖当前格式、损坏/超大、固定桶、发布失败、冲突、活跃 owner 和不重放恢复。仅持久代码迁移不要求客户端专项，交互改变才运行。见 [Session](ARCHITECTURE/SESSION.md#snapshot-file-and-storage-coordination-boundaries)、[Metadata](ARCHITECTURE/METADATA.md)。

<a id="attachment-file-and-publication-boundaries"></a>

## 附件文件与发布边界

attachments/files.ts 仅暂存路径、流式写入、有界大小/哈希验证和 owner 读取。传明确路径/目录/流/信号/预期元数据；helper 关闭自身句柄并返回文件结果，不接收 Store、不锁 metadata、不解析 Session、不发布 catalog 或另建上传所有者。读取 owner 不授予所有权，验证字节不授权。

AttachmentStore 保留领取/回收、token、幂等、目标验证、草稿、catalog 和提交顺序。三阶段明确：gate 内领取，gate 外接收，再 gate 内重验/发布暂存。保留取消与先 close 后 cleanup；只清捕获 token 的 part，删 json/lock 前重验。旧流结束不能发布或丢弃新重试。

completeUpload 保留原 gate，包括目标重验与原件验证先于可见关联。保留 blob 路径、大小、哈希、模式、格式、错误和恢复。record.ts 仍校验，metadata/transaction.ts 仍跨文件提交；不把非持久附件/解析混入文件 helper。调用者直接迁移，不保留 re-export。

attachments/ 回归覆盖暂停流、失败 producer、token 隔离清理、损坏暂存、草稿发布和真实第二进程所有权/恢复。运行 typecheck/离线；改宿主上传交互才补 Edge，仅提取文件机制不必重复浏览器。见 [Attachments](ARCHITECTURE/ATTACHMENTS.md#staging-and-publication-coordination-boundaries)。

<a id="metadata-journal-and-transaction-boundaries"></a>

## Metadata 日志与事务边界

MetadataCommit 与纯日志编解码放在 `packages/runtime/src/metadata/journal.ts`。复用 record codec，保留磁盘版本和跨记录验证，传明确值而非 Store/当前会话。内部接口迁移不取消持久格式兼容：普通提交 v2、Memory 迁移 v3，reader 接受 v1/v2/v3。不要仅为整理代码加版本或序列化解码后的运行时投影。

metadata/transaction.ts 的 MetadataTransactions 保留每根队列、进程锁/恢复、预检大小、持久决定和有序执行。发布前校验完整编码日志，写原编码形状、执行校验结果。保留 Memory 先于 Session、原件先于关联、catalog 先于删除，固定桶、幂等成员 patch、注入发布/删除及回退。全部效果成功才删日志。日志读取保持在恢复错误包装之外，读取错误与解码决定错误保留区别并阻止操作。

catalog IO 在 attachments/catalog.ts，原件/派生路径清理在 attachments/files.ts，由调用者持有既有 gate。协调器通过 MetadataSessionAccess 仅接收 Session 发布/删除回调；AttachmentSessionAccess 属于 AttachmentStore，另有 load/prepareDraft。Store 保留领域校验/关联/生命周期，不建第二所有者或通用事务注册器。metadata.lock、attachments/pending.json、记录位置、错误码/信息不变。

metadata/files.ts 维护明确路径/字节上限的 JSON 读取与原子写入，保留严格 UTF-8、仅缺失可选、模式、sync/close/rename/临时清理。Helper 不锁、不选事务目标、不决定恢复、不授权附件/文档。暂存和缓存直接导入，不经协调器转导出、不泛化无关 Store。

metadata/ 测试维护日志/文件回归，project 删除/成员及 Memory 恢复留在各域。运行 typecheck/离线，覆盖旧日志格式、发布前无效/冲突、部分提交恢复、第二进程 owner、错误边界和失败发布。宿主交互变化才加浏览器/终端。见 [Metadata](ARCHITECTURE/METADATA.md)。

<a id="memory-file-and-storage-boundaries"></a>

## Memory 文件与存储边界

`packages/runtime/src/memory/files.ts` 维护作用域读取、原子发布、有界 owner 读取；传明确目录、scope、record、lock path、signal，复用 record.ts key/校验。仅拥有自身句柄，不接收 MemoryStore、不建根、不锁、不解析身份、不缓存授权。文件限制和函数直接导入，不由 Store 转发。

MemoryStore 保留每实例 Map/队列、目录创建、进程锁/恢复、条目/修订限制、变更规则、迁移指纹与冲突。持久操作保持原锁；内存模式隔离、复制调用数据、不落盘。Session 模块仍拥有身份/attempt owner、回合预算与 call-ID 复用。

保留 v1 scope envelope、文件名、64 MiB、符号链接拒绝、严格 UTF-8、缺失/损坏区别。保留读取及 rename 前取消、文件模式、sync/close/rename、清理和 MEMORY_IO/MEMORY_LIMIT/CANCELLED。Owner 解析传播取消，不能当无 owner；仅协调器决定陈旧。不要换用取消/链接/错误语义不同的附件 JSON helper。

迁移在 Store 锁内验证源指纹和目标容量/冲突，先发布项目再清私有，重放去重已发布记录。MetadataTransactions 保留跨所有者恢复；移动文件代码不创建新事务/权限。见 [Memory](ARCHITECTURE/MEMORY.md#scope-file-and-storage-coordination-boundaries)、[Metadata](ARCHITECTURE/METADATA.md)。

memory/ 回归覆盖打开后读取取消、sync 后发布前取消、发布失败清理、中断迁移、损坏文件、内存隔离与跨进程锁。使用临时存储和确定性故障/取消注入。运行 typecheck/离线；宿主交互改变才加浏览器/终端。

<a id="project-file-and-storage-boundaries"></a>

## Project 文件与存储边界

`packages/runtime/src/project/files.ts` 维护有界 record 读取、原子创建发布和 owner 读取。传明确 metadata 目录、ID、record 或锁路径，复用 record.ts。保留 Project v1、文件名、64 KiB、严格 UTF-8/JSON、模式、sync/close/rename/清理。Helper 拥有句柄，不拥有锁、目录创建、workspace 解析或 Session。不加转发或通用框架。

ProjectStore 保留名称/workspace 校验、目录创建、列表条目限制/筛选/排序、revision、gate 和锁/恢复。列表只跳过 PROJECT_CORRUPT/PROJECT_NOT_FOUND，直接读取报告；存储失败不能变为空或部分成功。读取缺失 Store 不建目录。加载保存项目不要求工作目录存在；创建校验目录，Session 决定当前可用性且不回退。

保留 metadata gate → project lock → session bucket lock。loadUnlocked/withProjectUnlocked 有已持 gate 的真实调用者，保留前置条件，不重复 gate 或绕 Store。读取 PID 不决定陈旧，存活、恢复 gate、释放仍属 Store。

创建走项目文件 publisher/PROJECT_STORAGE，管理变更走 MetadataTransactions 日志、顺序与恢复错误；不为复用而互相改道或改变失败行为。见 [Projects](ARCHITECTURE/PROJECTS.md#project-file-and-storage-coordination-boundaries)、[Metadata](ARCHITECTURE/METADATA.md)。

projects/ 回归覆盖严格读取与列表区别、坏/超大记录、发布/清理失败、revision 冲突、活跃/不完整/死亡 owner、跨进程管理恢复和 Session 项目投影。运行 typecheck/离线，交互改变加浏览器/终端。

<a id="web-ui-controller-boundaries"></a>

## Web UI Controller 边界

共享显示类型在 packages/webui/src/types.ts，无状态历史/事件转换在 turns.ts；从归属导入，不由 Controller 转发。Helper 只接收显式历史/事件并返回显示数据，不持 Controller、Manager、锁或第二 transcript。复用实际附件证据；context usage 直接来自 runtime ContextUsageSnapshot，不建客户端观察累计。

Controller 拥有 active/changing、transcript、revision、审批和关闭。执行分发为 private method；任何可同步发事件/请求审批的调用前先设置 active。保留手动命令/自动 prompt 路由、后台可见性、主请求身份、证据资格、显示限制和清理顺序。最终列表/只读上下文刷新仍在 active 生命周期内，不提前释放锁；预览失败仍须收尾。

管理操作明确 restore/preserve 意图。Runtime 拥有 usage 恢复/重置：模型切换与 compact 保留累计和历史观测，新会话/fork 有独立计量。生命周期变化后刷新估算，不在客户端清历史。附件 revision 保留原边界；保留成功/失败刷新顺序及部分已提交效果。失败可刷新元数据供重确认，不自动重放或替换对话。webui/ 回归覆盖同步审批、取消、刷新失败、后台和恢复证据。见 [Web UI](ARCHITECTURE/WEBUI.md)。

<a id="web-ui-browser-view-boundaries"></a>

## Web UI 浏览器视图边界

client/app.ts 拥有权威快照、ETag、连接/发送、草稿及请求/轮询，协调菜单、弹窗、审批、滚动和预览重置。`client/transcript.ts` 中的 TranscriptView 仅持回合节点/签名；`client/session-list.ts` 中的 SessionListView 仅持列表节点/签名、项目折叠偏好（localStorage/内存回退）和格式器。ComposerMotion 仅展示/计时，由入口提供启用和焦点回调，不提交/改草稿。SettingsPanel 仅模态/焦点/浏览器主题，会话动作回调入口。显式传数据和具体回调，不另建 app store、不让视图请求 API。菜单/详情统一从列表归属导入 displaySessions。

移动渲染时保留 DOM 复用、展开详情、捕获的来源 Session ID、预览路径筛选、分组和键盘/拖放。事件时读取实时可操作状态，drop 按入口当前快照解析。即使签名相同跳过渲染，也更新禁用状态。请求完成、草稿清空、旧 revision 拒绝、滚动和焦点顺序不变。

新浏览器模块必须加入 server.ts 静态白名单并扩展 webui/ HTTP 资产检查；编译不等于 URL 可访问。DOM/焦点/交互用现有注入 Edge，helper probe 在 verify/browser/support。verify:webui 检查缓存、展开、来源和拖放门禁；跨组件用项目、文档/附件专项。它们不验证真实供应商或原生目录框。见 [Web UI](ARCHITECTURE/WEBUI.md)。

verify:webui 还检查元数据搜索、轮询/草稿及折叠恢复；指针/键盘预览调整、边界、取消、重载、覆盖切换；CommonMark/GFM、字面代码、附件引用、标题焦点、危险链接拒绝和惰性 HTML。截图在桌面/320px、双主题覆盖表格和嵌套内容。固定 Marked ESM/许可证从直接依赖构建复制，浏览器导入须 client-local 并显式白名单，不用 CDN/浏览器 Node 解析。

ModelControls 只持 modal DOM、签名和打开时临时选择；app.ts 提供快照、发请求、保留草稿。服务在 setModel 前比较 Session ID/revision/previous（含零 revision 草稿）。verify:webui-models 检查切换、离散 effort、未知/估算/实测及刷新；不以浏览器计算替代 runtime，也不为竞态削弱断言。

<a id="tui-turn-and-presentation-boundaries"></a>

## TUI 回合与展示边界

packages/tui/src/app.ts 拥有操作、取消、审批、编辑草稿、显示、证据去重和终端。在可同步发事件/审批的调用前设置状态。共用初始化留在 private methods；只有普通/自动回合开始遥测并清显示去重。显式 compact 有自己的遥测，不加对话计数。命令错误、失败退出码、后台计数恢复和各自最终刷新/清理保持区别。

presentation.ts 接收显式事件/审批并返回显示，不接收 App、Session、editor、journal 或可变 cache。先 telemetry 观察所有事件，再决定显示；App 对父子写入按 ID+指纹、命令按 ID 去重，更新写入和警告必须可见。App 留消息顺序/滚动/render，view 留清理/layout，telemetry/metrics 留计量。不建第二 transcript 或权限所有者。

保留新鲜审批输入、草稿恢复、取消后续跑、退出等待工作后再清输入/恢复终端。tui/ 回归维护这些契约；输入/生命周期改变还需下述真实 Windows 注入夹具，fake terminal 不能替代。见 [TUI](ARCHITECTURE/TUI.md)。

<a id="test-and-verification-layout"></a>

## 测试与验证目录

产品离线测试放生产代码外，按主要契约分组；eval 自有测试例外见下。入口使用 *.test.ts，helper 用描述性名称。

新增或大改测试用 node:test 的 describe/it 分组；小型独立检查可保留 test，it 是同一 API，suite 只组织不加强断言。除有意共享外 setup/cleanup 留在各 case，保留串并行设置，避免深层 suite。不仅为风格重命名全仓或另引框架。

| packages/verification/tests/ 下目录 | 责任 |
| --- | --- |
| agent/ | Agent 装配、Loop、委派和报告 |
| model/ | Transport、供应商和配置 |
| context/ | 投影、压缩与预算 |
| session/ | 历史、持久化、生命周期、草稿与目录 |
| metadata/ | 跨域日志、恢复和 JSON 文件 |
| projects/、attachments/、documents/、memory/、automation/ | 各能力契约及生命周期接入 |
| tools/ | 通用工具；files/、shell/、web/、browser/ 分能力 |
| permissions/ | 策略、命令风险、审批及文件/网络范围 |
| skills/ | 发现、加载、内置资源和接入 |
| cli/、tui/、webui/ | 各入口输入、展示、传输和交互 |
| workflows/ | 跨能力完整任务，如编码工作流 |
| harness/ | 发现、临时目录清理、live 配置 guard 等验证基础设施 |

跨模块导入不使测试自动成为 workflow。按主要契约归属：失败回合后写入事实属 tools/files，跨会话 Memory 属 memory，文档辅助预算属 documents；HTTP auth/项目确认属 webui，项目迁移属 projects。领域接入测试放能力旁，不建混杂 integration 目录。现有混合文件可留主要归属，行为需要独立维护才拆。

单域 helper 放该域 support；共享 setup、transport、cleanup、assertion 放 tests/support，样本/生成器放 tests/fixtures。support/workspace.ts 管临时目录，support/coding-workflow.ts 供离线/live 共用流程，fixtures/document-fixtures.ts 供离线/浏览器文档样本。子进程入口和 transport preload 是可执行 support，显式加载，不经 barrel，名称不得为 *.test.ts。产品不依赖测试/helper。

| 专项目录 | 运行要求 |
| --- | --- |
| packages/verification/verify/browser/ | Edge、临时本地页面、注入模型 |
| packages/verification/verify/native/ | 交互 Windows 桌面，探针在 native/support/ |
| packages/verification/verify/network/ | 公网，无模型请求 |
| packages/verification/verify/live/ | 明确授权真实 DeepSeek 和 API 用量 |
| packages/verification/verify/support/ | 专项共享支持，含 live 配置 guard |

专项可复用 tests/support 和 fixtures；普通 helper 导入不启动验证或加载凭据。Preload 按上文显式执行。scripts/start.ts 是根适配器，各包 copy 脚本仍属构建，包括 verification/scripts/copy-resources.mjs 原生探针；verification/scripts/test.ts 启动离线。命令以 [package.json](../../package.json) 为准，用 verify:*，不依赖编译位置。

pnpm test 先构建，再由源码清单发现 tests/**/*.test.ts，只把对应产物交 Node。移动/切分支遗留产物不能增加测试；空清单或缺任一产物先失败，测试失败仍非零。Verification tsconfig 包含嵌套测试、运行器、入口。包内单独测试假设产品已构建，完整流程用根命令。

构建并清理相关过时产物后，可在原生 Windows 用带引号 glob 定向运行；这些 Node 命令扫描编译文件，绕过 pnpm test 的源码选择：

```powershell
pnpm exec node --test "packages/verification/dist/tests/session/*.test.js"
pnpm exec node --test "packages/verification/dist/tests/tools/**/*.test.js"
```

移动/删除测试同步静态导入、import.meta.url、子进程/preload、产物引用源资产、命令和文档。TypeScript 不清旧输出，仅删除对应拥有包 dist（或迁移前位置）的 .js/.js.map，再确认每个源恰一产物且无孤儿。纯布局变化保留测试名、断言、夹具、超时和环境 gate。离线可用本地 HTTP/PowerShell，但不能加载 .env、启动 Edge 或联系供应商。

Eval 是集中布局例外：协议、结果、汇总和接入在 packages/eval/tests，合成 builder 在 tests/fixtures。根构建后用 pnpm --filter @fatcat/eval test 定向离线，不运行 benchmark/验证模型质量。根 pnpm test 包含两套；已有 live/browser/native 保持范围和供应商 guard。

<a id="windows-terminal-checks"></a>

## Windows 终端检查

在交互式、支持 VT 的 Windows 终端运行 `pnpm run verify:cli` 检查启动与输入交接。刻意拒绝 TERM=dumb；若 ConPTY 实际支持 VT 但错误继承该值，仅在验证 shell 设置 `$env:TERM = 'xterm-256color'`，不要放宽生产 guard。运行器使用临时会话存储/工作区、假凭据和拦截 transport，不加载 .env/联系供应商。依次：

1. 选择 native-cli，提交 approval，对新写入审批答 yes，等待 CLI APPROVAL VERIFIED，再提交 /exit。
2. 下一 resume picker 输入 /exit，模型请求数必须不变。
3. 再选 native-cli 进入 TUI，提交 cancel，等请求活动后 Esc；收尾后提交 continue，等待 CLI TUI HANDOFF VERIFIED，再 Ctrl+D。

运行器断言退出码、实际批准文件、精确 prompt 序列、历史不含审批/取消输入，以及跨宿主 raw-mode/SIGINT 恢复。成功打印 passed: true 并清临时目录。它使用真实 launcher、readline、TUI、SDK 和注入响应，不验证原生浏览器打开交接、完整 IME 或真实质量；离线子进程另测可执行 CLI/Web UI 管道启动。

在 stdin/stdout 直连的原生 Windows 交互终端（支持 ConPTY）运行 `pnpm run verify:tui`。构建并启动 packages/verification/verify/native/verify-tui.ts，使用注入模型和真实 ProcessTerminal，临时工作区，退出清理，不加载 .env 或联网。普通 pnpm test 不启动此检查。

每步等待结果后继续：

1. 提交 /skills unexpected，检查用法错误后输入仍可用。
2. 提交 approval，立即输入 draft after approval 但不回车。夹具 1.5 秒后请求写审批，待发草稿应从审批编辑器消失。
3. 空审批按 Enter 仍须 yes/no；提交 yes，等 APPROVED FILE SAVED，确认草稿恢复，再 Enter 提交并等 DRAFT RESTORED。
4. 提交 /compact，等摘要。
5. 提交 cancel，等工作开始后 Esc，等取消；提交 continue，等 CONTINUED AFTER CANCELLATION。
6. PgUp/PgDn 检查滚动，再 Ctrl+D，检查终端/光标恢复及最终 passed: true。

夹具断言真实文件、精确 prompt、取消历史隔离、摘要/对话计数、raw mode/SIGINT 恢复。交互展示/滚动补充断言，不验证完整 IME 或模型质量。提前退出会使验收断言失败。

<a id="public-network-and-local-browser-checks"></a>

## 公网与本地浏览器检查

这些脚本不调用模型 API、不要求模型凭据。浏览器脚本要求已安装 Edge，使用临时夹具/注入模型。普通 pnpm test 不运行。

| 命令 | 覆盖 / 额外要求 |
| --- | --- |
| `pnpm run verify:web` | 五个固定公开搜索、页面、天气检查，需要网络 |
| `pnpm run verify:browser` | 临时本地页面的受控执行与证据 |
| `pnpm run verify:webui` | 响应式、居中设置弹窗关闭/焦点、草稿详情/内嵌键盘滚动、紧凑证据、主题持久、断连恢复、单行控件、空闲折叠及指针/焦点/草稿保护、键盘唤醒、首页/忙碌排除、减少动态效果、长草稿/短窗口、对齐/调整大小、并排/覆盖预览模态隔离和 iframe 键盘返回、代码/回答复制及拒绝重试、回底部、键盘、弹窗、审批、取消和 Cron |
| `pnpm run verify:sessions` | 保存会话、工作区切换，注入选择器延迟期间的稳定布局与草稿、owner 身份以及取消/错误恢复 |
| `pnpm run verify:webui-models` | 圆角可用模型列表/键盘、medium 默认/保存 off、强制思考、别名、错误/忙碌冲突、草稿、紧凑摘要/runtime usage 与 estimate 分离、工具/回答/压缩刷新、身份/未知、重载/恢复、焦点不裁切、圆角悬停、图标及响应式双主题 |
| `pnpm run verify:projects` | 分组/折叠/紧凑间距、浏览器/服务重启恢复、存储不可用回退、聚焦标签间距、固定目录和确认迁入（含陈旧/取消） |
| `pnpm run verify:project-management` | 重命名、改目录、删除 |
| `pnpm run verify:folder-picker` | 归属于 Edge 的真实 Windows 目录选择器，需要 Edge 和交互桌面；检查模态归属、层级、DPI，以及选择、取消、中止、超时、关闭标签页/浏览器、正常关服和强制结束隔离测试服务后的浏览器恢复与 helper/托管进程退出 |
| `pnpm run verify:attachments` | 上传、共享、来源与生命周期 |
| `pnpm run verify:documents` | 本地解析、来源证据与注入视觉接入 |
| `pnpm run verify:memory` | 注入模型下作用域交互与管理 |

保留 verify:webui 或 verify:webui-models 截图时，运行前设置 `$env:FATCAT_VERIFY_SCREENSHOTS = 'D:\tmp\fatcat-review'`。原生 picker 接受可选图片路径，例如 `pnpm run verify:folder-picker D:\tmp\picker.png`。注入目录选择不验证原生弹窗，注入视觉不验证理解质量。报告实际环境和路径。

<a id="explicit-live-model-checks"></a>

## 显式真实模型检查

仅在用户明确要求真实模型验证时运行。它们加载本地 env、使用真实 DeepSeek Key 并消耗额度；不得静默改用其他供应商。上限包含可能的子请求；断言失败就报告，不反复重跑直到成功。

| 命令 | 夹具与验收 | 请求上限 |
| --- | --- | --- |
| `pnpm run verify:live` | 直接回答、sum、上下文追问、分页样本、委派、临时创建/读/改/读 | 29 |
| `pnpm run verify:delegation` | 隔离子历史的临时只读 review，文件不变、无 shell/write | 20 |
| `pnpm run verify:coding` | 临时搜索/读/改与窄授权固定测试，独立重跑及执行/usage | 14 |
| `pnpm run verify:workflow` | 两回合多文件价格/收据，逐回合报告、保护文件与独立检查 | 28 |
| `pnpm run verify:context` | 三回合只读，变化内容和 26000 字节预算，省略/重读 | 27 |
| `pnpm run verify:memory:live` | 显式记忆、项目共享、重启与临时数据隔离 | 16 |

编码检查只授权指定源码编辑及固定测试。Workflow 要求各回合有失败和最终成功验证，但不另断言失败先于首次编辑。委派断言不能机械证明每条 review；Context 是小型行为夹具，不是 token 成本/普遍成功率 benchmark。普通报告仍 taskVerification: not_assessed。

夹具与用户项目分离，基本 live 读取也使用合成 examples/workspace。清理不撤销供应商用量。实际运行器位于 packages/verification/verify/live，共享流程在 tests/support/coding-workflow.ts。

<a id="verification-evidence"></a>

## 验证证据

本页说明如何检查，不记录历次通过。脚本存在、代码已写或历史通过不能验证当前改动。

交接报告分支、实际检查、结果、失败/阻塞和限制，区分离线、真实浏览器/终端、公网、真实模型。关键行为/限制放对应跟踪架构文档，使新 clone 可独立理解。详细任务历史放 Git/PR 和本地记录，不在多份手册重复验收声明。

<a id="evaluation-evidence-requirements"></a>

## Eval 证据要求

新实验使用版本化 [Eval 协议](ARCHITECTURE/EVAL.md)。实现独立于产品回归，位于 packages/eval。配置/序列化使用合成数据，不证明 Session 执行或模型质量。

| 改动 | 必需证据 |
| --- | --- |
| 协议、序列化、统计 | 离线/手算合成总量；坏输入、缺失/重复、未知 usage/cost |
| Session adapter 或生命周期 | 注入接入、隔离 workspace/session、取消/清理；live 质量独立 |
| 上下文选择/压缩质量 | 离线加声明开发/留出样本的固定模型/数据/预算比较，不能只因少 token 宣称改善 |
| 排序/分块 | 确定性标注检索指标与来源检查，回答/引用另评 |
| CLI/TUI/Web 交互 | 离线外还需受影响原生 Windows/Edge 注入专项 |
| 完整编码验收 | 独立核验最终产物/保护文件并记录 verifier 版本，模型回答或工具成功不足 |

运行前声明范围、样本、重复、代码/模型/数据/prompt/策略/grader 身份及预算。保留全部失败/超时/取消/基础设施错误。开发与留出 ID 固定且不相交；留出只验收，不迭代调优。缺记录即不完整，不缩分母或只挑最好。子集不等于全 benchmark，合成/注入不等于 live。Dirty 实验仅诊断，除非另有可复现快照机制，v1 没有。未知计数/价格保持 null（显示 unknown），部分 usage 标已知小计，不冒充总量。预算声明不实施限制或授权花费。

真实模型仍需明确范围/预算授权。现有 DeepSeek live 不变；执行、预算实施、公开数据、成对报告及定时/手动质量命令是后续工作，协议本身未实现。

<a id="version-and-badges"></a>

## 版本与徽章

[package.json](../../package.json) 是版本事实来源。私有包从 checkout 运行，版本不代表 npm 发布或 GitHub release。pnpm start --version 不需凭据/会话；构建后 node packages/cli/dist/cli.js --version 仅打印版本。

早期使用 0.x.y：修复升 patch，能力/兼容改变升 minor；升级前记录兼容变化，1.0.0 留给稳定兼容契约。应用、Session、Automation schema 版本独立。

README 版本/CI 徽章引用 main，不是本地分支/工作区。要求变化时更新根 README 的静态 Node.js/pnpm 徽章及双语文档中的版本要求。Stars 和徽章不构成验证证据。
