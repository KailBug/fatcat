<a id="linux-evaluation"></a>

# Linux 评估

[English](../../en/GUIDES/LINUX_EVAL.md) | 简体中文

[Eval 架构](../ARCHITECTURE/EVAL.md) · [开发](../DEVELOPMENT.md)

KAI-43 增加评估路径；普通原生 Windows 使用仍不需要 Docker 或 Python。使用 PowerShell 7、Node 24.x、pnpm 11.21.0 和已启动的 Docker Desktop Linux 引擎。检查的宿主有 32 GiB RAM，Docker 分配约 16 GiB。任务声明 2 CPU、4096 MiB RAM、10240 MiB 存储且无 GPU；下文明确限制 CPU／内存，但存储声明不是 Docker 磁盘配额。为镜像／依赖预留本地空间，下载需要网络，注入执行不需要。

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

KAI-44 负责 Harbor installed agent 与 Fatcat 官方判分，必须先注入，再取得单次真实 `deepseek-flash` 的明确授权和具体请求／时间／API 额度。KAI-43 不授权真实模型付费、云资源、上传或全量／排行榜声明。
