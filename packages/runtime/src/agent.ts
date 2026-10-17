import { delegationPolicy, automationGuidance, browserGuidance, attachmentGuidance, workspaceGuidance, permissionGuidance } from "./system-prompt.js";
import type { Config } from "./config.js";
import { createModel } from "./model.js";
import type { Model } from "./model.js";
import { createSubagentTools } from "./subagent.js";
import { defaultTools } from "./tools.js";
import type { Tools } from "./tools.js";
import { discoverSkills, skillCatalogPrompt, withSkills } from "./skills.js";
import type { SkillCatalog } from "./skills.js";
import { withAutomationTool } from "./automation/tool.js";
import { canonicalWorkspace } from "./session/store.js";
import { withSessionIdentity } from "./session/execution.js";
import type { SessionExecutionIdentity } from "./session/execution.js";
import type { SessionAgentOptions } from "./session/agent-session.js";
import { withAttachments } from "./attachments/tools.js";
import type { AttachmentAccess } from "./attachments/tools.js";
import { createDocumentVision } from "./documents/vision.js";
import { withMemories, withMemoryContext } from "./memory/tools.js";
import type { MemoryAccess } from "./memory/tools.js";
import { withMemoryWriter } from "./memory/write.js";

/** Assemble shared tools, a bounded child, and parent-only capabilities for every host. */
export function createAgent(config: Config, baseTools: Tools = defaultTools, transport?: typeof fetch,
  skills?: SkillCatalog, identity?: SessionExecutionIdentity, attachments?: AttachmentAccess, memory?: MemoryAccess) {
  const attachmentTools = attachments ? withAttachments(baseTools, attachments, createDocumentVision(config, transport)) : baseTools;
  const fileTools = memory ? withMemories(attachmentTools, memory) : attachmentTools;
  const sharedTools = skills ? withSkills(fileTools, skills) : fileTools;
  const skillGuidance = skills ? skillCatalogPrompt(skills) : "";
  const sharedGuidance = () => sharedAgentGuidance(sharedTools, skillGuidance, attachments);
  const bind = (model: Model) => bindSessionModel(model, identity, memory);
  const childModel = bind(withGuidance(createModel(config, transport, sharedTools), sharedGuidance));
  const parentTools = withAutomationTool(createSubagentTools(sharedTools, childModel, config.maxIterations));
  const tools = memory ? withMemoryWriter(parentTools) : parentTools;
  const model = bind(withGuidance(createModel(config, transport, tools),
    () => [delegationPolicy, sharedGuidance(), `Current local time: ${new Date().toString()}. ${automationGuidance}`].filter(Boolean).join("\n\n")));
  return { tools, model, maxIterations: config.maxIterations,
    // Rebind generated components while preserving caller-supplied tools and models.
    forSession: (scope: SessionExecutionIdentity, current: SessionAgentOptions, access?: AttachmentAccess, memories?: MemoryAccess): SessionAgentOptions => {
      const bound = createAgent(config, baseTools, transport, skills, scope, access, memories);
      return { ...current,
        ...(current.tools === tools ? { tools: bound.tools } : {}),
        model: current.model === model ? bound.model : bindSessionModel(current.model, scope, memories) };
    },
    autoCompaction: config.autoCompaction ?? true,
    compactionModel: createModel(config, transport), maxRequestBytes: config.maxRequestBytes };
}

/** Retain execution journals per workspace while refreshing its skill catalog on selection. */
export function workspaceAgentFactory(config: Config, buildTools: (workspace: string) => Promise<Tools>, transport?: typeof fetch) {
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
    return { ...createAgent(config, tools, transport, skills), skills };
  };
}

function bindSessionModel(model: Model, identity?: SessionExecutionIdentity, memory?: MemoryAccess): Model {
  const scoped = identity ? withSessionIdentity(model, identity) : model;
  return memory ? withMemoryContext(scoped, memory) : scoped;
}

/** Permission state is read for each request; guidance never enters stored history. */
function sharedAgentGuidance(tools: Tools, skillGuidance: string, attachments?: AttachmentAccess): string {
  const permissions = tools.getPermissionState?.();
  return [
    workspaceGuidance(tools.workspaceRoot, permissions),
    skillGuidance,
    permissionGuidance(permissions),
    tools.definitions.some((tool) => tool.function.name === "browser") ? browserGuidance : "",
    attachments ? attachmentGuidance : "",
  ].filter(Boolean).join("\n\n");
}

function withGuidance(model: Model, guidance: string | (() => string)): Model {
  if (!guidance) return model;
  return (messages, signal, observe, options) => {
    const currentGuidance = typeof guidance === "function" ? guidance() : guidance;
    if (!currentGuidance) return model(messages, signal, observe, options);
    // Request-only guidance leaves Session history and independent child history untouched.
    const first = messages[0];
    const system = first?.role === "system" && typeof first.content === "string";
    return model(system
      ? [{ ...first, content: `${first.content}\n\n${currentGuidance}` }, ...messages.slice(1)]
      : [{ role: "system", content: currentGuidance }, ...messages], signal, observe, options);
  };
}
