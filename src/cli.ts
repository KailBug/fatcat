import { parseArgs } from "node:util";
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

const help = `Fatcat - minimal Agent Harness

Usage:
  pnpm start --help
  pnpm start --checkConfig
  pnpm start --chat
  pnpm start --continue
  pnpm start --resume <id-or-name>
  pnpm start --tui
  pnpm start --webui
  pnpm start --chat --workspace examples/workspace
  pnpm start "Use the sum tool to add 17 and 25."
  pnpm start --prompt "Explain what an agent loop does."

Use --chat for a continuous conversation with /help, /cron, /skills, /new, /sessions, /resume, /rename, /fork, and /exit.
Use --tui for the interactive dashboard with conversation, configuration, usage, and cache telemetry.
Use --webui for the local browser interface at 127.0.0.1:3210; --port <1-65535> selects another port.

The default browser opens automatically. Web UI write and command approvals appear in the browser.
Describe scheduled or file-change tasks in a conversation, use /cron in chat/TUI, or open Cron tasks in Web UI.
The automation tool binds tasks to that session; later runs continue its history with current permissions.
Keep chat/TUI/Web UI open for tasks to run. Saved task counts persist; offline occurrences are not replayed.

Advanced standalone JSON runner (separate from session-bound tasks):
  pnpm start --automation automation.example.json --check-automation
  pnpm start --automation automation.example.json
The first command only validates configuration and watched paths, without model credentials.
The second starts a runner that creates a fresh saved session per activation under current permissions.
Its queues and run counts are process-local, defaulting to 20 total attempts and 24 hours. Ctrl+C stops it.

A prompt runs one task. Successful history is saved locally for the selected workspace.
Use --continue (-c) to continue the latest session, or --resume (-r) <id-or-name> to select one.
Bare --resume shows a session picker in a terminal or a local list for pipes, without model credentials.
Use --name (-n) <name> to name a session; --fork-session with --continue or --resume copies history into a new session.
Use /sessions in chat or TUI to list all saved sessions; --no-session-persistence keeps a new session in memory.
Session storage defaults to ~/.fatcat/sessions; FATCAT_SESSION_DIR selects another local store.
Restored sessions use their saved workspace with the current launch's provider and permission settings.
Use /workspace <path> in chat or TUI, or click the Web UI workspace path, to change the session workspace.
The agent can delegate focused independent tasks when useful; simple tasks stay direct.
At most two child tasks may start per user turn (up to six additional model requests).
Each child uses at most three additional model requests and cannot delegate.
Tasks use the current directory as the workspace and expose read, write, and shell.
Use --workspace <directory> to select another directory. Writes and commands ask for approval in the active interface.

Built-in skills are available by default; workspace and user .fatcat/skills or .agents/skills override matching names.
Use /skills in chat or TUI to inspect the local catalog. Mention $name or describe a task to use a skill.
Skill instructions and bundled resources are loaded on demand through read; scripts still need shell authorization.

Use --permission read-only to forbid writes and commands, or workspace-write to preauthorize file writes.
Use --permission-mode default (Manual), acceptEdits (automatic file edits), plan (read-only planning), or freeToGo (Free to go).
Free to go allows local files and HTTP(S) networks beyond the workspace/public boundary; ordinary commands run automatically.
Clearly dangerous commands and opaque shell forms still require approval. This command check is not an OS sandbox.
Permission modes replace --permission and --shell-permission; the Web UI can switch modes while idle.
Shell authorization is separate: --shell-permission ask (default), deny, or allow for unattended commands.
Shell uses Windows PowerShell with current-user access, not an operating-system sandbox.
Public web search and page reading are available by default, including in read-only workspaces.
Use --web-permission deny to disable the web tool (allow is the default). This is not a network sandbox for shell.
Search queries go to Bing (default) or DuckDuckGo; fetched URLs go to their hosts. Do not include secrets in either.
Each task emits an execution_report with request sizes, reported token usage, writes and command outcomes, even on failure.

HARNESS_MAX_REQUEST_BYTES limits each complete model request body (default 262144 bytes); older read outputs may be replaced by explicit markers to fit.
Current and recent turns, user instructions, and execution facts are preserved; full successful history is saved locally.
An answer or a zero exit code alone does not certify the task; inspect the recorded evidence.

HARNESS_PROVIDER selects deepseek (default), kimi, mimo, or qwen for the entire session.
Selected file and skill contents are sent to the configured provider when the model reads them.
Configuration checks are local and do not validate credentials or connectivity.

In CLI task mode, logs go to stderr and the final answer goes to stdout. Press Ctrl+C to cancel.`;

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
          checkConfig: { type: "boolean" },
          continue: { type: "boolean", short: "c" },
          resume: { type: "string", short: "r" },
          name: { type: "string", short: "n" },
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
    const hasSelection = Boolean(values.continue || values.resume !== undefined || values.name !== undefined);
    if (hasSelection && !values.help && !values.checkConfig
      && !values.tui && !values.webui && values.automation === undefined && values.prompt === undefined && positionals.length === 0) values.chat = true;

    const modes = Number(Boolean(values.help))
      + Number(Boolean(values.checkConfig))
      + Number(Boolean(values.chat))
      + Number(Boolean(values.tui))
      + Number(Boolean(values.webui))
      + Number(values.automation !== undefined)
      + Number(values.prompt !== undefined || positionals.length > 0);

    if (modes > 1 || (values.prompt !== undefined && positionals.length > 0)) {
      throw new HarnessError("USAGE", "Choose one mode: help, config check, chat, TUI, Web UI, automation, or one prompt.");
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
    const sessionOptions = { selection, persistence: !values["no-session-persistence"] };
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
