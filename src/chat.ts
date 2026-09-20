import { createInterface } from "node:readline";
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
  },
): Promise<number> {
  const { input, output, error } = options;
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  checkCancellation(signal);
  const terminal = Boolean(input.isTTY && error.isTTY);
  const lines = createInterface({ input, output: error, terminal, crlfDelay: Infinity });
  const cancel = () => controller.abort();
  const close = () => lines.close();
  lines.on("SIGINT", cancel);
  signal.addEventListener("abort", close, { once: true });
  let turn = 0;
  let failed = false;
  try {
    error.write(`Chat started. History stays in memory. ${commands}\n`);
    lines.setPrompt("You> ");
    if (terminal) lines.prompt();
    // The iterator queues input received while the model is working, including piped lines.
    for await (const line of lines) {
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
            onEvent: (event) => error.write(`${JSON.stringify({ turn, ...event })}\n`),
          });
          output.write(`${answer}\n`);
        } catch (cause) {
          checkCancellation(signal);
          failed = true;
          error.write(`${formatError(cause)}\n`);
        }
      }
      if (terminal) lines.prompt();
    }
    checkCancellation(signal);
    return failed ? 1 : 0;
  } finally {
    signal.removeEventListener("abort", close);
    lines.off("SIGINT", cancel);
    lines.close();
  }
}
