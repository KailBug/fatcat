

<a id="quick-start-on-windows"></a>

# Windows 快速开始

[English](../en/QUICK_START.md) | 简体中文

[文档首页](README.md) · [配置参考](REFERENCE/CONFIGURATION.md)

Fatcat 从本地仓库运行，要求 Node.js 24.x 和 pnpm 11.21.0，不需要 WSL、Docker 或远程服务器。以下 PowerShell 命令均从仓库根目录执行。

根目录安装会链接本地 runtime、commands、TUI、Web UI、CLI 和仅用于开发的 verification、eval workspace 包；现有启动和验证命令按依赖顺序构建它们，无需分别安装包或全局安装 Fatcat。贡献者目录与构建规则见[开发指南](DEVELOPMENT.md#workspace-package-boundaries)。

<a id="install-and-configure"></a>

## 安装与配置

```powershell
pnpm install --frozen-lockfile
if (-not (Test-Path -LiteralPath .env)) { Copy-Item .env.example .env }
```

复制步骤保留已有 `.env`。编辑该文件并填写供应商密钥。默认供应商为 DeepSeek：

```dotenv
HARNESS_PROVIDER=deepseek
DEEPSEEK_API_KEY=your-local-key
```

真实密钥只保存在被忽略的 `.env` 或本地环境变量中。Kimi、MiMo、Qwen、模型选择与请求预算见[配置参考](REFERENCE/CONFIGURATION.md)。模板的迭代预算为 128；未设置时运行时默认为 32。

```powershell
pnpm start --checkConfig
pnpm start --prompt "Reply with a short greeting."
```

第一条命令仅检查本地配置，不联系供应商。第二条命令收到回复，才说明当前配置的模型可以处理请求；它会发送真实请求并使用你的供应商账户。

<a id="choose-an-interface"></a>

## 选择界面

```powershell
pnpm start --chat
pnpm start --tui
pnpm start --webui
```

选择其中一条执行。Chat 使用终端；TUI 要求交互式终端；Web UI 打开默认浏览器，服务进程继续运行在终端中。三者共用模型、会话和权限边界，详见[界面操作](GUIDES/INTERFACES.md)。

<a id="work-in-a-directory"></a>

## 在指定目录中工作

```powershell
pnpm start --chat --workspace examples/workspace
```

让 Fatcat 检查一个文件并提出小范围修改。默认模式在写文件和执行命令前请求批准，请逐项审阅。[编码指南](GUIDES/CODING.md)说明读取、编辑和结果检查；其他模式见[权限模式](REFERENCE/COMMANDS.md#permission-modes)。

`pnpm start` 先构建并加载仓库 `.env`，再恢复到调用它的目录。相对 `--workspace` 路径基于该启动目录解析。恢复会话会恢复其已保存工作目录；项目会话使用项目目录。

<a id="if-startup-fails"></a>

## 启动失败时

- 检查 Node 和 pnpm 版本，再重新执行锁定安装。如果 PowerShell 阻止 `pnpm.ps1`，相同命令可使用 `pnpm.cmd`。
- 配置检查成功不代表 API 密钥、账户权限或网络连通性有效。检查经过安全处理的启动/请求错误，以及[供应商设置](REFERENCE/CONFIGURATION.md#providers)。
- Web UI 无法自动打开时，使用终端打印的完整私有链接。端口被占用时可运行 `pnpm start --webui --port 3211`。
- 所有参数及组合见[命令参考](REFERENCE/COMMANDS.md)；构建和测试 Fatcat 本身见[开发与验证](DEVELOPMENT.md)。
