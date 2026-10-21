import { parseArgs } from "node:util";
import { HarnessError } from "@fatcat/runtime/errors";
import { isPermissionMode } from "@fatcat/runtime/permissions/policy";

export const cliHelp = `Fatcat - local coding assistant

Usage: pnpm start [options] ["prompt"]

Quick start:
  pnpm start --chat                         Start a conversation
  pnpm start --webui                        Open the browser interface
  pnpm start --chat --workspace D:/my-app    Work in another directory
  pnpm start "Explain this project"         Run one task and exit

Run:
  --chat                          Terminal conversation
  --tui                           Interactive terminal dashboard
  --webui                         Browser UI at 127.0.0.1:3210; opens automatically
  --port <1-65535>                Web UI port (default: 3210)
  --prompt <text>                 Task text; alternative to a positional prompt
  --checkConfig                   Check local configuration, without API calls
  --help, -h                      Show this help
  --version, -v                   Show version

Workspace and sessions:
  --workspace <directory>         Working directory (default: launch directory)
  --continue, -c                  Resume the latest saved session
  --resume, -r [id-or-name]       Resume a session; omit ID to pick/list locally
  --name, -n <name>               Name the session
  --fork-session                  Copy history when using --continue or --resume
  --no-session-persistence        Keep a new standalone session in memory
  --project <id-or-name>          New session in an existing project

  Sessions save automatically. Resuming restores the workspace, with current permissions.
  --continue, --resume and --project are mutually exclusive and require persistence.

Permissions:
  --permission-mode <mode>
    default                       Ask before file writes and commands (default)
    acceptEdits                   Allow workspace file writes; ask before commands
    plan                          Read-only planning; deny writes and commands
    freeToGo                      Allow files/networks beyond the workspace/public boundary;
                                  run ordinary commands; ask for dangerous/opaque commands
  --web-permission <allow|deny>   Web search and page reading (default: allow)

  Advanced alternatives to --permission-mode:
  --permission <policy>           ask (default), read-only, workspace-write
  --shell-permission <policy>     ask (default), deny, allow
  read-only forbids writes and commands; workspace-write allows file writes.
  Do not mix --permission-mode with --permission or --shell-permission.
  freeToGo requires web access. Shell runs as your user, without an OS sandbox;
  --web-permission deny disables only the web tool, not shell networking.

Automation:
  --automation <file.json>        Run standalone jobs; fresh session per activation
  --check-automation              Validate --automation configuration without API calls
  For session schedules, describe the task in chat or use /cron.
  Keep the process open; missed runs are not replayed.

Inside chat/TUI:
  /help                           All conversation commands and syntax
  /sessions, /projects, /skills   List saved sessions, projects or available skills
  /project create "name" "path"   Create a project; /project use <id-or-name> starts it
  /workspace <path>               Change the session workspace
  /context, /compact              Inspect context size or summarize older turns
  /exit                           End the conversation

Configuration and details:
  Before chatting, configure a provider key: docs/en/QUICK_START.md.
  HARNESS_PROVIDER: deepseek (default), kimi, mimo, qwen.
  FATCAT_SESSION_DIR: session store (default: ~/.fatcat/sessions).
  Read file/skill content is sent to the provider; saved history is local plaintext.
  Delegation: up to two child tasks per turn, three model requests each; no nesting.
  Task output: answer on stdout; logs and execution_report on stderr. Ctrl+C cancels.

  docs/README.md                    Documentation language selection
  docs/en/REFERENCE/COMMANDS.md      Full syntax, combinations and conversation commands
  docs/en/REFERENCE/CONFIGURATION.md Provider settings, limits and environment variables
  docs/en/GUIDES/                    Session, project, skill and automation workflows`;

