# Linux evaluation

English | [简体中文](../../zh-CN/GUIDES/LINUX_EVAL.md)

[Eval architecture](../ARCHITECTURE/EVAL.md) · [Development](../DEVELOPMENT.md)

**Current policy (2026-10-23): real-model Harbor evaluation is paused for cost reasons.** Use the [harness evaluation strategy](../ARCHITECTURE/EVAL.md#current-evaluation-strategy) for routine work. This guide retains local injected/Oracle checks and the future Terminal-Bench route; it is not a sequence to run in full on every change. The live section is a retained reference requiring a new explicit resumption and budget, not a next step authorized by the earlier KAI-44 allowance.

KAI-43 adds an evaluation path; ordinary native Windows use still needs neither Docker nor Python. Use PowerShell 7, Node 24.x, pnpm 11.21.0 and a running Docker Desktop Linux engine. The checked host had 32 GiB RAM and about 16 GiB assigned to Docker. The task declares 2 CPU, 4096 MiB RAM, 10240 MiB storage and no GPU. CPU/memory limits below are explicit; the storage declaration is not a Docker disk quota. Reserve local space for images/dependencies. Downloads need network; injected execution does not.

## Choose the check

1. For ordinary harness changes, use the affected offline tests and injected workflows described in [Development](../DEVELOPMENT.md#evaluation-evidence-requirements). Root `pnpm run typecheck` and `pnpm test` provide the normal type/boundary/build and offline suites; after a build, `pnpm --filter @fatcat/eval test` focuses on eval. None of these commands starts a live Harbor evaluation.
2. For Linux execution changes, use the relevant [injected Linux acceptance](#run-and-retain-injected-acceptance); for adapter or official scoring integration changes, use the [Harbor injected adapter](#harbor-injected-adapter). Use Oracle when the official task/environment or verifier needs a reference control. These paths require local resources but make no real model requests.
3. Read and check existing trial evidence offline when only result parsing/reporting changes. Preserve historical failures and identify the exact tested snapshot. Resume the [live reference](#authorized-live-attempt) only under the architecture's [resumption conditions](../ARCHITECTURE/EVAL.md#retained-harbor-route-and-resumption).

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

The Harbor installed agent is available for injected checks below. Real `deepseek-flash` evaluation is paused under the [current strategy](../ARCHITECTURE/EVAL.md#current-evaluation-strategy); historical authorization does not resume it. KAI-43 does not authorize live-model spending, cloud resources, uploads or a full-suite/leaderboard claim.

<a id="harbor-injected-adapter"></a>

## Harbor injected adapter

Rebuild the current Linux image above, then keep `$evalRoot`, `$task` and `$harbor` from preparation. This uses local Docker, two CPUs and 4 GiB. The Agent container has no network; image builds can download official dependencies. This injected configuration uses the pinned Linux `/app` task and rejects model arguments and agent environment overrides.

The bundle contains Node and reviewed compiled packages/dependencies outside the task, excluding all `.env` files and Git metadata. Use fresh image/export names, check each command's exit status, and never overwrite a bundle referenced by evidence. It is trusted executable code; its digest binds bytes, not trust.

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

The smoke transport reads the official TSV, writes an intentionally incorrect identity rule and ordering, executes Bash, then reads the submitted file. Expected official reward is **0**: five structural/determinism checks pass and two exact-match checks fail. No reference solution or hidden data is supplied to Fatcat. CLI exit zero or printed mean zero alone is insufficient: the checker inspects trial exceptions, verifier logs and native trajectory. [Injected control metadata](../../../packages/eval/harbor/injected-control.json) records the verified bundle, adapter, trials and artifact hashes. The failure control also receives zero from Harbor, but its execution exception keeps its classification at `error`.

For failure acceptance, use a new job/config name, change `transport_path` to `packages/eval/dist/tests/fixtures/harbor-failure.js`, then check with `--expect failed`. The provider error must remain a Harbor exception and failed Session. Preserve all jobs, including environment/download failures. The checker exclusively creates `fatcat-injection-check.json` with artifact hashes.

`agent/fatcat/evidence.json` is the native trajectory, including synthetic usage, not an ATIF export. Real usage and billing remain null. Live runs are paused; the configuration below is retained for a future explicitly authorized resumption. Code review does not authorize spending or committing later changes.

## Authorized live attempt

**Paused reference: do not execute this section under the current evaluation policy.** Historical results below remain available for review. Retaining the entry and example commands does not disable them in code or authorize new spending; follow the [resumption conditions](../ARCHITECTURE/EVAL.md#retained-harbor-route-and-resumption) first.

After explicitly resuming, run only within the newly agreed single-task scope and spending cap; confirm that the implementation enforces that cap before execution. The current entry uses `deepseek-flash`, high thinking, 180 seconds per request, at most 32 requests and a 30-minute deadline. Its shared SDK transport gate includes delegated/compaction calls and enforces CNY 10 using conservative peak pricing; see [the accounting contract](../ARCHITECTURE/EVAL.md#authorized-deepseek-attempt). Recheck the dated profile in `src/deepseek-budget.ts` against the linked official tariff before another date. A timeout retains the full request reservation, and no automatic retry is enabled. If the same authorization continues after a failed attempt, set `kwargs.prior_cost_nano_cny` to its retained ceiling (and all earlier attempts) before launching again. The live profile allows 1 MiB of encoded request JSON; this avoids applying the smaller injected smoke envelope to a long real trajectory.

Use the freshly validated bundle and the injected `$config` above. The Harbor process must already have `DEEPSEEK_API_KEY` through private local configuration; never include its value in a command, JSON, bundle or log. The bridge uploads a temporary credential outside `/app` and `/logs`; the Node entry reads and unlinks it before Session starts. Only the official task instruction is supplied, without Oracle files or hidden test data. Live execution needs outbound API access, so the injected `network_mode: none` override is removed. Docker is local; this does not authorize cloud instances or result upload.

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

The checker requires a completed live Session, no Harbor exception and a normal official reward. A zero is valid when the official tests finish; a provider/environment error is not a successful integration result. Preserve failed jobs without automatically repeating paid work. `fatcat-live-check.json` binds raw result/config/lock, verifier logs and native trajectory hashes. The trajectory's model ledger retains response IDs/model strings and nullable usage; its peak-price CNY ceiling is not an invoice or a USD conversion. Record the source snapshot, bundle digest, exact task version and available container image identities alongside it. A single task does not establish full-suite performance.

[Live control metadata](../../../packages/eval/harbor/live-control.json) records the KAI-44 acceptance on 2026-10-23. The accepted attempt used **8 requests**, a 10-minute deadline, the 1 MiB envelope and the same high-thinking profile: Session completed, Harbor retained no exception and official reward was **0**. Neither required submission file was produced; all seven official tests failed. Fatcat's final answer explicitly reported the unfinished task. This validates the integration under that short budget, not task-solving quality or successful execution under the longer configuration.

The two earlier 32-request configurations remain failed records: 26 network calls ended at the local 256 KiB envelope (subsequently fixed), then 30 calls ended with `MODEL_TRUNCATED` when a response consumed the 16,384-token output cap. The final short attempt is a different configuration. Across all three attempts, 64 real requests have complete usage and a cumulative peak-price ceiling of **CNY 7.1813132**, within the authorized CNY 10. API responses returned `deepseek-flash`; the dated official documentation maps it to DeepSeek-V4.1-Flash-1017, but an exact server revision was not returned. Image-identity gaps and raw-artifact hashes are explicit in the metadata. Long responses can still truncate, and the global request gate can stop delegated work before a parent's separate final-response reservation; broader budget coordination remains KAI-23.
