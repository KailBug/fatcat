import { parseArgs } from "node:util";
import { createTerminalInput } from "./terminal.js";
import type { TerminalInput } from "./terminal.js";
import type { ShellPermission } from "./tools/shell.js";
import type { WorkspacePermission } from "./tools/write.js";
import type { WebPermission } from "./tools/web.js";
import { runChat } from "./chat.js";
import { Session } from "./session.js";
import { loadConfig } from "./config.js";
import { HarnessError, formatError } from "./errors.js";
import { runAgent } from "./loop.js";
import { createTurnReporter } from "./execution-report.js";
import { createAgent } from "./agent.js";
import { createTools } from "./tools.js";
import { discoverSkills } from "./skills.js";
import type { SkillCatalog } from "./skills.js";

const help = `Fatcat - minimal Agent Harness

Usage:
  pnpm start --help
  pnpm start --checkConfig
  pnpm start --listSkills
  pnpm start --chat
  pnpm start --tui
  pnpm start --webui
  pnpm start --chat --workspace examples/workspace
  pnpm start "Use the sum tool to add 17 and 25."
  pnpm start --prompt "Explain what an agent loop does."

Use --chat for a continuous conversation with /help, /reset, and /exit.
Use --tui for the interactive dashboard with conversation, configuration, usage, and cache telemetry.
Use --webui for the local browser interface at 127.0.0.1:3210; --port <1-65535> selects another port.
Open the private link printed at startup. Web UI write and command approvals appear in the browser.
A prompt runs one task. History stays in memory.
The agent can delegate focused independent tasks when useful; simple tasks stay direct.
At most two child tasks may start per user turn (up to six additional model requests).
Each child uses at most three additional model requests and cannot delegate.
Tasks use the current directory as the workspace and expose read, write, and shell.
Use --workspace <directory> to select another directory. Writes and commands ask for approval in the active interface.
Built-in skills are available by default; workspace and user .fatcat/skills or .agents/skills override matching names.
Use --listSkills to inspect the local catalog without credentials. Mention $name or describe a task to use a skill.
Skill instructions and bundled resources are loaded on demand through read; scripts still need shell authorization.
Use --permission read-only to forbid writes and commands, or workspace-write to preauthorize file writes.
Shell authorization is separate: --shell-permission ask (default), deny, or allow for unattended commands.
Shell uses Windows PowerShell with current-user access, not an operating-system sandbox.
Public web search and page reading are available by default, including in read-only workspaces.
Use --web-permission deny to disable the web tool (allow is the default). This is not a network sandbox for shell.
Search queries go to Bing (default) or DuckDuckGo; fetched URLs go to their hosts. Do not include secrets in either.
Each task emits an execution_report with request sizes, reported token usage, writes and command outcomes, even on failure.
HARNESS_MAX_REQUEST_BYTES limits each complete model request body (default 262144 bytes); older read outputs may be replaced by explicit markers to fit.
Current and recent turns, user instructions, and execution facts are preserved; full history remains in memory.
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
        args,
        options: {
          help: { type: "boolean", short: "h" },
          checkConfig: { type: "boolean" },
          listSkills: { type: "boolean" },
          prompt: { type: "string" },
          chat: { type: "boolean" },
          tui: { type: "boolean" },
          webui: { type: "boolean" },
          port: { type: "string" },
          workspace: { type: "string" },
          permission: { type: "string" },
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
    const modes = Number(Boolean(values.help))
      + Number(Boolean(values.checkConfig))
      + Number(Boolean(values.listSkills))
      + Number(Boolean(values.chat))
      + Number(Boolean(values.tui))
      + Number(Boolean(values.webui))
      + Number(values.prompt !== undefined || positionals.length > 0);

    //start parsing if
    if (modes > 1 || (values.prompt !== undefined && positionals.length > 0)) {
      throw new HarnessError("USAGE", "Choose one mode: help, config check, skill listing, chat, TUI, Web UI, or one prompt.");
    }
    if (values.workspace !== undefined && (!values.workspace.trim() || values.help || values.checkConfig
      || (!values.chat && !values.tui && !values.webui && !values.listSkills && values.prompt === undefined && positionals.length === 0))) {
      throw new HarnessError("USAGE", "Use --workspace with a prompt, --chat, --tui, --webui, or --listSkills and a non-empty directory.");
    }
    if (values.port !== undefined && (!values.webui || !/^[1-9]\d*$/.test(values.port) || Number(values.port) > 65535)) {
      throw new HarnessError("USAGE", "Use --port with --webui and an integer from 1 to 65535.");
    }
    const hasTask = Boolean(values.chat || values.tui || values.webui || values.prompt !== undefined || positionals.length > 0);
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
    if (values.help || args.length === 0) {
      console.log(help);
      return 0;
    }
    if (values.listSkills) {
      const tools = await createTools(values.workspace ?? process.cwd());
      const skills = await discoverSkills({ workspace: tools.workspaceRoot! });
      reportSkillWarnings(skills);
      console.log(JSON.stringify({ skills: skills.skills }, null, 2));
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
    if (!values.chat && !values.tui && !values.webui && !prompt.trim()) throw new HarnessError("USAGE", "The prompt must not be empty.");
    if (values.tui && (!process.stdin.isTTY || !process.stdout.isTTY || process.env.TERM === "dumb")) {
      throw new HarnessError("USAGE", "TUI requires an interactive terminal. Use --chat for pipes or TERM=dumb.");
    }

    //start config
    const config = loadConfig();
    const workspace = values.workspace ?? process.cwd();
    const permission = (values.permission ?? "ask") as WorkspacePermission;
    const shellPermission = (values["shell-permission"] ?? (permission === "read-only" ? "deny" : "ask")) as ShellPermission;
    const webPermission = (values["web-permission"] ?? "allow") as WebPermission;
    if (values.webui) {
      const { runWebUi } = await import("../webui/index.js");
      return await runWebUi(config, workspace, permission, shellPermission, webPermission, Number(values.port ?? "3210"));
    }
    if (values.tui) {
      const { runTui } = await import("../tui/index.js");
      return await runTui(config, workspace, permission, shellPermission, webPermission);
    }
    process.on("SIGINT", cancel);
    if (values.chat || permission === "ask" || shellPermission === "ask") {
      terminal = createTerminalInput(process.stdin, process.stderr, controller.signal);
    }
    const signal = terminal?.signal ?? controller.signal;
    const baseTools = await createTools(workspace, permission, terminal?.approveWrite, {
      permission: shellPermission,
      ...(terminal ? { approve: terminal.approveShell } : {}),
    }, { permission: webPermission });
    const skills = await discoverSkills({ workspace: baseTools.workspaceRoot!, signal });
    reportSkillWarnings(skills);
    const agent = createAgent(config, baseTools, undefined, skills);
    if (values.chat) {
      return await runChat(new Session(agent), {
        input: process.stdin, output: process.stdout, error: process.stderr, signal, terminal: terminal!,
      });
    }
    const answer = await runAgent(prompt, {
      ...agent,
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

function reportSkillWarnings(catalog: SkillCatalog): void {
  for (const message of catalog.warnings) console.error(JSON.stringify({ type: "skill_warning", message }));
}

process.exitCode = await main(process.argv.slice(2));
