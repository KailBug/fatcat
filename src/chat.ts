import { createTurnReporter } from "./execution-report.js";
import { createTerminalInput } from "./terminal.js";
import type { TerminalInput } from "./terminal.js";
import type { Readable, Writable } from "node:stream";
import { checkCancellation, formatError } from "./errors.js";
import { SessionManager } from "./session/manager.js";
import { runSessionCommand, sessionCommandHelp, sessionLabel } from "./session/commands.js";
import type { Conversation } from "./session/commands.js";

const commands = `/help: show commands; /exit: end chat. ${sessionCommandHelp}`;

export async function runChat(
  session: Conversation,
  options: {
    input: Readable & { isTTY?: boolean };
    output: Writable;
    error: Writable & { isTTY?: boolean };
    signal?: AbortSignal;
    terminal?: TerminalInput;
  },
): Promise<number> {
  const { input, output, error } = options;
  const terminal = options.terminal ?? createTerminalInput(input, error, options.signal);
  const signal = terminal.signal;
  checkCancellation(signal);
  let turn = 0;
  let failed = false;
  try {
    error.write(`Chat started. ${session instanceof SessionManager
      ? `Session: ${sessionLabel(session.current)}. ${session.persistent ? "History is saved locally." : "Persistence is disabled."}`
      : "History stays in memory."} ${commands}\n`);
    if (session instanceof SessionManager && session.current.interrupted) {
      error.write("The last turn was interrupted. Inspect workspace files before repeating operations.\n");
    }
    terminal.prompt();
    while (true) {
      const line = await terminal.readTask();
      if (line === undefined) break;
      checkCancellation(signal);
      const prompt = line.trim();
      if (prompt === "/exit") break;
      if (prompt === "/help") {
        error.write(`${commands}\n`);
      } else if (prompt.startsWith("/")) {
        try {
          const result = await runSessionCommand(session, prompt);
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
    }
    checkCancellation(signal);
    return failed ? 1 : 0;
  } finally {
    terminal.close();
  }
}
