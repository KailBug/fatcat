import { attachmentCommandHelp, runAttachmentCommand } from "./attachments/commands.js";
import { projectCommandHelp, runProjectCommand } from "./project/commands.js";
import { automationCommandHelp, runAutomationCommand } from "./automation/commands.js";
import { quoted } from "./utils/command.js";
import { HarnessError } from "@fatcat/runtime/errors";
import { runSessionCommand, sessionCommandHelp } from "./session/commands.js";
import type { Conversation } from "./session/commands.js";
import type { SkillDescriptor } from "@fatcat/runtime/skills";
import { SessionManager } from "@fatcat/runtime/session/manager";
import { contextCommandHelp, runContextCommand } from "./context/commands.js";
import type { CompactionOptions } from "@fatcat/runtime/context/compaction";
import { memoryCommandHelp, runMemoryCommand } from "./memory/commands.js";

export const interactiveCommandHelp = `${automationCommandHelp} /skills: list available skills; ${contextCommandHelp} ${memoryCommandHelp} ${sessionCommandHelp} ${projectCommandHelp} ${attachmentCommandHelp}`;

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
	if (!match) {
		const project = await runProjectCommand(session, prompt);
		if (project) return project;
		const attachment = await runAttachmentCommand(session, prompt, options);
		if (attachment) return attachment;
		return runSessionCommand(session, prompt);
	}
	if (match[1]?.trim()) throw new HarnessError("USAGE", "/skills does not take an argument.");
	if (session instanceof SessionManager && session.skills) skills = session.skills.skills;
	return {
		text: skills.length ? skills.map((skill) => `$${skill.name} [${skill.scope}] | `
			+ `${quoted(skill.description)} | ${quoted(skill.uri)}`).join("\n") : "No skills available for this workspace.",
		switched: false,
	};
}
