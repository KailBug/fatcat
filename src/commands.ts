import { automationCommandHelp, runAutomationCommand } from "./automation/commands.js";
import { quoted } from "./utils/command.js";
import { HarnessError } from "./errors.js";
import { runSessionCommand, sessionCommandHelp } from "./session/commands.js";
import type { Conversation } from "./session/commands.js";
import type { SkillDescriptor } from "./skills.js";
import { SessionManager } from "./session/manager.js";
import { contextCommandHelp, runContextCommand } from "./context/commands.js";
import type { CompactionOptions } from "./context/compaction.js";
import { memoryCommandHelp, runMemoryCommand } from "./memory/commands.js";

export const interactiveCommandHelp = `${automationCommandHelp} /skills: list available skills; ${contextCommandHelp} ${memoryCommandHelp} ${sessionCommandHelp}`;

export { automationCommandPrompt } from "./automation/commands.js";

/** Dispatch host commands; only explicit compaction may request a model summary. */
export async function runInteractiveCommand(session: Conversation, prompt: string,
	skills: readonly SkillDescriptor[] = [], options: CompactionOptions = {}): Promise<{ text: string; switched: boolean } | undefined> {
	const memory = await runMemoryCommand(session, prompt, options);
	if (memory) return memory;
	const context = await runContextCommand(session, prompt, options);
	if (context) return context;
	const automation = await runAutomationCommand(session, prompt);
	if (automation) return automation;
	const match = /^\/skills(?:\s+([\s\S]*))?$/.exec(prompt);
	if (!match) return runSessionCommand(session, prompt, options);
	if (match[1]?.trim()) throw new HarnessError("USAGE", "/skills does not take an argument.");
	if (session instanceof SessionManager && session.skills) skills = session.skills.skills;
	return {
		text: skills.length ? skills.map((skill) => `$${skill.name} [${skill.scope}] | `
			+ `${quoted(skill.description)} | ${quoted(skill.uri)}`).join("\n") : "No skills available for this workspace.",
		switched: false,
	};
}
