import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { HarnessError } from "./errors.js";
import { runAgent } from "./loop.js";
import { createDeepSeekModel } from "./model.js";

const help = `Fatcat - minimal Agent Harness

Usage:
  pnpm start --help
  pnpm start --check-config
  pnpm start "Use the sum tool to add 17 and 25."
  pnpm start --prompt "Explain what an agent loop does."

One invocation runs one task. History stays in memory.
Configuration checks are local and do not validate credentials or connectivity.
Logs go to stderr; the final answer goes to stdout. Press Ctrl+C to cancel.`;

async function main(args: string[]): Promise<number> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  try {
    let parsed;
    try {
      parsed = parseArgs({
        args,
        options: {
          help: { type: "boolean", short: "h" },
          "check-config": { type: "boolean" },
          prompt: { type: "string" },
        },
        allowPositionals: true,
        strict: true,
      });
    } catch {
      throw new HarnessError("USAGE", "Invalid arguments. Run pnpm start --help.");
    }
    const { values, positionals } = parsed;
    const modes = Number(Boolean(values.help)) + Number(Boolean(values["check-config"]))
      + Number(values.prompt !== undefined || positionals.length > 0);
    if (modes > 1 || (values.prompt !== undefined && positionals.length > 0)) {
      throw new HarnessError("USAGE", "Choose one mode: help, config check, or one prompt.");
    }
    if (values.help || args.length === 0) {
      console.log(help);
      return 0;
    }
    if (values["check-config"]) {
      const config = loadConfig();
      console.log("Local configuration is valid (DeepSeek was not contacted).");
      console.log(`Model: ${config.model}`);
      console.log(`Maximum model iterations: ${config.maxIterations}`);
      console.log(`Request timeout: ${config.requestTimeoutMs} ms`);
      console.log("API key: configured (hidden)");
      return 0;
    }
    const prompt = values.prompt ?? positionals.join(" ");
    if (!prompt.trim()) throw new HarnessError("USAGE", "The prompt must not be empty.");
    const config = loadConfig();
    process.on("SIGINT", cancel);
    const answer = await runAgent(prompt, {
      model: createDeepSeekModel(config),
      maxIterations: config.maxIterations,
      signal: controller.signal,
      onEvent: (event) => console.error(JSON.stringify(event)),
    });
    console.log(answer);
    return 0;
  } catch (error) {
    const known = error instanceof HarnessError;
    console.error(known ? `Error [${error.code}]: ${error.message}` : "Error [INTERNAL]: An unexpected failure occurred.");
    if (known && error.code === "USAGE") return 2;
    if (known && error.code === "CANCELLED") return 130;
    return 1;
  } finally {
    process.off("SIGINT", cancel);
  }
}

process.exitCode = await main(process.argv.slice(2));
