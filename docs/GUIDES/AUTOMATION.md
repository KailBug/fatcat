# Scheduled and file-change tasks

[Documentation](../README.md) · [Automation architecture](../ARCHITECTURE/AUTOMATION.md)

## Schedule work in a session

Describe the task and trigger in chat, TUI or Web UI, for example: “Every ten minutes, check this project's TODO file and report changes. Stop after three runs.” Confirm that the tool actually created the task; a natural-language promise is not a schedule.

The task binds to the current saved Session. Later activations continue that history using its workspace and current permissions, even when the interface is showing another session. In chat/TUI, `/cron <description>` sends a scheduling request to the model; `/cron`, `/cron list`, `/cron pause <id>`, `/cron resume <id>` and `/cron delete <id>` manage tasks locally. Web UI provides a **Cron tasks** panel with existing/new session binding and trigger forms.

Keep the process running with that workspace selected. Task discovery covers the current workspace, including other sessions there; the global session list does not enable scheduling across every saved workspace. Switching to another directory stops monitoring the old one, and returning does not replay missed occurrences. Task definitions, counters and expiry persist, but this does not install a Windows service or OS scheduler. Forking does not copy tasks; joining a project or changing its directory pauses existing tasks for review; deleting a session removes its tasks. Resuming a task does not reset its counters or expiry.

Defaults are 20 attempts and 24 hours, with maxima of 1000 attempts and seven days. A session can hold 32 tasks, with at most 128 enabled tasks and 64 watched files per workspace. Failed attempts count toward limits. Writes and commands retain current approval rules, so scheduling is not a grant of unattended access.

## File-change triggers

Select explicit workspace text files. Directories, globs, hidden paths, links and paths outside the workspace are refused even in Free to go. Each file is limited to 1 MiB; its parent directory must exist. A trigger accepts 1–32 files and a debounce of 1–60 seconds.

The scheduler polls while idle. All changes during an automated turn, including external edits, are ignored when the baseline is refreshed afterward; this prevents self-trigger loops. A change that returns to identical bytes between polls can be missed. Unreadable or invalid watched paths pause a session task. Inspect its status and fix the path before resuming.

## Standalone JSON runner

Use this advanced mode for a fixed configuration that creates a fresh saved Session per activation, with process-local counters. It is separate from session-bound tasks.

```powershell
pnpm start --automation automation.example.json --check-automation
pnpm start --automation automation.example.json --permission read-only
```

The first command validates locally without model credentials. The second runs the repository's [example configuration](../../automation.example.json). Config and watched relative paths resolve against the selected workspace, not the JSON file's directory. A minimal interval configuration is:

```json
{
  "version": 1,
  "maxRuns": 2,
  "maxRuntimeSeconds": 300,
  "tasks": [
    {
      "id": "review",
      "prompt": "Read the workspace README and summarize outstanding work.",
      "trigger": { "type": "interval", "seconds": 60 }
    }
  ]
}
```

Supported triggers are interval, one-shot time, five-field numeric cron and file change. See [automation configuration](../REFERENCE/CONFIGURATION.md#automation-json) for fields, defaults and trigger syntax, and [automation architecture](../ARCHITECTURE/AUTOMATION.md#调度与文件语义) for coalescing, time/DST and locking behavior.

This configuration is read once. Restarting resets standalone counters, intervals and file baselines; overdue one-shots and offline cron occurrences are skipped. Permissions come from launch options, never JSON. Piped input cannot approve an operation. Use only deliberately authorized permissions for unattended work.

Results are JSON lines on stdout (`automation_finished`), with lifecycle/execution reports on stderr. Inspect each result: expiry or exhausted budgets exit 0 even if individual attempts failed, including failure to create or save an activation's Session. Ctrl+C cancels active work and exits 130; it does not roll back completed writes. Configuration, scheduler-lock or file-monitor errors that stop the runner return nonzero. A workspace lock in the selected session store prevents duplicate schedulers; after a crash, verify the recorded owner process has exited before removing only its stale lock.
