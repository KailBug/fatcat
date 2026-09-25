import type { Config } from "./config.js";
import { createDeepSeekModel } from "./model.js";
import type { Model } from "./model.js";
import { createSubagentTools } from "./subagent.js";
import { defaultTools } from "./tools.js";
import type { Tools } from "./tools.js";

const delegationPolicy = "For straightforward questions, arithmetic, or one direct file operation, work directly. "
  + "When the task asks for independent reviews or investigations of separate components, prefer delegate_task for focused independent parts, then synthesize their findings. "
  + "Give each child concrete paths, all necessary context, and an expected result that fits its small budget. "
  + "Children are sequential, cannot see your conversation, and have no extra permissions. "
  + "Do not delegate merely to repeat work already completed, and do not present child claims as verified facts without supporting tool evidence.";

/** Assemble the CLI agent and its bounded child using the same authorized tools. */
export function createAgent(config: Config, baseTools: Tools = defaultTools, transport?: typeof fetch) {
  const childModel = createDeepSeekModel(config, transport, baseTools);
  const tools = createSubagentTools(baseTools, childModel, config.maxIterations);
  const parentModel = createDeepSeekModel(config, transport, tools);
  const model: Model = (messages, signal, observe) => {
    // Add parent-only guidance on a request copy; leave saved history and child prompts untouched.
    const first = messages[0];
    const system = first?.role === "system" && typeof first.content === "string";
    return parentModel(system
      ? [{ ...first, content: `${first.content}\n\n${delegationPolicy}` }, ...messages.slice(1)]
      : [{ role: "system", content: delegationPolicy }, ...messages], signal, observe);
  };
  return { tools, model, maxIterations: config.maxIterations };
}
