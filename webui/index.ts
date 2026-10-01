import { createAgent } from "../src/agent.js";
import type { Config } from "../src/config.js";
import { SessionManager } from "../src/session/manager.js";
import type { SessionOpenOptions } from "../src/session/manager.js";
import { discoverSkills } from "../src/skills.js";
import { createTools } from "../src/tools.js";
import type { ShellPermission } from "../src/tools/shell.js";
import type { WorkspacePermission } from "../src/tools/write.js";
import type { WebPermission } from "../src/tools/web.js";
import { WebUiController } from "./controller.js";
import { startWebUiServer } from "./server.js";

export async function runWebUi(config: Config, workspace: string, permission: WorkspacePermission,
  shellPermission: ShellPermission, webPermission: WebPermission, port: number,
  sessionOptions: Omit<SessionOpenOptions, "workspace"> = {}): Promise<number> {
  const tools = await createTools(workspace, permission, (request, signal) => controller.requestApproval("write", request, signal), {
    permission: shellPermission, approve: (request, signal) => controller.requestApproval("shell", request, signal),
  }, { permission: webPermission });
  const skills = await discoverSkills({ workspace: tools.workspaceRoot! });
  const manager = await SessionManager.open(createAgent(config, tools, undefined, skills), {
    ...sessionOptions, workspace: tools.workspaceRoot!,
  });
  const controller = await WebUiController.create({
    provider: config.provider, model: config.model, workspace: tools.workspaceRoot!,
    permission, shellPermission, webPermission, maxIterations: config.maxIterations,
    maxRequestBytes: config.maxRequestBytes, skills: skills.skills.length, warnings: [...skills.warnings],
  }, manager);
  const server = await startWebUiServer(controller, port);
  console.log(`Fatcat Web UI: ${server.url}`);
  console.log("Open this private local link in your browser. Press Ctrl+C to stop the server.");
  await new Promise<void>((resolve) => {
    const stop = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  await server.close();
  return 0;
}
