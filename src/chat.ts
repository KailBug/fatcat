import { createTurnReporter } from "./execution-report.js";
import { createTerminalInput } from "./terminal.js";
import type { TerminalInput } from "./terminal.js";
import type { Readable, Writable } from "node:stream";
import { checkCancellation, formatError } from "./errors.js";
import { SessionManager } from "./session/manager.js";
import { runInteractiveCommand, interactiveCommandHelp, automationCommandPrompt } from "./commands.js";
import { sessionLabel } from "./session/commands.js";
import type { Conversation } from "./session/commands.js";
import type { SkillDescriptor } from "./skills.js";
import { ConversationAutomations } from "./automation/conversations.js";

const commands = `/help: show commands; /exit: end chat. ${interactiveCommandHelp}`;

export async function runChat(
  session: Conversation,
  options: {
    input: Readable & { isTTY?: boolean };
    output: Writable;
    error: Writable & { isTTY?: boolean };
    signal?: AbortSignal;
    terminal?: TerminalInput;
    skills?: readonly SkillDescriptor[];
  },
): Promise<number> {
  const { input, output, error } = options;
  const terminal = options.terminal ?? createTerminalInput(input, error, options.signal);
  const signal = terminal.signal;
  checkCancellation(signal);
  let turn = 0;
  let failed = false;
  let foreground = false;
  let background: Promise<void> | undefined;
  const backgroundAbort = new AbortController();
  const automation = session instanceof SessionManager ? new ConversationAutomations(session, {
    idle: () => !foreground && !background,
    run: async (task, activation) => {
      background = (async () => {
        error.write(`[clock] Automation in ${JSON.stringify(task.sessionTitle)}\n`);
        try {
          output.write(`${await session.runAutomation(task.sessionId, task.id, activation.scheduledAt, activation.paths ?? [], {
            signal: AbortSignal.any([signal, backgroundAbort.signal]),
            onEvent: createTurnReporter((event) => error.write(`${JSON.stringify({ automation: task.id, sessionId: task.sessionId, ...event })}\n`)),
          })}\n`);
        } catch (cause) { error.write(`${formatError(cause)}\n`); }
      })();
      try { await background; } finally { background = undefined; terminal.prompt(); }
    },
    changed: () => {}, error: (message) => error.write(`Automation: ${message}\n`),
  }) : undefined;
  try {
    automation?.start();
    error.write(`Chat started. ${session instanceof SessionManager
      ? `Session: ${sessionLabel(session.current)}. Workspace: ${JSON.stringify(session.current.workspace)}. ${session.persistent ? "History is saved locally." : "Persistence is disabled."}`
      : "History stays in memory."} ${commands}\n`);
    if (session instanceof SessionManager && session.current.interrupted) {
      error.write("The last turn was interrupted. Inspect workspace files before repeating operations.\n");
    }
    terminal.prompt();
    while (true) {
      const line = await terminal.readTask();
      if (line === undefined) break;
      foreground = true;
      await background;
      checkCancellation(signal);
      const prompt = automationCommandPrompt(line.trim()) ?? line.trim();
      if (prompt === "/exit") break;
      if (prompt === "/help") {
        error.write(`${commands}\n`);
      } else if (prompt.startsWith("/")) {
        try {
          const result = await runInteractiveCommand(session, prompt, options.skills, {
            signal, onEvent: createTurnReporter((event) => error.write(`${JSON.stringify({ operation: "compaction", ...event })}\n`)),
          });
          error.write(result ? `${result.text}\n` : "Unknown command. Use /help.\n");
          if (result?.switched) error.write('{"type":"session_reset"}\n');
        } catch (cause) {
          checkCancellation(signal);
          error.write(`${formatError(cause)}\n`);
        }
      } else if (prompt) {
        turn++;
        try {
          const answer = await session.run(prompt, {
            signal,
            onEvent: createTurnReporter((event) => error.write(`${JSON.stringify({ turn, ...event })}\n`)),
          });
          output.write(`${answer}\n`);
        } catch (cause) {
          checkCancellation(signal);
          failed = true;
          error.write(`${formatError(cause)}\n`);
        }
      }
      terminal.prompt();
      foreground = false;
    }
    checkCancellation(signal);
    return failed ? 1 : 0;
  } finally {
    backgroundAbort.abort();
    await automation?.close();
    terminal.close();
  }
}
