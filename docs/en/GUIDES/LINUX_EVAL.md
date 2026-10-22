# Linux evaluation

English | [简体中文](../../zh-CN/GUIDES/LINUX_EVAL.md)

[Eval architecture](../ARCHITECTURE/EVAL.md) · [Development](../DEVELOPMENT.md)

KAI-43 adds an evaluation path; ordinary native Windows use still needs neither Docker nor Python. Use PowerShell 7, Node 24.x, pnpm 11.21.0 and a running Docker Desktop Linux engine. The checked host had 32 GiB RAM and about 16 GiB assigned to Docker. The task declares 2 CPU, 4096 MiB RAM, 10240 MiB storage and no GPU. CPU/memory limits below are explicit; the storage declaration is not a Docker disk quota. Reserve local space for images/dependencies. Downloads need network; injected execution does not.

## Fixed task and evidence

[The task pin](../../../packages/eval/harbor/terminal-bench-4.0.json) records the official release at commit `452bf305c6daa62fc59061d22133a7cbc7c1572e`, `terminal-bench/sound-change-cascade`, all 18 file hashes and timeouts. The release has 66 task manifests; only this CPU task is selected. [Oracle metadata](../../../packages/eval/harbor/oracle-control.json) records Harbor 0.23.0's reference run: reward 1.0, seven verifier tests passed and no exception, with image identities and artifact hashes. [Linux control metadata](../../../packages/eval/harbor/linux-control.json) binds the injected image, compiled bundle, limits and evidence hashes. This is not a Fatcat score. Official Dockerfiles have floating Python tags and apt packages; record image identities on every rebuild. A fixed task does not promise identical rebuilt image bytes.

The recorded Linux control validates only its exact compiled bundle. After source changes or module moves, rebuild the image and rerun the Linux checks before treating that evidence as validation of the current working tree. Passing Windows tests, including their Linux-specific skips, does not replace that run.

## Prepare and run Oracle

Run from the repository root in PowerShell 7. Use a Python 3.12 interpreter available to uv, or let uv install one; the checked controller used CPython 3.12.7. The Python snapshot is for Windows x64. Create a fresh ignored directory and export with `core.autocrlf=false`; Git archive can otherwise convert Linux scripts to CRLF. Check every external command's exit before proceeding after an error.

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

Inspect the resolved config for exactly one task. Require completed agent/verifier timings, no exception and a numeric reward in the trial result. Preserve `result.json`, `lock.json`, `config.json`, `agent/oracle.txt` and verifier stdout/reward/CTRF. A zero CLI exit or displayed mean of zero does not prove valid grading. Stop to diagnose environment/verifier failures before attributing anything to Fatcat.

Preparation failures retained locally include WSL Docker CLI/connection failure, GBK console encoding, apt HTTP 502 and CRLF verifier startup failure. The passing path uses Windows Harbor, UTF-8 and original task bytes. Never weaken the official verifier; keep diagnosed retries under new job names. `-r 0` means no automatic Harbor retry.

## Build the injected Linux environment

Build Fatcat on Windows, verify the official Node/pnpm downloads, and copy only manifests and compiled packages. The context excludes `.env`, host node_modules, Git history and benchmark solutions. Python dependencies belong to Harbor; JavaScript dependencies use pnpm exclusively.

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

Use a fresh context; copying into an existing `dist` can create a nested `dist`. The overlay installs actual Linux dependencies from the unchanged frozen lockfile. Lifecycle scripts are disabled; core execution is verified, not native document rendering or browser features. Node and dependencies are added outside `/app`; the overlay has its own image identity.

## Run and retain injected acceptance

Choose an unused container name. There are no host workspace mounts and no network; `/app` comes from the official task image. Evidence is outside task inputs in `/logs/fatcat`. The runner creates named smoke/PID files only in this disposable task instance; it does not solve or grade the benchmark.

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

Retain failed logs too. Copy evidence before removing only this named disposable container. Acceptance asserts shared file/Bash cwd, nonzero exits, parent/child termination, persisted interruption and owned temporary-state removal. The built executable receives SIGTERM and must exit 130 after settlement. Product tests cover deadlines/output/early abort/path case, spaces and links; eval tests cover delegated policy and request limits. Run Linux-only tests here instead of counting Windows skips as passes. No CLI/TUI/Web UI input code changed; no new native UI acceptance is claimed.

## Headless entry and next milestone

Run `node packages/eval/dist/scripts/headless.js --config <options.json> --transport <trusted-module.js>`. The trusted module must export `createTransport()` returning injected fetch; there is no network fallback. Options are `taskCwd`, `instruction`, `resultDirectory`, `permission` (`files`, `shell`), `requests` and `durationMs`; see [Eval](../ARCHITECTURE/EVAL.md#ordered-implementation-and-acceptance) for limits. The result parent must exist and its new child directory must be outside the task. Evidence can contain task text; keep it private. Completed injection is not an official score.

KAI-44 owns the Harbor installed agent and official Fatcat grading. It must use injection first, then obtain explicit authorization and concrete request/time/API allowance for one real `deepseek-flash` attempt. KAI-43 does not authorize live-model spending, cloud resources, uploads or a full-suite/leaderboard claim.
