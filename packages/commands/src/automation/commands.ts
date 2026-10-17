import { quoted } from "../utils/command.js";
import { HarnessError } from "@fatcat/runtime/errors";
import type { Conversation } from "../session/commands.js";
import { SessionManager } from "@fatcat/runtime/session/manager";

export const automationCommandHelp = "/cron [description]: create automation in this session; /cron list|pause <id>|resume <id>|delete <id>.";

export function automationCommandPrompt(prompt: string): string | undefined {
	const match = /^\/cron\s+([\s\S]+)$/.exec(prompt);
	const description = match?.[1]?.trim();
	if (!description || /^(?:list|pause|resume|delete)(?:\s|$)/.test(description)) return;
	return `Schedule in this conversation: ${description}`;
}

export async function runAutomationCommand(session: Conversation, prompt: string): Promise<{ text: string; switched: boolean } | undefined> {
	const automation = /^\/cron(?:\s+(list|pause|resume|delete)(?:\s+(\S+))?)?\s*$/.exec(prompt);
	if (!automation) return;
	if (!(session instanceof SessionManager)) throw new HarnessError("AUTOMATION_UNAVAILABLE", "Automation requires a saved session.");
	const action = automation[1] ?? "list";
	if (action === "list") {
		if (automation[2]) throw new HarnessError("USAGE", "/cron list takes no ID.");
		const tasks = (await session.listAutomations()).filter((task) => task.sessionId === session.current.id);
		return { text: tasks.length ? tasks.map((task) => `${task.id} | ${task.enabled ? "enabled" : "paused"} | ${task.runs}/${task.maxRuns} runs | ${JSON.stringify(task.trigger)} | ${quoted(task.prompt)}`).join("\n")
			: "No automation in this session. Use /cron followed by your task and schedule, for example: /cron every 5 minutes review src/cli.ts.", switched: false };
	}
	if (!automation[2]) throw new HarnessError("USAGE", `Use /cron ${action} <task-id>.`);
	await session.manageAutomation({ action, id: automation[2] });
	return { text: `Automation ${action} completed.`, switched: false };
}
