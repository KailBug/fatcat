import { VERSION } from "../version.js";
import { createTerminalInput } from "../terminal.js";
import type { TerminalInput } from "../terminal.js";
import type { ShellPermission } from "@fatcat/runtime/tools/shell";
import type { WorkspacePermission } from "@fatcat/runtime/tools/write";
import type { WebPermission } from "@fatcat/runtime/tools/web";
import { runChat } from "../chat.js";
import { SessionManager } from "@fatcat/runtime/session/manager";
import { SessionStore } from "@fatcat/runtime/session/store";
import { formatSessionList } from "@fatcat/commands/session/labels";
import { loadConfig } from "@fatcat/runtime/config";
import { HarnessError, formatError } from "@fatcat/runtime/errors";
import { createTurnReporter } from "@fatcat/runtime/execution-report";
import { workspaceAgentFactory } from "@fatcat/runtime/agent";
import { createTools } from "@fatcat/runtime/tools";
import type { SkillCatalog } from "@fatcat/runtime/skills";
import { PermissionPolicy, isPermissionMode } from "@fatcat/runtime/permissions/policy";
import { loadAutomationConfig } from "@fatcat/runtime/automation/config";
import { FileChanges } from "@fatcat/runtime/automation/files";
import { runAutomations } from "@fatcat/runtime/automation/runner";
import { cliHelp, parseCliOptions } from "./options.js";

export async function runCli(args: string[]): Promise<number> {
  let terminal: TerminalInput | undefined;
  const controller = new AbortController();
  const cancel = () => controller.abort();

  try {
    const { values, positionals } = parseCliOptions(args);
    if (values.version) {
      console.log(VERSION);
      return 0;
    }
    if (values.help || args.length === 0) {
      console.log(cliHelp);
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
      const { runWebUi } = await import("@fatcat/webui");
      return await runWebUi(config, workspace, permission, shellPermission, webPermission, Number(values.port ?? "3210"), sessionOptions, undefined, permissionPolicy);
    }
    if (values.tui) {
      const { runTui } = await import("@fatcat/tui");
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

function reportSkillWarnings(catalog: SkillCatalog): void {
  for (const message of catalog.warnings) console.error(JSON.stringify({ type: "skill_warning", message }));
}
