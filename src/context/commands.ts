import type { Conversation } from "../session/commands.js";
import type { CompactionOptions } from "./compaction.js";
import type { ContextStatus } from "./manager.js";
import { HarnessError } from "../errors.js";

export const contextCommandHelp = "/context: inspect conversation bytes; /compact [instructions]: summarize older turns with bounded model requests.";

export function isContextCommand(prompt: string): boolean {
	return /^\/(context|compact)(?:\s|$)/.test(prompt);
}

function formatContext(context: ContextStatus): string {
	return `Full history: ${context.historyMessages} messages, ${context.historyBytes} bytes. `
		+ `Model conversation: ${context.projectedMessages} messages, ${context.projectedBytes} bytes. `
		+ `Summarized messages: ${context.summarizedMessages}. `
		+ "These are conversation JSON bytes, not tokens or the full request size; tools, current guidance and execution records add to the request.";
}

/** Share context operations across hosts without inserting commands into model history. */
export async function runContextCommand(session: Conversation, prompt: string,
	options: CompactionOptions = {}): Promise<{ text: string; switched: boolean } | undefined> {
	const match = /^\/(context|compact)(?:\s+([\s\S]*))?$/.exec(prompt);
	if (!match) return;
	const instructions = match[2]?.trim() ?? "";
	if (match[1] === "context") {
		if (instructions) throw new HarnessError("USAGE", "/context does not take an argument.");
		return { text: formatContext(session.context), switched: false };
	}
	const result = await session.compact({ ...options, instructions });
	return {
		text: `Context compacted using ${result.requests} summary request(s). Full history and the latest complete turn were retained. ${formatContext(result)}`,
		switched: false,
	};
}
