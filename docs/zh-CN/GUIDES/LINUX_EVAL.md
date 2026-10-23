<a id="linux-evaluation"></a>

# Linux 评估

[English](../../en/GUIDES/LINUX_EVAL.md) | 简体中文

[Eval 架构](../ARCHITECTURE/EVAL.md) · [开发](../DEVELOPMENT.md)

**当前策略（2026-10-23）：因费用原因暂停真实模型配合 Harbor 的评测。** 日常工作遵循[harness 评估策略](../ARCHITECTURE/EVAL.md#current-evaluation-strategy)。本指南保留本地注入／Oracle 检查及未来 Terminal-Bench 路线，不要求每次修改都完整执行本页。真实执行章节仅作保留参考，需新的明确恢复指令及预算，原 KAI-44 额度不再授权进入下一次付费运行。

KAI-43 增加评估路径；普通原生 Windows 使用仍不需要 Docker 或 Python。使用 PowerShell 7、Node 24.x、pnpm 11.21.0 和已启动的 Docker Desktop Linux 引擎。检查的宿主有 32 GiB RAM，Docker 分配约 16 GiB。任务声明 2 CPU、4096 MiB RAM、10240 MiB 存储且无 GPU；下文明确限制 CPU／内存，但存储声明不是 Docker 磁盘配额。为镜像／依赖预留本地空间，下载需要网络，注入执行不需要。

<a id="choose-the-check"></a>

## 选择检查范围

1. 普通 harness 改动使用[开发文档](../DEVELOPMENT.md#evaluation-evidence-requirements)中的相关离线测试及注入流程。根目录 `pnpm run typecheck`、`pnpm test` 提供常规类型／边界／构建和离线套件；构建后用 `pnpm --filter @fatcat/eval test` 聚焦 eval。这些命令均不启动真实模型 Harbor 评测。
2. Linux 执行改动使用相关[注入 Linux 验收](#run-and-retain-injected-acceptance)；适配器或官方评分接线变化时使用[Harbor 注入适配器](#harbor-injected-adapter)。官方任务／环境或 verifier 需要参考对照时再运行 Oracle。这些路径占用本地资源，但不请求真实模型。
3. 只修改结果解析／报告时，离线读取和检查现有 trial 证据，保留历史失败并注明实际验证的快照。只有符合架构中的[恢复条件](../ARCHITECTURE/EVAL.md#retained-harbor-route-and-resumption)，才能重新使用[真实运行参考](#authorized-live-attempt)。

<a id="fixed-task-and-evidence"></a>

## 固定任务与证据

[任务固定信息](../../../packages/eval/harbor/terminal-bench-4.0.json) 记录官方版本提交 `452bf305c6daa62fc59061d22133a7cbc7c1572e`、`terminal-bench/sound-change-cascade`、全部 18 个文件哈希及时限。该版本有 66 个任务清单，只选择此道 CPU 题。[Oracle 元数据](../../../packages/eval/harbor/oracle-control.json) 记录 Harbor 0.23.0 的参考执行：reward 1.0、七项验收通过、无异常，以及镜像身份与证据哈希。[Linux 对照元数据](../../../packages/eval/harbor/linux-control.json) 绑定注入镜像、编译包、资源限制与证据哈希。这不是 Fatcat 分数。官方 Dockerfile 使用浮动 Python tag 和 apt 包，每次重建都要记录镜像身份；固定任务不保证重建镜像字节一致。

已有 Linux 对照只验证记录中的精确编译包。源码变更或模块移动后，必须重建镜像并重跑 Linux 检查，才能将证据用于当前工作区。Windows 测试通过及其中 Linux 专属测试的跳过，不能替代这次执行。

<a id="prepare-and-run-oracle"></a>

## 准备并运行 Oracle

在仓库根目录使用 PowerShell 7 执行。使用 uv 可发现的 Python 3.12，或由 uv 安装；已验证的控制端使用 CPython 3.12.7。Python 快照适用于 Windows x64。创建新的忽略目录，以 `core.autocrlf=false` 导出，否则 Git archive 也可能将 Linux 脚本转成 CRLF。每条外部命令出错后都应检查退出状态，不能直接继续。

```powershell
$evalRoot = Join-Path (Get-Location) ('packages/eval/.local/kai43-' + (Get-Date -Format yyyyMMdd-HHmmss))
New-Item -ItemType Directory -Path "$evalRoot/tools","$evalRoot/task" | Out-Null
Invoke-WebRequest https://github.com/astral-sh/uv/releases/download/0.9.7/uv-x86_64-pc-windows-msvc.zip -OutFile "$evalRoot/tools/uv.zip"
Expand-Archive "$evalRoot/tools/uv.zip" "$evalRoot/tools/uv"
$uv = "$evalRoot/tools/uv/uv.exe"
& $uv --version
$env:UV_CACHE_DIR = "$evalRoot/uv-cache"
& $uv venv --python 3.12 "$evalRoot/harbor"
& $uv pip sync --python "$evalRoot/harbor/Scripts/python.exe" packages/eval/harbor/requirements-windows.txt
git -c core.autocrlf=false clone --filter=blob:none --depth 1 --branch v4.0.0 --no-checkout https://github.com/harbor-framework/terminal-bench.git "$evalRoot/source"
$revision = git -C "$evalRoot/source" rev-parse HEAD
if ($revision -ne '452bf305c6daa62fc59061d22133a7cbc7c1572e') { throw 'Unexpected task revision' }
git -c core.autocrlf=false -C "$evalRoot/source" archive --format=tar --output="$evalRoot/task.tar" $revision tasks/sound-change-cascade
tar -xf "$evalRoot/task.tar" -C "$evalRoot/task"
$task = "$evalRoot/task/tasks/sound-change-cascade"
$pin = Get-Content packages/eval/harbor/terminal-bench-4.0.json -Raw | ConvertFrom-Json
foreach ($file in $pin.fileSha256.PSObject.Properties) {
  if ((Get-FileHash (Join-Path $task $file.Name) -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.Value) { throw "Task hash mismatch: $($file.Name)" }
}
$env:HARBOR_TELEMETRY = '0'
$env:PYTHON_DOTENV_DISABLED = '1'
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$env:NO_COLOR = '1'
$harbor = "$evalRoot/harbor/Scripts/harbor.exe"
docker info --format '{{.OSType}} {{.ServerVersion}} {{.NCPU}} {{.MemTotal}}'
& $harbor run -p $task -a oracle -e docker -k 1 -n 1 -r 0 -o "$evalRoot/jobs" --job-name oracle --print-config
& $harbor run -p $task -a oracle -e docker -k 1 -n 1 -r 0 -o "$evalRoot/jobs" --job-name oracle
```

确认解析后的配置恰好只有一道题。trial 结果必须有完整 agent/verifier 时间、无异常及数值 reward；保存 `result.json`、`lock.json`、`config.json`、`agent/oracle.txt` 和 verifier 的 stdout/reward/CTRF。CLI 返回零或控制台均值零不证明有效评分；环境／verifier 失败必须先排查，不能归因于 Fatcat。

本地保留的准备失败包括 WSL Docker CLI／连接失败、GBK 控制台编码、apt HTTP 502 和 CRLF 导致 verifier 无法启动。通过路径使用 Windows Harbor、UTF-8 与任务原始字节；不得放宽官方 verifier。诊断后的重试使用新 job 名称，`-r 0` 表示不进行 Harbor 自动重试。

<a id="build-the-injected-linux-environment"></a>

## 构建注入执行的 Linux 环境

在 Windows 构建 Fatcat，校验官方 Node／pnpm 下载，只复制清单与编译包。上下文不含 `.env`、宿主 node_modules、Git 历史或 benchmark 解答。Python 依赖归 Harbor，JavaScript 依赖只使用 pnpm。

```powershell
pnpm install --frozen-lockfile
pnpm run build
Invoke-WebRequest https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.xz -OutFile "$evalRoot/tools/node.tar.xz"
if ((Get-FileHash "$evalRoot/tools/node.tar.xz" -Algorithm SHA256).Hash.ToLowerInvariant() -ne '14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647') { throw 'Node checksum mismatch' }
tar -xf "$evalRoot/tools/node.tar.xz" -C "$evalRoot/tools" node-v24.19.0-linux-x64/bin/node
Invoke-WebRequest https://registry.npmjs.org/pnpm/-/pnpm-11.21.0.tgz -OutFile "$evalRoot/tools/pnpm.tgz"
$pnpmHash = [Convert]::ToBase64String([System.Security.Cryptography.SHA512]::HashData([IO.File]::ReadAllBytes("$evalRoot/tools/pnpm.tgz")))
if ($pnpmHash -ne 'UhcFvOaJkk6scvWjWHEi82JonvZXHlW6gAdv1jfBETLs/62ib61Op5xIW/3b/T1aKlsFgFp36JPeceyKbMo7sQ==') { throw 'pnpm checksum mismatch' }
New-Item -ItemType Directory -Path "$evalRoot/tools/pnpm" | Out-Null
tar -xf "$evalRoot/tools/pnpm.tgz" -C "$evalRoot/tools/pnpm"
$context = "$evalRoot/linux-context"
New-Item -ItemType Directory -Path "$context/manifests","$context/build" | Out-Null
foreach ($name in @('package.json','pnpm-lock.yaml','pnpm-workspace.yaml')) { Copy-Item $name "$context/manifests/$name" }
foreach ($package in Get-ChildItem packages -Directory) {
  New-Item -ItemType Directory -Path "$context/manifests/packages/$($package.Name)","$context/build/packages/$($package.Name)" | Out-Null
  Copy-Item "$($package.FullName)/package.json" "$context/manifests/packages/$($package.Name)/package.json"
  Copy-Item "$($package.FullName)/dist" "$context/build/packages/$($package.Name)/dist" -Recurse
}
Copy-Item "$evalRoot/tools/node-v24.19.0-linux-x64/bin/node" "$context/node"
Copy-Item "$evalRoot/tools/pnpm/package" "$context/pnpm" -Recurse
Copy-Item packages/eval/harbor/Dockerfile.injected "$context/Dockerfile"
docker build --progress plain -t fatcat-kai43-task:452bf305 "$task/environment"
docker build --progress plain -t fatcat-kai43-injected:local $context
```

使用新的上下文；复制到已有 `dist` 可能产生嵌套 `dist`。扩展镜像从未变更的固定锁文件安装真实 Linux 依赖，禁用依赖生命周期脚本；验证核心执行，不覆盖原生文档渲染或浏览器功能。Node 与依赖位于 `/app` 外，扩展镜像有自己的身份。

<a id="run-and-retain-injected-acceptance"></a>

## 执行并保留注入验收

选择未占用的容器名。没有宿主工作区挂载，也没有网络；`/app` 来自官方任务镜像，证据放在任务外的 `/logs/fatcat`。检查器仅在此一次性任务实例中创建具名 smoke／PID 文件，不解题或评分。

```powershell
docker run -d --init --name fatcat-kai43-check --network none --cpus 2 --memory 4g fatcat-kai43-injected:local sleep infinity
docker exec fatcat-kai43-check node --test /opt/fatcat/packages/verification/dist/tests/tools/shell/bash.test.js /opt/fatcat/packages/eval/dist/tests/headless.test.js
docker exec fatcat-kai43-check mkdir -p /logs
docker exec fatcat-kai43-check node /opt/fatcat/packages/eval/dist/scripts/verify-linux.js --workspace /app --output /logs/fatcat
docker cp fatcat-kai43-check:/logs/fatcat "$evalRoot/injected-results"
docker inspect fatcat-kai43-check > "$evalRoot/container.json"
docker image inspect fatcat-kai43-task:452bf305 fatcat-kai43-injected:local > "$evalRoot/images.json"
docker rm -f fatcat-kai43-check
pnpm run typecheck
pnpm test
```

失败日志也要保存。复制证据后，只删除此具名的一次性容器。验收断言文件／Bash 同 cwd、非零退出、父子进程终止、中断持久化与自有临时状态删除；实际可执行入口接收 SIGTERM 后必须先收尾再以 130 退出。产品测试覆盖期限、输出、预先取消、大小写／空格／链接路径；eval 测试覆盖委派策略与请求上限。Linux 专属测试在此执行，不能把 Windows 跳过算作通过。未改 CLI／TUI／Web UI 输入代码，不宣称新增原生 UI 验收。

<a id="headless-entry-and-next-milestone"></a>

## 无界面入口与下一里程碑

执行 `node packages/eval/dist/scripts/headless.js --config <options.json> --transport <trusted-module.js>`。受信任模块必须导出返回注入 fetch 的 `createTransport()`，没有网络回退。配置为 `taskCwd`、`instruction`、`resultDirectory`、`permission`（`files`、`shell`）、`requests`、`durationMs`，限制见 [Eval](../ARCHITECTURE/EVAL.md#ordered-implementation-and-acceptance)。结果父目录须存在，新子目录必须位于任务外。证据可能包含任务文本，需私密保存；注入完成不等于官方评分。

Harbor installed agent 已可用于下文注入检查。真实 `deepseek-flash` 评测按[当前策略](../ARCHITECTURE/EVAL.md#current-evaluation-strategy)暂停，历史授权不恢复执行。KAI-43 不授权真实模型付费、云资源、上传或全量／排行榜声明。

<a id="harbor-injected-adapter"></a>

## Harbor 注入适配

先按上文重建当前 Linux 镜像，沿用准备阶段的 `$evalRoot`、`$task` 和 `$harbor`。使用本地 Docker、2 CPU 和 4 GiB。Agent 容器无网络，镜像构建可下载官方依赖。此注入配置使用固定 Linux `/app` 任务，拒绝模型参数及 Agent 环境变量覆盖。

包包含任务外的 Node、审核后的编译包和依赖，排除全部 `.env` 文件及 Git 元数据。使用新的镜像／导出名称，检查每条命令退出码，不覆盖已被证据引用的包。包属于受信任的可执行代码，摘要绑定字节，不建立信任。

```powershell
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONDONTWRITEBYTECODE = '1'
$env:PYTHON_DOTENV_DISABLED = '1'
$env:HARBOR_TELEMETRY = '0'
$env:LITELLM_LOCAL_MODEL_COST_MAP = 'True'
$env:PYTHONPATH = (Resolve-Path packages/eval/harbor).Path
docker build --network none --build-arg FATCAT_IMAGE=fatcat-kai43-injected:local -f packages/eval/harbor/Dockerfile.bundle -t fatcat-harbor-bundle:local packages/eval/harbor
docker create --name fatcat-harbor-export --label fatcat.role=bundle-export --network none fatcat-harbor-bundle:local
docker cp fatcat-harbor-export:/fatcat.tar.gz "$evalRoot/fatcat.tar.gz"
docker rm fatcat-harbor-export
$bundleHash = (Get-FileHash "$evalRoot/fatcat.tar.gz" -Algorithm SHA256).Hash.ToLowerInvariant()
@'
services:
  main:
    network_mode: none
'@ | Set-Content "$evalRoot/network-none.yaml" -Encoding utf8NoBOM
$jobName = 'fatcat-injected-' + (Get-Date -Format yyyyMMdd-HHmmss)
$config = @{
  job_name = $jobName; jobs_dir = "$evalRoot/harbor-jobs"
  n_attempts = 1; n_concurrent_trials = 1; quiet = $true
  retry = @{ max_retries = 0 }
  tasks = @(@{ path = $task })
  agents = @(@{
    import_path = 'fatcat_agent:FatcatAgent'
    override_setup_timeout_sec = 180; override_timeout_sec = 60
    kwargs = @{
      bundle_path = "$evalRoot/fatcat.tar.gz"; bundle_sha256 = $bundleHash
      requests = 8; duration_ms = 30000
      transport_path = 'packages/eval/dist/tests/fixtures/harbor-smoke.js'
    }
  })
  environment = @{
    type = 'docker'; delete = $true; override_cpus = 2; override_memory_mb = 4096
    extra_docker_compose = @("$evalRoot/network-none.yaml")
  }
}
$config | ConvertTo-Json -Depth 12 | Set-Content "$evalRoot/harbor-injected.json" -Encoding utf8NoBOM
& $harbor run --config "$evalRoot/harbor-injected.json"
$trial = @(Get-ChildItem "$evalRoot/harbor-jobs/$jobName" -Directory)
if ($trial.Count -ne 1) { throw 'Expected exactly one trial' }
node packages/eval/dist/scripts/verify-harbor.js --trial $trial[0].FullName --expect completed
& "$evalRoot/harbor/Scripts/python.exe" -B packages/eval/tests/harbor/agent_test.py
```

smoke transport 读取官方 TSV，写入故意不正确的恒等规则及顺序，执行 Bash，再读取提交文件。预期官方 reward 为 **0**：五个结构／确定性检查通过，两个完全匹配检查失败。不向 Fatcat 提供参考解答或隐藏数据。仅 CLI 返回零或打印均值零不足以验收，检查器会核对 trial 异常、verifier 日志及原生轨迹。[注入对照元数据](../../../packages/eval/harbor/injected-control.json) 记录已验证的包、适配器、trial 和产物哈希。失败对照也得到 Harbor 零分，但执行异常使其分类仍为 `error`。

失败验收使用新的 job／配置名称，将 `transport_path` 改为 `packages/eval/dist/tests/fixtures/harbor-failure.js`，随后用 `--expect failed` 检查。服务商错误必须保留为 Harbor 异常及失败的 Session。保存所有 job，包括环境／下载失败。检查器独占创建 `fatcat-injection-check.json` 并记录产物哈希。

`agent/fatcat/evidence.json` 是原生轨迹，包含合成用量，不是 ATIF 导出。真实用量和计费保持 null。真实运行已暂停；下文配置保留给未来明确授权的恢复。代码 review 不授权付费或提交后续修改。

<a id="authorized-live-attempt"></a>

## 获授权的真实尝试

**暂停的运行参考：当前评估策略下不执行本节。** 下方历史结果继续用于 review。保留入口及示例命令并不在代码中禁用它们，也不授权新花费；须先满足[恢复条件](../ARCHITECTURE/EVAL.md#retained-harbor-route-and-resumption)。

明确恢复后，仅在新约定的单题范围与费用额度内运行，并在执行前确认实现能落实该额度。当前入口使用 `deepseek-flash`、high 思考、单请求 180 秒、最多 32 请求及整次 30 分钟期限。共享 SDK transport 闸门覆盖委派／压缩请求，按保守高峰价格落实人民币 10 元上限，见 [费用合同](../ARCHITECTURE/EVAL.md#authorized-deepseek-attempt)。跨日期运行前，应对照链接的官方价目重新检查 `src/deepseek-budget.ts` 中的日期价格。超时保留整次请求预留，不启用自动重试。同一授权在失败尝试后继续时，重新启动前须把该次及所有此前尝试的保留费用上界填入 `kwargs.prior_cost_nano_cny`。真实配置允许 1 MiB 的编码请求 JSON，避免把较小的注入 smoke 正文限制直接套用于长真实轨迹。

沿用刚验证的包和上文注入 `$config`。Harbor 进程须已通过私有本地配置获得 `DEEPSEEK_API_KEY`，不得把值放进命令、JSON、包或日志。桥接把临时凭据上传到 `/app` 和 `/logs` 外；Node 入口在 Session 启动前读取并删除它。仅传入官方原始题面，不提供 Oracle 文件或隐藏测试数据。真实执行需要访问 API，因此移除注入的 `network_mode: none` 覆盖。本地 Docker 不涉及云实例，也不授权结果上传。

```powershell
if (-not $env:DEEPSEEK_API_KEY) { throw 'Supply the credential through private process configuration first' }
$liveConfig = $config | ConvertTo-Json -Depth 12 | ConvertFrom-Json -AsHashtable
$liveConfig.job_name = 'fatcat-deepseek-' + (Get-Date -Format yyyyMMdd-HHmmss)
$liveConfig.environment.Remove('extra_docker_compose')
$liveConfig.agents[0].model_name = 'deepseek/deepseek-flash'
$liveConfig.agents[0].kwargs.mode = 'live'
$liveConfig.agents[0].kwargs.Remove('transport_path')
$liveConfig.agents[0].kwargs.requests = 32
$liveConfig.agents[0].kwargs.duration_ms = 1800000
$liveConfig.agents[0].override_timeout_sec = 1830
$liveConfig | ConvertTo-Json -Depth 12 | Set-Content "$evalRoot/harbor-live.json" -Encoding utf8NoBOM
& $harbor run --config "$evalRoot/harbor-live.json"
$trial = @(Get-ChildItem "$evalRoot/harbor-jobs/$($liveConfig.job_name)" -Directory)
if ($trial.Count -ne 1) { throw 'Expected exactly one trial' }
node packages/eval/dist/scripts/verify-harbor.js --trial $trial[0].FullName --expect live
```

检查器要求真实 Session 完成、无 Harbor 异常且官方评分正常。官方测试正常结束时，零分也有效；供应商／环境报错不算成功接入。失败 job 保留，不自动重复付费工作。`fatcat-live-check.json` 绑定原始 result／config／lock、verifier 日志和原生轨迹哈希。轨迹中的模型账本保存响应 ID／模型字符串和可空用量；人民币高峰价上界不是账单，也不是美元换算值。另行保存源码快照、包摘要、准确题目版本及可取得的容器镜像身份。单题不能说明全集表现。

[真实运行对照元数据](../../../packages/eval/harbor/live-control.json) 记录 2026-10-23 的 KAI-44 验收。通过接入验收的一次使用 **8 请求**、10 分钟期限、1 MiB 正文上限及相同 high 思考配置：Session 完成、Harbor 无异常、官方 reward 为 **0**。两个要求的提交文件均未生成，七项官方测试全部失败；Fatcat 最终答复明确报告任务未完成。这验证该短预算下的接入，不证明解题质量或更长配置能成功执行。

此前两次 32 请求配置仍保留为失败：第一次发出 26 个网络请求后触发本地 256 KiB 正文上限（已修复）；第二次发出 30 个请求后，一次响应耗尽 16,384 token 输出上限，报 `MODEL_TRUNCATED`。最后的短尝试是不同配置。三次共 64 个真实请求，用量完整，按高峰价累计上界为 **7.1813132 元**，在授权的 10 元内。API 响应只返回 `deepseek-flash`；当天官方文档映射到 DeepSeek-V4.1-Flash-1017，但没有返回准确服务端 revision。镜像身份缺失与原始产物哈希在元数据中明确记录。长响应仍可能截断，全局请求闸门也可能在父任务单独预留的最终答复之前停止委派工作；完整预算协调仍归 KAI-23。
