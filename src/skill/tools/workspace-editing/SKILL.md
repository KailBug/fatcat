---
name: workspace-editing
description: Make focused changes to local workspace files using Fatcat read, write, and Windows shell tools when implementing or fixing code.
---

# Workspace Editing

Turn the user's requested behavior into a small edit and a relevant check. Follow the target project's conventions and existing runtime; this skill does not prescribe Fatcat's own source layout or package manager for other projects.

Use `read` with a workspace-relative path. Locate code with a case-sensitive literal `query`, then read the relevant implementation and callers. Search offsets count matching lines; ordinary file offsets count source lines. Follow the returned `nextOffset`, and narrow the path on `SEARCH_LIMIT`. A search with `complete: false` cannot support an exhaustive absence claim. Each page reads current files, so pagination is not a snapshot.

For an existing file, send `write` with `path`, `oldText`, and `newText`. Read the current text first and choose a unique fragment with enough surrounding context; whitespace and line endings must match exactly. For a new file, use `path` and `content`; this never overwrites an existing file, and its parent directory must already exist. Preserve unrelated text and user edits. On a conflict, reread and revise the proposed fragment. After an uncertain write or cleanup error, inspect the current file and available write records before retrying: an error does not imply rollback.

Use `shell` for the project's relevant verification or an operation the file tools cannot express, within the user's task and existing authorization. Commands run in fresh, non-interactive Windows PowerShell processes; variables and directory changes do not persist. Set `cwd` explicitly when needed, and check each native command's exit code if combining commands. Prefer a focused command with bounded output. File write authorization does not authorize commands, and a denied operation must not be rerouted through shell or delegation.

Check the outcome after the last relevant edit. Distinguish a successful edit from a passed test, and describe any unavailable verification precisely.
