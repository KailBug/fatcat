import type { Config } from "./config.js";
import { createModel } from "./model.js";
import type { Model } from "./model.js";
import { createSubagentTools } from "./subagent.js";
import { defaultTools } from "./tools.js";
import type { Tools } from "./tools.js";
import { skillCatalogPrompt, withSkills } from "./skills.js";
import type { SkillCatalog } from "./skills.js";

const delegationPolicy = "For straightforward questions, arithmetic, or one direct file operation, work directly. "
  + "When the task asks for independent reviews or investigations of separate components, prefer delegate_task for focused independent parts, then synthesize their findings. "
  + "Give each child concrete paths, all necessary context, and an expected result that fits its small budget. "
  + "Children are sequential, cannot see your conversation, and have no extra permissions. "
  + "Do not delegate merely to repeat work already completed, and do not present child claims as verified facts without supporting tool evidence.";

/** Assemble the CLI agent and its bounded child using the same authorized tools. */
export function createAgent(config: Config, baseTools: Tools = defaultTools, transport?: typeof fetch,
  skills?: SkillCatalog) {
  const sharedTools = skills ? withSkills(baseTools, skills) : baseTools;
  const skillGuidance = skills ? skillCatalogPrompt(skills) : "";
  const childModel = withGuidance(createModel(config, transport, sharedTools), skillGuidance);
  const tools = createSubagentTools(sharedTools, childModel, config.maxIterations);
  const model = withGuidance(createModel(config, transport, tools),
    [delegationPolicy, skillGuidance].filter(Boolean).join("\n\n"));
  return { tools, model, maxIterations: config.maxIterations };
}

function withGuidance(model: Model, guidance: string): Model {
  if (!guidance) return model;
  return (messages, signal, observe) => {
    // Request-only guidance leaves Session history and independent child history untouched.
    const first = messages[0];
    const system = first?.role === "system" && typeof first.content === "string";
    return model(system
      ? [{ ...first, content: `${first.content}\n\n${guidance}` }, ...messages.slice(1)]
      : [{ role: "system", content: guidance }, ...messages], signal, observe);
  };
}
