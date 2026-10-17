import { HarnessError, checkCancellation } from "@fatcat/runtime/errors";
import type { Conversation } from "../session/commands.js";
import { SessionManager } from "@fatcat/runtime/session/manager";
import { memoryIdPattern } from "@fatcat/runtime/memory/record";
import type { MemoryRecord } from "@fatcat/runtime/memory/record";

export const memoryCommandHelp = "/memory [list]: list current memories; /memory show <id>: show a memory and its revision history; "
	+ "/memory add session|project|global <text>: explicitly remember text in that scope; "
	+ "/memory update <id> <revision> <text>: replace the current revision; /memory delete <id> <revision>: delete it.";

function usage(): never {
	throw new HarnessError("USAGE", memoryCommandHelp);
}

function memoryLabel(record: MemoryRecord): string {
	return `memory:${record.id}@${record.revision} | ${record.scope.kind} | ${record.status}`
		+ (record.status === "active" ? ` | ${JSON.stringify(record.content)}` : "");
}

export function isMemoryCommand(prompt: string): boolean {
	return /^\/memory(?:\s|$)/.test(prompt);
}

/** Optional host commands manage the same records as conversation-driven Memory writes. */
export async function runMemoryCommand(session: Conversation, prompt: string, options: { signal?: AbortSignal } = {}): Promise<{
	text: string; switched: boolean;
} | undefined> {
	if (!isMemoryCommand(prompt)) return;
	checkCancellation(options.signal);
	if (!(session instanceof SessionManager)) throw new HarnessError("USAGE", "Memory management requires a managed conversation.");
	const argument = prompt.slice("/memory".length).trim();
	if (!argument || argument === "list") {
		const records = await session.listMemories(options.signal);
		checkCancellation(options.signal);
		return { text: records.length ? records.map(memoryLabel).join("\n")
			: "No memories in this session's scopes. " + memoryCommandHelp, switched: false };
	}
	const show = /^show\s+(\S+)$/.exec(argument);
	if (show) {
		if (!memoryIdPattern.test(show[1]!)) usage();
		const record = (await session.listMemories(options.signal)).find((item) => item.id === show[1]);
		checkCancellation(options.signal);
		if (!record) throw new HarnessError("MEMORY_NOT_FOUND", "That memory is not available in this session's scopes.");
		return { text: `${memoryLabel(record)}\nScope: ${JSON.stringify(record.scope)}\nRevision history (historical user data):\n`
			+ record.changes.map((change) => JSON.stringify(change)).join("\n"), switched: false };
	}
	const add = /^add\s+(session|project|global)\s+([\s\S]+)$/.exec(argument);
	if (add) {
		const scope = add[1] as "session" | "project" | "global";
		const record = await session.changeMemory({ action: "add", scope, content: add[2]!.trim() }, prompt, options.signal);
		return { text: `Memory saved: ${memoryLabel(record)}.`, switched: false };
	}
	const change = /^(update|delete)\s+(\S+)\s+([1-9][0-9]*)(?:\s+([\s\S]+))?$/.exec(argument);
	if (!change || !memoryIdPattern.test(change[2]!) || !Number.isSafeInteger(Number(change[3]))
		|| (change[1] === "update" ? !change[4]?.trim() : change[4] !== undefined)) usage();
	const action = change[1] as "update" | "delete";
	const record = await session.changeMemory({ action, id: change[2]!, revision: Number(change[3]),
		...(action === "update" ? { content: change[4]!.trim() } : {}) }, prompt, options.signal);
	return { text: `Memory ${action === "update" ? "updated" : "deleted"}: ${memoryLabel(record)}.`, switched: false };
}
