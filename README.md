# Agent Harness

一个独立的 TypeScript Agent Harness 项目，首版面向 Windows 原生运行。

## 当前能力

已完成供 review 的工程准备：TypeScript 构建、CLI 帮助、本地配置校验和配置测试。首个模型服务已确定为 DeepSeek。

模型请求、任务输入、内存历史、工具执行和 Agent Loop 尚未实现；当前不能完成 Agent 任务。CLI 的配置检查不发送网络请求，也不验证密钥或模型权限。

## Windows 安装与运行

使用 Node.js 24.x 和 pnpm 11.21.0。项目固定 pnpm 版本，本机验证版本为 Node.js 24.19.0、pnpm 11.21.0；无需 WSL、Docker、Bun 或全局 TypeScript。运行时下载见 [Node.js 官方下载页](https://nodejs.org/en/download)。

如果本机尚未安装 pnpm，可先运行 `npm install --global pnpm@11.21.0`；已有可用 pnpm / Corepack 时无需重复安装。项目内统一使用 pnpm，依赖由 pnpm-lock.yaml 固定。

在项目根目录的 PowerShell 中运行：

```powershell
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm start --help
```

`pnpm install --frozen-lockfile` 按锁文件安装依赖，锁文件与 package.json 不一致时会报错；`pnpm start` 会先编译，再启动 CLI。没有参数时显示帮助。如本机 PowerShell 策略限制 `pnpm.ps1`，可将命令中的 `pnpm` 换成 `pnpm.cmd`。

## 本地配置检查

复制配置示例，已有 `.env` 时保留原文件：

```powershell
if (-not (Test-Path -LiteralPath .env)) {
  Copy-Item -LiteralPath .env.example -Destination .env
}
```

编辑 `.env`：

```dotenv
DEEPSEEK_API_KEY=local-config-check-only
DEEPSEEK_MODEL=deepseek-flash
HARNESS_MAX_ITERATIONS=8
```

这里的 Key 是本地检查用的虚构值。本轮无需真实凭据；模型接入后再在本机配置真实 Key，不写入 Git 或聊天。

```powershell
pnpm start --check-config
```

预期显示“本地配置检查通过（未连接 DeepSeek）”，以及模型名和迭代上限；不会显示 Key。Node 加载根目录的 `.env`，同名进程环境变量优先。未设置模型或迭代上限时采用示例中的默认值，显式空值则报错。没有 `.env` 时 Node 可能提示文件不存在，但仍可从环境变量读取配置。

默认模型名来自 [DeepSeek 官方接入文档](https://api-docs.deepseek.com/)（2026-09-18 核对），真实可用性尚未验证。迭代上限目前只做正整数校验，循环限制将在后续实现。

## 验证

```powershell
pnpm run typecheck
pnpm test
pnpm run build
```

`pnpm test` 会先构建，再使用 Node 内置测试运行器检查配置。测试使用虚构值，不读取 `.env`，不访问模型服务。

| 检查场景 | 当前预期 |
| --- | --- |
| 无参数、`--help` 或 `-h` | 显示帮助，退出码 0，不要求配置 Key |
| `--check-config` 且配置有效 | 输出本地配置摘要，退出码 0 |
| Key 缺失、模型为空或迭代上限非法 | 输出错误，退出码 1 |
| 未支持的参数、多个参数或任务文本 | 明确提示暂不支持，退出码 2 |

实际验证结果见 [PROGRESS.md](docs/PROGRESS.md)。直接模型响应与工具闭环仍待实现和验收。

## 项目文档

- [项目目标与边界](docs/PROJECT.md)
- [阶段路线图](docs/ROADMAP.md)
- [实际进度与验证结果](docs/PROGRESS.md)
- [架构总览与系统设计](docs/ARCHITECTURE/README.md)
- [Agent Loop 设计与实现安排](docs/ARCHITECTURE/AGENT_LOOP.md)
- [开发协作约定](AGENTS.md)
