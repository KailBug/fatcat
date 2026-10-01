import { createAgent } from "../src/agent.js";
import type { Config } from "../src/config.js";
import { SessionManager } from "../src/session/manager.js";
import { discoverSkills } from "../src/skills.js";
import { createTools } from "../src/tools.js";
import type { ShellPermission } from "../src/tools/shell.js";
import type { WorkspacePermission } from "../src/tools/write.js";
import type { WebPermission } from "../src/tools/web.js";
import { TuiApp } from "./app.js";
import type { PermissionPolicy } from "../src/permissions/policy.js";

/** Assemble the same agent and permissions as CLI chat; only the interaction changes. */
export async function runTui(config: Config, workspace: string | undefined,
  permission: WorkspacePermission, shellPermission: ShellPermission, webPermission: WebPermission = "allow",
  sessionOptions: Omit<Parameters<typeof SessionManager.open>[1], "workspace"> = {},
  permissionPolicy?: PermissionPolicy): Promise<number> {
  // Approval callbacks run only after the app and its session have been assembled.
  const tools = await createTools(workspace, permission, (request, signal) => app.approveWrite(request, signal), {
    permission: workspace === undefined ? "deny" : shellPermission,
    approve: (request, signal) => app.approveShell(request, signal),
  }, { permission: webPermission }, permissionPolicy);
  const root = tools.workspaceRoot;
  const skills = await discoverSkills(root === undefined ? {} : { workspace: root });
  const app = new TuiApp({
    config: {
      provider: config.provider, region: config.region, model: config.model,
      maxIterations: config.maxIterations, requestTimeoutMs: config.requestTimeoutMs,
      maxRequestBytes: config.maxRequestBytes,
    },
    workspace: root, permission, shellPermission: root === undefined ? "deny" : shellPermission,
    skills: skills.skills.length, skillCatalog: skills.skills, warnings: skills.warnings, webPermission,
  });
  const session = await SessionManager.open(createAgent(config, tools, undefined, skills), {
    ...sessionOptions, workspace: root ?? process.cwd(),
  });
  return app.run(session);
}
