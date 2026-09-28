import { createAgent } from "../agent.js";
import type { Config } from "../config.js";
import { Session } from "../session.js";
import { discoverSkills } from "../skills.js";
import { createTools } from "../tools.js";
import type { ShellPermission } from "../tools/shell.js";
import type { WorkspacePermission } from "../tools/write.js";
import { TuiApp } from "./app.js";

/** Assemble the same agent and permissions as CLI chat; only the interaction changes. */
export async function runTui(config: Config, workspace: string | undefined,
  permission: WorkspacePermission, shellPermission: ShellPermission): Promise<number> {
  // Approval callbacks run only after the app and its session have been assembled.
  const tools = await createTools(workspace, permission, (request, signal) => app.approveWrite(request, signal), {
    permission: workspace === undefined ? "deny" : shellPermission,
    approve: (request, signal) => app.approveShell(request, signal),
  });
  const root = tools.workspaceRoot;
  const skills = await discoverSkills(root === undefined ? {} : { workspace: root });
  const app = new TuiApp({
    config: {
      provider: config.provider, region: config.region, model: config.model,
      maxIterations: config.maxIterations, requestTimeoutMs: config.requestTimeoutMs,
      maxRequestBytes: config.maxRequestBytes,
    },
    workspace: root, permission, shellPermission: root === undefined ? "deny" : shellPermission,
    skills: skills.skills.length, warnings: skills.warnings,
  });
  return app.run(new Session(createAgent(config, tools, undefined, skills)));
}
