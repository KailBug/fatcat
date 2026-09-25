import { createTurnReporter } from "./execution-report.js";
import { createTerminalInput } from "./terminal.js";
import type { TerminalInput } from "./terminal.js";
import type { Readable, Writable } from "node:stream";
import { checkCancellation, formatError } from "./errors.js";
import type { Session } from "./session.js";

const commands = "/help: show commands; /reset: clear history; /exit: end chat.";

export async function runChat(
  session: Session,
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
    error.write(`Chat started. History stays in memory. ${commands}\n`);
    terminal.prompt();
    while (true) {
      const line = await terminal.readTask();
      if (line === undefined) break;
      checkCancellation(signal);
      const prompt = line.trim();
      if (prompt === "/exit") break;
      if (prompt === "/help") {
        error.write(`${commands}\n`);
      } else if (prompt === "/reset") {
        session.reset();
        error.write('History cleared.\n{"type":"session_reset"}\n');
      } else if (prompt.startsWith("/")) {
        error.write("Unknown command. Use /help.\n");
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
