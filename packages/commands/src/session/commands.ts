import { quoted } from "../utils/command.js";
import { HarnessError } from "@fatcat/runtime/errors";
import { clearProjectConfirmation } from "../project/commands.js";
import { formatSessionList, sessionLabel, sessionScopeLabel } from "./labels.js";
import { SessionManager } from "@fatcat/runtime/session/manager";
import type { Session } from "@fatcat/runtime/session/session";

export type Conversation = Session | SessionManager;

export const sessionCommandHelp = "/new [--standalone] [name], /clear, /reset: start a new session; /sessions: list sessions; "
	+ "/resume <id|name>: switch; /workspace [path]: show or change workspace; /rename <name>: rename; /fork [name]: copy history into a new session.";

/** Local session commands never become user messages or grant tool permissions. */
export async function runSessionCommand(session: Conversation, prompt: string): Promise<{
	text: string; switched: boolean;
} | undefined> {
	const match = /^\/(new|clear|reset|sessions|resume|rename|fork|workspace)(?:\s+([\s\S]*))?$/.exec(prompt);
	if (!match) return undefined;
	const command = match[1]!;
	const argument = match[2]?.trim();
	if ((command === "clear" || command === "reset" || command === "sessions") && argument) {
		throw new HarnessError("USAGE", `/${command} does not take an argument.`);
	}
	if (!(session instanceof SessionManager)) {
		if (command === "new" || command === "clear" || command === "reset") {
			session.reset();
			return { text: "History cleared.", switched: true };
		}
		throw new HarnessError("USAGE", "Session management requires a managed conversation.");
	}
	if (command === "sessions" || (command === "resume" && !argument)) {
		return { text: formatSessionList(await session.list(), session.current.id), switched: false };
	}
	if (command === "workspace") {
		if (argument) {
			const path = argument.startsWith('"') && argument.endsWith('"') ? argument.slice(1, -1) : argument;
			await session.setWorkspace(path);
		}
		return { text: `Workspace: ${quoted(session.current.workspace)}`, switched: Boolean(argument) };
	}
	if (command === "rename") {
		if (!argument) throw new HarnessError("USAGE", "Use /rename <name>.");
		await session.rename(argument);
		return { text: `Session renamed: ${sessionLabel(session.current)}.`, switched: false };
	}
	if (command === "resume") await session.resume(argument!);
	else if (command === "fork") await session.fork(argument || undefined);
	else {
		const standalone = command === "new" && /^--standalone(?:\s|$)/.test(argument ?? "");
		const name = standalone ? argument!.slice("--standalone".length).trim() : argument;
		await session.newSession(name || undefined, standalone ? null : undefined);
	}
	clearProjectConfirmation(session);
	return {
		text: `${command === "resume" ? "Resumed" : command === "fork" ? "Forked" : "New"} session: ${sessionLabel(session.current)}.`
			+ ` Workspace: ${quoted(session.current.workspace)}.`
			+ ` ${sessionScopeLabel(session.current)}.`
			+ (session.current.interrupted ? " The last turn was interrupted; inspect workspace files before repeating operations." : ""),
		switched: true,
	};
}
