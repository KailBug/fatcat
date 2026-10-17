import type { Config } from "@fatcat/runtime/config";
import { SessionManager } from "@fatcat/runtime/session/manager";
import type { SessionOpenOptions } from "@fatcat/runtime/session/manager";
import { createTools } from "@fatcat/runtime/tools";
import type { ShellPermission } from "@fatcat/runtime/tools/shell";
import type { WorkspacePermission } from "@fatcat/runtime/tools/write";
import type { WebPermission } from "@fatcat/runtime/tools/web";
import { WebUiController } from "./controller.js";
import { openWebUiBrowser } from "./open-browser.js";
import { startWebUiServer } from "./server.js";
import { PermissionPolicy } from "@fatcat/runtime/permissions/policy";
import { workspaceAgentFactory } from "@fatcat/runtime/agent";

export async function runWebUi(config: Config, workspace: string, permission: WorkspacePermission,
  shellPermission: ShellPermission, webPermission: WebPermission, port: number,
  sessionOptions: Omit<SessionOpenOptions, "workspace"> = {},
  openBrowser: (url: string, signal: AbortSignal) => Promise<void> = (url, signal) => openWebUiBrowser(url, { signal }),
  permissionPolicy = new PermissionPolicy({ permission, shellPermission },
    { readOnly: permission === "read-only", shellDenied: shellPermission === "deny", webDenied: webPermission === "deny" })): Promise<number> {
  const agentForWorkspace = workspaceAgentFactory(config, (root) => createTools(root, permission, (request, signal) => controller.requestApproval("write", request, signal), {
    permission: shellPermission, approve: (request, signal) => controller.requestApproval("shell", request, signal),
  }, { permission: webPermission }, permissionPolicy, { approve: (request, signal) => controller.requestApproval("browser", request, signal) }));
  const agent = await agentForWorkspace(workspace);
  const manager = await SessionManager.open(agent, {
    ...sessionOptions, workspace: agent.tools.workspaceRoot!, deferEmptySessions: true, agentForWorkspace,
  });
  const skills = manager.skills!;
  const controller = await WebUiController.create({
    provider: config.provider, model: config.model, workspace: manager.current.workspace,
    permission, shellPermission, webPermission, maxIterations: config.maxIterations,
    maxRequestBytes: config.maxRequestBytes, skills: skills.skills.length, warnings: [...skills.warnings],
  }, manager, permissionPolicy);
  const server = await startWebUiServer(controller, port);
  const browserOpening = new AbortController();
  let closing = false;
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => {
    stop = () => { closing = true; resolve(); };
  });
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    console.log(`Fatcat Web UI: ${server.url}`);
    console.log("The browser opens automatically. If it does not, use the private link above. Press Ctrl+C to stop the server.");
    void Promise.resolve().then(() => openBrowser(server.url, browserOpening.signal)).catch(() => {
      if (!closing) console.warn("Could not open the default browser. Use the private local link printed above.");
    });
    await stopped;
    return 0;
  } finally {
    closing = true;
    browserOpening.abort();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    await server.close();
  }
}