/** Parse syntax and option combinations without starting a host or reading configuration. */
export function parseCliOptions(args: string[]) {
  let parsed;
  try {
    parsed = parseArgs({
      args: optionalResumeArgs(args),
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
        checkConfig: { type: "boolean" },
        continue: { type: "boolean", short: "c" },
        resume: { type: "string", short: "r" },
        name: { type: "string", short: "n" },
        project: { type: "string" },
        "fork-session": { type: "boolean" },
        "no-session-persistence": { type: "boolean" },
        prompt: { type: "string" },
        chat: { type: "boolean" },
        tui: { type: "boolean" },
        webui: { type: "boolean" },
        automation: { type: "string" },
        "check-automation": { type: "boolean" },
        port: { type: "string" },
        workspace: { type: "string" },
        permission: { type: "string" },
        "permission-mode": { type: "string" },
        "shell-permission": { type: "string" },
        "web-permission": { type: "string" },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch {
    throw new HarnessError("USAGE", "Invalid arguments. Run pnpm start --help.");
  }
  const { values, positionals } = parsed;
  const hasSelection = Boolean(values.continue || values.resume !== undefined || values.name !== undefined || values.project !== undefined);
  if (hasSelection && !values.help && !values.version && !values.checkConfig
    && !values.tui && !values.webui && values.automation === undefined && values.prompt === undefined && positionals.length === 0) values.chat = true;

  const modes = Number(Boolean(values.help))
    + Number(Boolean(values.version))
    + Number(Boolean(values.checkConfig))
    + Number(Boolean(values.chat))
    + Number(Boolean(values.tui))
    + Number(Boolean(values.webui))
    + Number(values.automation !== undefined)
    + Number(values.prompt !== undefined || positionals.length > 0);

  if (modes > 1 || (values.prompt !== undefined && positionals.length > 0)) {
    throw new HarnessError("USAGE", "Choose one mode: help, version, config check, chat, TUI, Web UI, automation, or one prompt.");
  }
  if (values.workspace !== undefined && (!values.workspace.trim() || values.help || values.checkConfig
    || (!values.chat && !values.tui && !values.webui && values.automation === undefined && values.prompt === undefined && positionals.length === 0))) {
    throw new HarnessError("USAGE", "Use --workspace with a task and a non-empty directory.");
  }
  if (values.port !== undefined && (!values.webui || !/^[1-9]\d*$/.test(values.port) || Number(values.port) > 65535)) {
    throw new HarnessError("USAGE", "Use --port with --webui and an integer from 1 to 65535.");
  }
  const hasTask = Boolean(values.chat || values.tui || values.webui || values.automation !== undefined || values.prompt !== undefined || positionals.length > 0);
  if ((values["check-automation"] && values.automation === undefined)
    || (values.automation !== undefined && (!values.automation.trim() || hasSelection || values["fork-session"] || values["no-session-persistence"]))) {
    throw new HarnessError("USAGE", "Automation requires a configuration path and fresh persistent sessions; --check-automation requires --automation.");
  }
  if ((hasSelection || values["fork-session"] || values["no-session-persistence"]) && !hasTask) {
    throw new HarnessError("USAGE", "Session selection options require a prompt, --chat, --tui, or --webui.");
  }
  if ((values.continue && values.resume !== undefined) || (values["fork-session"] && !values.continue && values.resume === undefined)
    || (values["no-session-persistence"] && (values.continue || values.resume !== undefined || values["fork-session"]))
    || (values.name !== undefined && !values.name.trim())) {
    throw new HarnessError("USAGE", "Choose --continue or --resume; --fork-session requires one. Resume/fork requires persistence and names must be non-empty.");
  }
  if (values.project !== undefined && (!values.project.trim() || values.continue || values.resume !== undefined || values["no-session-persistence"])) {
    throw new HarnessError("USAGE", "Use --project with a non-empty ID or name and persistence, without --continue or --resume.");
  }
  if (values["web-permission"] !== undefined && (!hasTask || !["allow", "deny"].includes(values["web-permission"]))) {
    throw new HarnessError("USAGE", "Use --web-permission allow or deny with a prompt, --chat, --tui, or --webui.");
  }
  if (values.permission !== undefined && (!hasTask
    || !["ask", "read-only", "workspace-write"].includes(values.permission))) {
    throw new HarnessError("USAGE", "Use --permission ask, read-only, or workspace-write with a prompt, --chat, --tui, or --webui.");
  }
  if (values["shell-permission"] !== undefined && (!hasTask
    || !["ask", "deny", "allow"].includes(values["shell-permission"])
    || (values.permission === "read-only" && values["shell-permission"] !== "deny"))) {
    throw new HarnessError("USAGE", "Use --shell-permission ask, deny, or allow with a workspace task; read-only permits only deny.");
  }
  if (values["permission-mode"] !== undefined && (!hasTask || !isPermissionMode(values["permission-mode"])
    || values.permission !== undefined || values["shell-permission"] !== undefined)) {
    throw new HarnessError("USAGE", "Use --permission-mode default, acceptEdits, plan, or freeToGo with a task, without --permission or --shell-permission.");
  }
  if (values["permission-mode"] === "freeToGo" && values["web-permission"] === "deny") {
    throw new HarnessError("USAGE", "Free to go cannot be combined with --web-permission deny.");
  }
  return { values, positionals };
}

/** Node parseArgs requires a value for string options; normalize the optional picker form. */
function optionalResumeArgs(args: string[]): string[] {
  let positional = false;
  return args.map((argument, index) => {
    if (argument === "--") positional = true;
    return !positional && (argument === "--resume" || argument === "-r")
      && (args[index + 1] === undefined || args[index + 1]!.startsWith("-")) ? "--resume=" : argument;
  });
}
