# Command reference

[Documentation](../README.md) · [Configuration](CONFIGURATION.md) · [Quick start](../QUICK_START.md)

## Startup flags

Run `pnpm start --help` for the installed checkout's help. `pnpm start` builds first; commands below assume the repository root.

| Flag | Meaning |
| --- | --- |
| `--help`, `-h` | Print help without model credentials; no arguments also prints help |
| `--version`, `-v` | Print the package version without credentials or session creation |
| `--checkConfig` | Validate local provider configuration; no provider request |
| `--prompt <text>` or positional text | Run one task |
| `--chat` | Continuous terminal conversation |
| `--tui` | Interactive terminal UI; requires a terminal |
| `--webui` | Local browser UI |
| `--port <number>` | Web UI port, 1–65535; default 3210 on `127.0.0.1` |
| `--workspace <directory>` | Select a task workspace; relative paths use the launch directory |
| `--continue`, `-c` | Continue the latest session in the selected store |
| `--resume [id-or-name]`, `-r` | Resume a session; without a selector, show a picker/list |
| `--name <name>`, `-n` | Name the selected/new session |
| `--project <id-or-name>` | Start a session in an existing project |
| `--fork-session` | Branch the completed history selected by continue/resume |
| `--no-session-persistence` | Keep a new run in memory |
| `--permission-mode <mode>` | Select a combined permission mode below |
| `--permission <policy>` | Legacy file policy: `ask`, `read-only`, `workspace-write` |
| `--shell-permission <policy>` | Legacy command policy: `ask`, `deny`, `allow` |
| `--web-permission <policy>` | Web tool `allow` (default) or `deny` |
| `--automation <path>` | Run a standalone automation configuration |
| `--check-automation` | Validate that configuration without model credentials |

## Startup combinations

- Choose one mode: help, version, config check, chat, TUI, Web UI, automation or one task. Do not combine `--prompt` with positional prompt text.
- Session selection/name/project flags imply chat when no other mode or prompt is given. `--continue` and `--resume` are mutually exclusive; `--fork-session` requires one of them.
- `--no-session-persistence` cannot combine with resume, continue, fork or project selection. Names must be nonempty.
- `--project` cannot combine with resume/continue. A project's explicit workspace must match its directory; project sessions cannot override it individually.
- `--workspace` and permission flags require an execution mode. `--port` requires Web UI. `--check-automation` requires `--automation`.
- Standalone automation requires fresh persistent sessions and cannot combine with selection, naming, project, fork or no-persistence options.
- `--permission-mode` cannot combine with `--permission` or `--shell-permission`. Free to go cannot combine with web deny. Read-only permits only shell deny if a shell policy is supplied.

There are no startup `--skills`, `--sessions` or `--subagent` switches. Use chat/TUI catalog/list commands and ordinary task-driven delegation.

Without a selector, `--resume` lists saved sessions and exits when stdin or stderr is not a terminal; this path does not require model credentials. In an interactive terminal it asks for an ID/name, and `/exit` cancels selection. Argument-combination errors are still checked before listing or showing help. TUI requires terminal stdin/stdout and rejects `TERM=dumb`. Maintainer guidance for parsing and launch ordering is in [Development](../DEVELOPMENT.md).

## Permission modes

| Mode / Web UI label | Controlled file changes | Commands | File and HTTP(S) scope |
| --- | --- | --- | --- |
| `default` / Manual | Ask each time | Ask each time | Workspace / public network |
| `acceptEdits` / Accept edits | Automatic workspace writes | Ask each time | Workspace / public network |
| `plan` / Plan | Denied | Denied | Workspace reads / public research |
| `freeToGo` / Free to go | Automatic under broader local access | Ordinary recognized commands automatic; dangerous or opaque forms ask | Local access beyond workspace / private addresses and custom ports allowed |

Legacy `--permission ask` and `--shell-permission ask` are the defaults. `workspace-write` preauthorizes writes only; `read-only` also forbids commands. `--shell-permission allow` preauthorizes commands. Web denial disables the research tool, not network access through shell.

