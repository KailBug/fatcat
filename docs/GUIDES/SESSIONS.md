# Sessions, projects and context

[Documentation](../README.md) · [Command reference](../REFERENCE/COMMANDS.md)

## Continue a conversation

```powershell
pnpm start --chat --name review
pnpm start --continue
pnpm start --resume review
pnpm start --resume review --fork-session --name alternative
```

`--continue` selects the most recently updated session across all workspace buckets in the selected store. `--resume` selects by ID or name; use an ID when a name is ambiguous. Without another mode or prompt, session-selection options start chat. Bare `--resume` provides a terminal picker, or a list when output is redirected, without requiring model credentials. Starting chat/TUI itself requires configured credentials.

In chat/TUI, `/sessions` lists saved sessions, `/resume <id-or-name>` switches, `/rename <name>` names, and `/fork [name]` branches completed history. `/new [name]`, `/clear` and `/reset` retain the old session and create a new one. Inside a project, the new session remains in that project; `/new --standalone [name]` leaves that scope.

A fork is a conversation branch, not a Git branch or file copy. It copies completed history and attachment associations, but not private Memory or automation tasks. Project forks continue to use shared project materials and Memory. Session changes do not undo tools or clear process-local journals and usage.

For an unsaved run, add `--no-session-persistence`. It cannot resume, fork or join a project through startup flags. See [startup combinations](../REFERENCE/COMMANDS.md#startup-combinations).

## Web UI drafts

A new unnamed Web UI chat remains unsaved while you browse materials, inspect Memory/context or change its directory/project binding. A normal task saves it before execution; accepting an attachment, naming, forking or creating an automation also saves it. A local Memory modification command saves its source session before changing the record, so a failed modification can still leave a saved empty chat. With `--no-session-persistence`, this state remains in memory.

## Select or change a workspace

New independent sessions use the launch directory unless `--workspace <directory>` overrides it. Resumed sessions restore their directory. Relative startup paths resolve from the launch directory.

```text
/workspace
/workspace "D:\work\example"
```

In chat/TUI, the first command shows the current directory and the second changes an independent session's directory. Relative changes resolve from its current workspace. Invalid paths leave the existing workspace intact. Web UI provides **Change workspace** through the path control and session menu, using a native Windows directory picker. This requires an interactive desktop; cancelling or an expired picker leaves the session unchanged.

A directory change retains history, files and the original session-storage bucket. It does not move files, reset tool journals or merge sessions. Project sessions use the shared project directory and cannot override it individually.

## Share a project

A Project groups independent conversations around one working directory, shared attachments and shared Memory. Sessions in the same directory are not automatically a project and do not share their histories.

```text
/project create "Example" "D:\work\example"
/projects
/project use Example
/project
```

Creation requires an existing directory and does not switch the current session. `use` starts a new project session. At startup, `pnpm start --chat --project Example` selects an existing project. Web UI supports creation, grouped chats and project management through its sidebar.

To move an independent session into a project:

```text
/project join Example
/project confirm <token-from-preview>
```

Review the preview before confirming, or use `/project cancel`. Existing private attachment associations and active private Memory become project-shared. Histories stay separate; workspace files and old source paths do not move. Existing automation tasks are paused for review. If the session, project or materials changed, a stale confirmation is rejected; request a fresh preview.

Web UI also supports **Move to project** and drag/drop with the same confirmation. Project rename, directory change and deletion are Web UI management actions. Changing a project directory affects its members without moving files. Deleting a project removes its member sessions, tasks and eligible unreferenced materials, while preserving workspace files and originals still referenced elsewhere. There is no detach or cross-project migration operation. See [project architecture](../ARCHITECTURE/PROJECTS.md).

## Context management

In chat, TUI or the Web UI composer:

```text
/context
/compact Preserve the API constraints and remaining test failures.
```

`/context` is local and reports full-history/projected-conversation JSON bytes and message counts. These exclude dynamic guidance, tool definitions and execution journals; they are not token measurements.

`/compact [focus]` uses the current model to summarize older completed turns while retaining the latest completed turn and all original history. Focus text is limited to 2048 UTF-8 bytes. It allows at most `min(HARNESS_MAX_ITERATIONS, 8)` summary requests, under the same request-byte limit. Summaries are lossy: reread current files and reload Skills when needed.

Automatic compaction is enabled by default. If older-read omission still cannot fit a request within the local byte budget, Fatcat can compact eligible older history once and continue the same turn. The rejected attempt, summaries and continuation share the turn's request allowance. Already executed tools are not replayed. Provider HTTP errors, timeouts and token thresholds do not trigger this recovery. Set `HARNESS_AUTO_COMPACT=false` for manual-only compaction.

A tiny request budget, one oversized recent turn or large journals can still prevent continuation. Summary usage is reported even if subsequent work fails. A successful summary is saved before continuation and remains if continuation is cancelled. Cancelled/invalid summaries or failed saves retain the previous projection. Full history still counts toward the session-file limit. See [context architecture](../ARCHITECTURE/CONTEXT.md).

## Storage and recovery

Sessions default to the user's `.fatcat/sessions` directory, organized into workspace buckets. `FATCAT_SESSION_DIR` overrides the root, including its project and shared-material state. Lists cover all buckets in that store. Session files have a 64 MiB limit and contain plaintext prompts, tool results and loaded Skill text. Permissions and provider credentials are not restored from history; avoid including secrets in conversation content.

Resume uses the current launch configuration and permissions. Interrupted operations are not automatically replayed. Read any warning, inspect current files/processes, then decide how to continue. Revision conflicts or another process's running claim can refuse a write; do not overwrite the competing session file. After a crash, inspect the reported lock and owner PID before removing a stale lock.

Only the current v4 session format is supported. Earlier formats are not loaded or migrated; their files are not automatically rewritten or deleted. Avoid mixed-version writers. Deleting a session does not restore workspace files and may leave unreferenced attachment originals. There is no automatic retention cleanup. See [session architecture](../ARCHITECTURE/SESSION.md) and [material lifecycle](MATERIALS.md#remove-materials).
