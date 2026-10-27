# Quick start on Windows

English | [简体中文](../zh-CN/QUICK_START.md)

[Documentation](README.md) · [Configuration reference](REFERENCE/CONFIGURATION.md)

Fatcat runs from a local checkout with Node.js 24.x and pnpm 11.21.0. It does not require WSL, Docker, or a remote server. Run the following PowerShell commands from the repository root.

The root install links the local runtime, commands, TUI, Web UI, CLI and development-only verification and eval workspace packages; the existing start and verification commands build them in dependency order. No separate package installation or global Fatcat installation is needed. Contributor layout and build rules are in [Development](DEVELOPMENT.md#workspace-package-boundaries).

## Install and configure

```powershell
pnpm install --frozen-lockfile
if (-not (Test-Path -LiteralPath .env)) { Copy-Item .env.example .env }
```

The copy step preserves an existing `.env`. Edit that file and set your provider's key. The default provider is DeepSeek:

```dotenv
HARNESS_PROVIDER=deepseek
DEEPSEEK_API_KEY=your-local-key
```

Keep real keys in the ignored `.env` file or local environment variables. See [configuration](REFERENCE/CONFIGURATION.md) for Kimi, MiMo, Qwen, GLM, model selection and request budgets. The template sets an iteration budget of 128; the runtime default when unset is 32.

```powershell
pnpm start --checkConfig
pnpm start --prompt "Reply with a short greeting."
```

The first command checks local configuration without contacting the provider. Receiving a reply to the second command confirms that this configured model can serve a request. It sends a real request and uses your provider account.

## Choose an interface

```powershell
pnpm start --chat
pnpm start --tui
pnpm start --webui
```

Run one of these commands. Chat uses the terminal; TUI needs an interactive terminal; Web UI opens your default browser and keeps its server in the terminal. All use the same model, session and permission boundaries. See [interface operation](GUIDES/INTERFACES.md).

## Work in a directory

Replace the path below with an existing project directory. Keep running the command from the Fatcat repository root; `--workspace` selects the files the agent works on. A fresh checkout does not include `examples/workspace`.

```powershell
pnpm start --chat --workspace "D:\work\my-app"
```

Ask Fatcat to inspect a file and propose a small change. The default mode asks before file writes and commands. Review each proposed operation before allowing it. [The coding guide](GUIDES/CODING.md) explains reading, editing and checking results; [permission modes](REFERENCE/COMMANDS.md#permission-modes) describe the alternatives.

`pnpm start` builds first and loads the repository's `.env`, then restores the directory from which it was invoked. Relative `--workspace` paths resolve against that launch directory. A resumed session restores its saved workspace; a project session uses the project's directory.

## If startup fails

- Check Node and pnpm versions, then rerun the locked install. If PowerShell blocks `pnpm.ps1`, use `pnpm.cmd` for the same commands.
- A successful configuration check does not confirm API credentials, account access or network connectivity. Inspect the safe startup/request error and the [provider settings](REFERENCE/CONFIGURATION.md#providers).
- If Web UI cannot open automatically, use the complete private link printed in the terminal. If its port is occupied, use `pnpm start --webui --port 3211`.
- For all flags and combinations, see the [command reference](REFERENCE/COMMANDS.md). For building or testing Fatcat itself, see [development and verification](DEVELOPMENT.md).