Web UI can switch modes while idle. Explicit read-only, shell-deny or web-deny launch restrictions remain ceilings; starting with `--permission-mode plan` alone permits a later switch. Session history and Skills cannot restore or grant approvals.

Shell execution is not OS-sandboxed. Free to go command-risk checks are heuristic and cannot establish that a build script or executable is safe. The controlled browser always stays inside the workspace and follows shell permission; Plan/read-only/shell-deny forbid it. Memory metadata operations remain available in Plan/read-only without granting file access. See [permission architecture](../ARCHITECTURE/PERMISSIONS.md).

## Chat and TUI commands

Enter each command on its own line. These are local unless explicitly marked as model work. They are not general shell commands. Web UI provides session/project/material/automation controls instead of exposing this whole terminal command set; its composer also accepts the context and Memory commands below.

| Command | Effect |
| --- | --- |
| `/help`, `/exit` | Show commands; exit |
| `/status` (TUI only) | Show full configuration and metric definitions |
| `/new [--standalone] [name]` | Create a session, retaining the old one; optionally leave project scope |
| `/clear`, `/reset` | Create a new session in the current scope |
| `/sessions`, `/resume [id-or-name]` | List or switch saved sessions; bare resume lists |
| `/rename <name>`, `/fork [name]` | Rename; branch completed history |
| `/workspace [path]` | Show/change an independent session's workspace |
| `/projects`, `/project` | List projects; show current scope |
| `/project create "name" "directory"` | Create a project around an existing directory |
| `/project use <id-or-name>` | Start a new project session |
| `/project join <id-or-name>` | Preview moving the current private session and materials into a project |
| `/project confirm <token>`, `/project cancel` | Confirm/cancel that preview |
| `/attachments`, `/attach "path"` | List scoped materials; import a permitted file |
| `/attachment remove <reference>` | Remove this scope's association |
| `/attachment delete <reference> [--confirm]` | Preview/confirm eligible permanent deletion |
| `/skills` | List discovered Skill metadata |
| `/cron [list]` | List session-bound tasks |
| `/cron pause <id>`, `/cron resume <id>`, `/cron delete <id>` | Manage a task |
| `/cron <description>` | Send a scheduling request to the model |

Session switches retain completed file/command effects and process journals. Project migration shares private attachments and Memory after confirmation. See [sessions](../GUIDES/SESSIONS.md), [materials](../GUIDES/MATERIALS.md) and [automation](../GUIDES/AUTOMATION.md) before destructive management operations.

## Context commands

Available in chat, TUI and the Web UI composer:

| Command | Effect |
| --- | --- |
| `/context` | Local conversation byte/message counts, not token usage |
| `/compact [focus]` | Model-generated summary of older completed turns; focus at most 2048 UTF-8 bytes |

See [context management](../GUIDES/SESSIONS.md#context-management) for automatic recovery, budgets and cancellation.

## Memory commands

Available in chat, TUI and the Web UI composer. Ordinary-language remembering is also supported.

| Command | Effect |
| --- | --- |
| `/memory [list]` | List current scoped Memory |
| `/memory show <id>` | Inspect a record and revisions |
| `/memory add session\|project\|global <text>` | Explicitly save in the chosen scope |
| `/memory update <id> <revision> <text>` | Replace the current revision |
| `/memory delete <id> <revision>` | Delete using the current revision |

Use one scope value, not the literal pipe-separated alternatives. See [Memory operation and limits](../GUIDES/MATERIALS.md#remember-facts-across-conversations).

## Exit status and output

| Code | Meaning |
| --- | --- |
| 0 | Successful task/clean exit, help, valid configuration; automation may also exhaust its budget with failed attempts |
| 1 | Configuration, model, protocol or budget failure; chat/TUI can return failure after an earlier failed turn |
| 2 | Usage error or empty task |
| 130 | Cancellation where the interface exits |

Task answers go to stdout; events, execution reports and approval prompts go to stderr. `pnpm start` also emits package/build output. For automation, inspect per-attempt JSON results rather than only the process exit code. TUI cancellation can keep the interface open; a clean later exit does not erase a failed/cancelled turn. See [interface operation](../GUIDES/INTERFACES.md).
