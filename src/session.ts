import { HarnessError, checkCancellation } from "./errors.js";
import { runAgentTurn } from "./loop.js";
import type { LoopOptions } from "./loop.js";
import type { Message } from "./model.js";

/** A process-local conversation that keeps only successfully completed turns. */
export class Session {
  private history: Message[] = [];
  private running = false;

  constructor(private readonly options: Pick<LoopOptions, "model" | "maxIterations" | "tools">) {}

  async run(prompt: string, options: Pick<LoopOptions, "signal" | "onEvent"> = {}): Promise<string> {
    this.requireIdle();
    this.running = true;
    try {
      const result = await runAgentTurn(prompt, this.history, { ...this.options, ...options });
      checkCancellation(options.signal);
      this.history = result.messages;
      return result.answer;
    } finally {
      this.running = false;
    }
  }

  reset(): void {
    this.requireIdle();
    this.history = [];
  }

  private requireIdle(): void {
    if (this.running) {
      throw new HarnessError("SESSION_BUSY", "A turn is already running in this session.");
    }
  }
}
