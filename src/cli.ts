import { parseArgs } from "node:util";
import { VERSION } from "./version.js";
import { createTerminalInput } from "./terminal.js";
import type { TerminalInput } from "./terminal.js";
import type { ShellPermission } from "./tools/shell.js";
import type { WorkspacePermission } from "./tools/write.js";
import type { WebPermission } from "./tools/web.js";
import { runChat } from "./chat.js";
import { SessionManager } from "./session/manager.js";
import { SessionStore } from "./session/store.js";
import { formatSessionList } from "./session/commands.js";
import { loadConfig } from "./config.js";
import { HarnessError, formatError } from "./errors.js";
import { createTurnReporter } from "./execution-report.js";
import { workspaceAgentFactory } from "./workspace-agent.js";
import { createTools } from "./tools.js";
import type { SkillCatalog } from "./skills.js";
import { PermissionPolicy, isPermissionMode } from "./permissions/policy.js";
import { loadAutomationConfig } from "./automation/config.js";
import { FileChanges } from "./automation/files.js";
import { runAutomations } from "./automation/runner.js";

const help = `Fatcat - local coding assistant

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
  Before chatting, configure a provider key: docs/QUICK_START.md.
  HARNESS_PROVIDER: deepseek (default), kimi, mimo, qwen.
  FATCAT_SESSION_DIR: session store (default: ~/.fatcat/sessions).
  Read file/skill content is sent to the provider; saved history is local plaintext.
  Delegation: up to two child tasks per turn, three model requests each; no nesting.
  Task output: answer on stdout; logs and execution_report on stderr. Ctrl+C cancels.

  docs/REFERENCE/COMMANDS.md      Full syntax, combinations and conversation commands
  docs/REFERENCE/CONFIGURATION.md Provider settings, limits and environment variables
  docs/GUIDES/                    Session, project, skill and automation workflows`;

