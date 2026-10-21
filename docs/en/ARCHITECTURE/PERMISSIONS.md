# Permissions: policy, approvals and execution guards

English | [简体中文](../../zh-CN/ARCHITECTURE/PERMISSIONS.md)

[Architecture](README.md) · [Permission modes](../REFERENCE/COMMANDS.md#permission-modes)

Runtime enforces permissions; model guidance only explains available capabilities. CLI, TUI, Web UI and parent/child work share policy. Saved history, Skills, Memory and tool content cannot grant permissions.

## Module responsibilities

| Source | Responsibility |
| --- | --- |
| `packages/runtime/src/permissions/types.ts`, `policy.ts` | Modes, low-level policies, launch ceilings, operation snapshots and busy locks |
| `packages/runtime/src/permissions/approval.ts` | One pending approval, unique IDs, one decision and cancellation settlement |
| `packages/cli/src/permissions/terminal.ts` | Approval adapter and control-character escaping |
| `packages/runtime/src/permissions/workspace.ts`, `text-file.ts` | Canonical paths, mode scope, file identity and bounded text reads |
| `packages/runtime/src/permissions/command-risk.ts` | Bounded lexical risk classification for Free to go |
| `packages/runtime/src/permissions/process.ts` | PowerShell environment, deadlines, output and cleanup |
| `packages/runtime/src/permissions/web-request.ts`, `browser.ts` | HTTP address/download guards and browser approval/local-resource validation |

Tools retain protocols and operation journals; interfaces only submit mode selections or one-time decisions.

## Policy and access scope

Manual approves each write/command; Accept edits automatically permits controlled file edits; Plan forbids ordinary writes/commands. All three retain workspace and public HTTP(S) boundaries; Plan still allows public research. Free to go expands local paths and HTTP(S) addresses, automatically allowing recognized ordinary commands while asking about dangerous/opaque ones.

Ordinary file scope rejects parent traversal, absolute/device paths, dot-prefixed names, node_modules, symbolic links/junctions and special files. It checks each level with lstat/realpath and rechecks opened type/dev/ino/link count. Hidden-name rules differ from Windows hidden attributes. Free permits outside-workspace, hidden, dependency, linked paths and other text extensions, using canonical absolute paths and deduplicated searches. Regular files/directories, encoding, size and conflict checks remain. Do not assume ordinary naming allowlists apply to Free.

Legacy permission/shell-permission combinations do not implicitly select Free. Web deny independently disables research and is not a shell network firewall. Controlled browser always stays in the workspace, including Free; see [Browser](BROWSER.md).

Memory writes are conversation metadata with current-user evidence and identity checks. Plan/read-only do not disable them, without granting ordinary file writes; see [Memory](MEMORY.md).

## Switching and one-time approval

Each tool execution acquires a policy snapshot and operation lock spanning validation, approval, execution and settlement, preventing scope changes mid-operation. Web UI switches only while idle; all server tabs share policy. Switching does not rebuild Tools, Session or journals.

Explicit launch read-only, shell-deny and web-deny remain ceilings that the menu cannot relax. Initial plan mode alone is not a permanent ceiling. The command reference owns combination rules. Permissions/approvals live only in the current process; resume uses current configuration and never restores old decisions.

ApprovalCoordinator allows one pending item. Cancellation, EOF, stop or close denies it. Old IDs, duplicate replies and changed state cannot authorize another action. Recheck file identity/content after write approval and cwd after command approval. Presentation must not omit command bodies or let control characters disguise content.

## Free to go command-risk classification

The classifier examines bounded PowerShell tokens, command names, quotes, pipelines and nesting without model or external-service requests. Deletion/formatting, dangerous Git operations, storage/security configuration, download-and-execute, nested interpreters, encoded/computed commands and unknown scripts require one-time approval. Tools generate approvalReason; the model cannot supply a forged reason.

Even with low-level shellPermission=allow, Free risk commands require callback approval; noninteractive execution cannot auto-approve. Legacy explicit shell-allow preserves its behavior without gaining Free file/network scope.

This is not a full PowerShell AST, safety proof or OS sandbox. Allowed builds, tests, hooks, executables and modules can still execute arbitrary code. Environment filtering, path checks and browser routing cannot defend against malicious local processes or constrain all current-account privileges.

## Verification and unimplemented scope

Check launch ceilings, idle switching, operation locks, parent/child sharing, denial/cancellation/replay, path races, DNS/redirects and original entry combinations. UI checks cover approvals, disconnects and narrow layouts. Injected models do not prove real models always follow guidance.

OS file/process sandboxing, model auto-approval, user rule lists and automatic Plan-to-implementation transitions are unimplemented. New permissions must cover actual execution entries, not only prompts or UI.
