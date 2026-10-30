---
name: workspace-editing
description: Make focused changes to local workspace files using Fatcat read, write, and Windows shell tools when implementing or fixing code.
---

# Workspace Editing

Turn the user's requested behavior into a small edit and a relevant check. Follow the target project's conventions and existing runtime; this skill does not prescribe Fatcat's own source layout or package manager for other projects.

Use `glob` to find file paths and `grep` with a literal `query` to locate code, then `read` the relevant implementation and callers. Use workspace-relative paths unless current permission guidance permits outside/absolute paths. Search offsets count matching lines; ordinary file offsets count source lines. `glob` and `grep` accept explicit exclusion patterns and do not parse .gitignore. Follow `nextOffset`, and narrow the path on `SEARCH_LIMIT`. A search with `complete: false` cannot support an exhaustive absence claim. Each page reads current files, so pagination is not a snapshot.

For an existing file, send `edit` with `path` and `edits: [{oldText, newText}]`. Up to 32 replacements match unique, non-overlapping regions of the original file; all are validated before one publication. Whitespace and line endings must match exactly. For a new file, use `write` with `path` and `content`; this never overwrites an existing file, and its parent must exist. Preserve unrelated text and user edits. On a conflict, reread and revise the fragments. After uncertain publication or cleanup failure, inspect current files and write records before retrying: an error does not imply rollback.

Use `shell` for the project's relevant verification or an operation the file tools cannot express, within the user's task and existing authorization. Commands run in fresh, non-interactive Windows PowerShell processes; variables and directory changes do not persist. Set `cwd` explicitly when needed, and check each native command's exit code if combining commands. Prefer a focused command with bounded output. File write authorization does not authorize commands, and a denied operation must not be rerouted through shell or delegation.

Check the outcome after the last relevant edit. Distinguish a successful edit from a passed test, and describe any unavailable verification precisely.
