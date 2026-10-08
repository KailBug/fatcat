import { createAgent } from "./agent.js";
import type { Config } from "./config.js";
import { discoverSkills } from "./skills.js";
import type { Tools } from "./tools.js";
import { canonicalWorkspace } from "./session/store.js";

/** Retain execution journals per workspace while refreshing its skill catalog on selection. */
export function workspaceAgentFactory(config: Config, buildTools: (workspace: string) => Promise<Tools>) {
  const workspaces = new Map<string, Tools>();
  return async (workspace: string) => {
    const canonical = await canonicalWorkspace(workspace);
    const key = process.platform === "win32" ? canonical.toLowerCase() : canonical;
    let tools = workspaces.get(key);
    if (!tools) {
      tools = await buildTools(canonical);
      workspaces.set(key, tools);
    }
    const skills = await discoverSkills({ workspace: tools.workspaceRoot! });
    return { ...createAgent(config, tools, undefined, skills), skills };
  };
}
