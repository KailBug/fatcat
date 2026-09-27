import { realpath, stat } from "node:fs/promises";
import { createAgent } from "../agent.js";
import type { Config } from "../config.js";
import { Session } from "../session.js";
import { HarnessError } from "../errors.js";
import { discoverSkills } from "../skills.js";
import { createTools } from "../tools.js";
import type { ShellPermission } from "../tools/shell.js";
import type { WorkspacePermission } from "../tools/write.js";
import { TuiApp } from "./app.js";

/** Assemble the same agent and permissions as CLI chat; only the interaction changes. */
export async function runTui(config: Config, workspace: string | undefined,
  permission: WorkspacePermission, shellPermission: ShellPermission): Promise<number> {
  let root: string | undefined;
  if (workspace !== undefined) {
    try {
      root = await realpath(workspace);
      if (!(await stat(root)).isDirectory()) throw new Error();
    } catch {
      throw new HarnessError("CONFIG", "Workspace must be an existing accessible directory.");
    }
  }
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
  const tools = await createTools(root, permission, app.approveWrite, {
    permission: root === undefined ? "deny" : shellPermission, approve: app.approveShell,
  });
  return app.run(new Session(createAgent(config, tools, undefined, skills)));
}
