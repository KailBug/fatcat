import type { Config } from "../src/config.js";
import { SessionManager } from "../src/session/manager.js";
import { createTools } from "../src/tools.js";
import type { ShellPermission } from "../src/tools/shell.js";
import type { WorkspacePermission } from "../src/tools/write.js";
import type { WebPermission } from "../src/tools/web.js";
import { TuiApp } from "./app.js";
import type { PermissionPolicy } from "../src/permissions/policy.js";
import { workspaceAgentFactory } from "../src/workspace-agent.js";

/** Assemble the same agent and permissions as CLI chat; only the interaction changes. */
export async function runTui(config: Config, workspace: string | undefined,
  permission: WorkspacePermission, shellPermission: ShellPermission, webPermission: WebPermission = "allow",
  sessionOptions: Omit<Parameters<typeof SessionManager.open>[1], "workspace"> = {},
  permissionPolicy?: PermissionPolicy): Promise<number> {
  // Approval callbacks run only after the app and its session have been assembled.
  const agentForWorkspace = workspaceAgentFactory(config, (root) => createTools(root, permission, (request, signal) => app.approveWrite(request, signal), {
    permission: workspace === undefined ? "deny" : shellPermission,
    approve: (request, signal) => app.approveShell(request, signal),
  }, { permission: webPermission }, permissionPolicy, { approve: (request, signal) => app.approveBrowser(request, signal) }));
  const agent = await agentForWorkspace(workspace ?? process.cwd());
  const root = agent.tools.workspaceRoot;
  const skills = agent.skills;
  const app = new TuiApp({
    config: {
      provider: config.provider, region: config.region, model: config.model,
      maxIterations: config.maxIterations, requestTimeoutMs: config.requestTimeoutMs,
      maxRequestBytes: config.maxRequestBytes,
    },
    workspace: root, permission, shellPermission: root === undefined ? "deny" : shellPermission,
    skills: skills.skills.length, skillCatalog: skills.skills, warnings: skills.warnings, webPermission,
  });
  const session = await SessionManager.open(agent, {
    ...sessionOptions, workspace: root ?? process.cwd(), agentForWorkspace,
  });
  return app.run(session);
}
