import { HarnessError } from "../errors.js";
import type { Session } from "./session.js";
import { SessionManager } from "./manager.js";
import type { SessionSummary } from "./store.js";

export type Conversation = Session | SessionManager;

export const sessionCommandHelp = "/new [name], /clear, /reset: start a new session; /sessions: list sessions; "
  + "/resume <id|name>: switch; /workspace [path]: show or change workspace; /rename <name>: rename; /fork [name]: copy history into a new session.";

function quoted(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function sessionLabel(summary: SessionSummary): string {
  return `${summary.id}${summary.name ? ` (${quoted(summary.name)})` : ""}`;
}

export function formatSessionList(sessions: readonly SessionSummary[], activeId?: string): string {
  if (!sessions.length) return "No saved sessions.";
  return sessions.map((session) => `${session.id === activeId ? "*" : " "} ${sessionLabel(session)} | `
    + `${session.turnCount} saved turns | ${session.updatedAt} | ${quoted(session.title)} | ${quoted(session.workspace)}`
    + `${session.interrupted ? " | interrupted" : ""}${session.automationCount ? ` | [clock] ${session.automationCount} automation(s)` : ""}`).join("\n");
}

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
  else await session.newSession(argument || undefined);
  return {
    text: `${command === "resume" ? "Resumed" : command === "fork" ? "Forked" : "New"} session: ${sessionLabel(session.current)}.`
      + ` Workspace: ${quoted(session.current.workspace)}.`
      + (session.current.interrupted ? " The last turn was interrupted; inspect workspace files before repeating operations." : ""),
    switched: true,
  };
}