async function main(args: string[]): Promise<number> {
  let terminal: TerminalInput | undefined;
  const controller = new AbortController();
  const cancel = () => controller.abort();

  try {
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
    if (values.version) {
      console.log(VERSION);
      return 0;
    }
    if (values.help || args.length === 0) {
      console.log(help);
      return 0;
    }
    if (values.resume === "" && (!process.stdin.isTTY || !process.stderr.isTTY)) {
      const sessions = await new SessionStore().listAll();
      console.log(formatSessionList(sessions));
      return 0;
    }
    if (values.checkConfig) {
      const config = loadConfig();
      console.log("Local configuration is valid (no model provider was contacted).");
      console.log(`Provider: ${config.provider}`);
      console.log(`Region: ${config.region}`);
      console.log(`Model: ${config.model}`);
      console.log(`Maximum model iterations: ${config.maxIterations}`);
      console.log(`Request timeout: ${config.requestTimeoutMs} ms`);
      console.log(`Maximum request body: ${config.maxRequestBytes} bytes`);
      console.log("API key: configured (hidden)");
      return 0;
    }
    const prompt = values.prompt ?? positionals.join(" ");
    if (!values.chat && !values.tui && !values.webui && values.automation === undefined && !prompt.trim()) throw new HarnessError("USAGE", "The prompt must not be empty.");
    if (values.tui && (!process.stdin.isTTY || !process.stdout.isTTY || process.env.TERM === "dumb")) {
      throw new HarnessError("USAGE", "TUI requires an interactive terminal. Use --chat for pipes or TERM=dumb.");
    }

    const selection = {
      ...(values.continue ? { continue: true } : {}),
      ...(values.resume === undefined ? {} : { resume: values.resume }),
      ...(values["fork-session"] ? { fork: true } : {}),
      ...(values.name === undefined ? {} : { name: values.name }),
      ...(values.project === undefined ? {} : { project: values.project }),
    };
    if (values.resume === "") {
      process.on("SIGINT", cancel);
      terminal = createTerminalInput(process.stdin, process.stderr, controller.signal);
      const sessions = await new SessionStore().listAll();
      console.error(formatSessionList(sessions));
      if (!sessions.length) return 0;
      console.error("Enter a session ID or name to resume, or /exit to cancel.");
      terminal.prompt();
      const selector = await terminal.readTask();
      if (selector === undefined || selector.trim() === "/exit") return 0;
      if (!selector.trim()) throw new HarnessError("USAGE", "A session ID or name is required.");
      selection.resume = selector.trim();
      if (values.tui || values.webui) { terminal.close(); terminal = undefined; }
    }
    const sessionOptions = { selection, persistence: !values["no-session-persistence"], explicitWorkspace: values.workspace !== undefined };
    const workspace = values.workspace ?? process.cwd();
    const automation = values.automation === undefined ? undefined : await loadAutomationConfig(workspace, values.automation, controller.signal);
    if (automation) {
      await FileChanges.open(workspace, automation.config.tasks.flatMap((task) => task.trigger.type === "file_changed" ? task.trigger.paths : []), controller.signal);
      if (values["check-automation"]) {
        console.log("Automation configuration and watched paths are valid (no model provider was contacted).");
        console.log(JSON.stringify(automation.config));
        return 0;
      }
    }
    const config = loadConfig();
    const launchPermission = (values.permission ?? "ask") as WorkspacePermission;
    const launchShellPermission = (values["shell-permission"] ?? (launchPermission === "read-only" ? "deny" : "ask")) as ShellPermission;
    const permissionPolicy = new PermissionPolicy(isPermissionMode(values["permission-mode"])
      ? values["permission-mode"] : { permission: launchPermission, shellPermission: launchShellPermission },
    { readOnly: values.permission === "read-only", shellDenied: values["shell-permission"] === "deny",
      webDenied: values["web-permission"] === "deny" });
    const { permission, shellPermission } = permissionPolicy.snapshot();
    const webPermission = (values["web-permission"] ?? "allow") as WebPermission;
    if (values.webui) {
      const { runWebUi } = await import("../webui/index.js");
      return await runWebUi(config, workspace, permission, shellPermission, webPermission, Number(values.port ?? "3210"), sessionOptions, undefined, permissionPolicy);
    }
    if (values.tui) {
      const { runTui } = await import("../tui/index.js");
      return await runTui(config, workspace, permission, shellPermission, webPermission, sessionOptions, permissionPolicy);
    }
    if (!terminal) process.on("SIGINT", cancel);
    if (!terminal && (values.chat || permission === "ask" || shellPermission === "ask" || permissionPolicy.snapshot().mode === "freeToGo")) {
      terminal = createTerminalInput(process.stdin, process.stderr, controller.signal);
    }
    const signal = terminal?.signal ?? controller.signal;
    const agentForWorkspace = workspaceAgentFactory(config, (root) => createTools(root, permission, terminal?.approveWrite, {
      permission: shellPermission,
      ...(terminal ? { approve: terminal.approveShell } : {}),
    }, { permission: webPermission }, permissionPolicy, terminal ? { approve: terminal.approveBrowser } : {}));
    const agent = await agentForWorkspace(workspace);
    const skills = agent.skills;
    reportSkillWarnings(skills);
    if (automation) {
      await runAutomations(automation.config, agent, { workspace: agent.tools.workspaceRoot!, signal,
        emit: (event) => (event.type === "automation_finished" ? console.log : console.error)(JSON.stringify(event)) });
      return 0;
    }
    const session = await SessionManager.open(agent, { ...sessionOptions, workspace: agent.tools.workspaceRoot!, agentForWorkspace });
    if (values.chat) {
      return await runChat(session, {
        input: process.stdin, output: process.stdout, error: process.stderr, signal, terminal: terminal!, skills: skills.skills,
      });
    }
    const answer = await session.run(prompt, {
      signal,
      onEvent: createTurnReporter((event) => console.error(JSON.stringify(event))),
    });
    console.log(answer);
    return 0;
  } catch (error) {
    const known = error instanceof HarnessError;
    console.error(formatError(error));
    if (known && error.code === "USAGE") return 2;
    if (known && error.code === "CANCELLED") return 130;
    return 1;
  } finally {
    terminal?.close();
    process.off("SIGINT", cancel);
  }
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

function reportSkillWarnings(catalog: SkillCatalog): void {
  for (const message of catalog.warnings) console.error(JSON.stringify({ type: "skill_warning", message }));
}

process.exitCode = await main(process.argv.slice(2));
