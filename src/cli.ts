import { parseArgs } from "node:util";
import { runChat } from "./chat.js";
import { Session } from "./session.js";
import { loadConfig } from "./config.js";
import { HarnessError, formatError } from "./errors.js";
import { runAgent } from "./loop.js";
import { createDeepSeekModel } from "./model.js";
import { createTools } from "./tools.js";
import { createSubagentTools } from "./subagent.js";

const help = `Fatcat - minimal Agent Harness

Usage:
  pnpm start --help
  pnpm start --checkConfig
  pnpm start --chat
  pnpm start --chat --workspace examples/workspace
  pnpm start --chat --subagent --workspace examples/workspace
  pnpm start "Use the sum tool to add 17 and 25."
  pnpm start --prompt "Explain what an agent loop does."

Use --chat for a continuous conversation with /help, /reset, and /exit.
A prompt runs one task. History stays in memory.
Use --subagent to allow up to two isolated child tasks per user turn.
Each child uses at most three additional model requests and cannot delegate.
Use --workspace <directory> to enable read-only text tools in that directory.
Selected file contents are sent to DeepSeek when the model reads them.
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
          checkConfig: { type: "boolean" },
          prompt: { type: "string" },
          chat: { type: "boolean" },
          workspace: { type: "string" },
          subagent: { type: "boolean" },
        },
        allowPositionals: true,
        strict: true,
      });
    } catch {
      throw new HarnessError("USAGE", "Invalid arguments. Run pnpm start --help.");
    }
    const { values, positionals } = parsed;
    const modes = Number(Boolean(values.help))
      + Number(Boolean(values.checkConfig))
      + Number(Boolean(values.chat))
      + Number(values.prompt !== undefined || positionals.length > 0);

    //start parsing if
    if (modes > 1 || (values.prompt !== undefined && positionals.length > 0)) {
      throw new HarnessError("USAGE", "Choose one mode: help, config check, chat, or one prompt.");
    }
    if (values.workspace !== undefined && (!values.workspace.trim() || values.help || values.checkConfig
      || (!values.chat && values.prompt === undefined && positionals.length === 0))) {
      throw new HarnessError("USAGE", "Use --workspace with a prompt or --chat and a non-empty directory.");
    }
    if (values.subagent && (values.help || values.checkConfig
      || (!values.chat && values.prompt === undefined && positionals.length === 0))) {
      throw new HarnessError("USAGE", "Use --subagent with a prompt or --chat.");
    }
    if (values.help || args.length === 0) {
      console.log(help);
      return 0;
    }
    if (values.checkConfig) {
      const config = loadConfig();
      console.log("Local configuration is valid (DeepSeek was not contacted).");
      console.log(`Model: ${config.model}`);
      console.log(`Maximum model iterations: ${config.maxIterations}`);
      console.log(`Request timeout: ${config.requestTimeoutMs} ms`);
      console.log("API key: configured (hidden)");
      return 0;
    }
    const prompt = values.prompt ?? positionals.join(" ");
    if (!values.chat && !prompt.trim()) throw new HarnessError("USAGE", "The prompt must not be empty.");

    //start config
    const config = loadConfig();
    process.on("SIGINT", cancel);
    const baseTools = await createTools(values.workspace);
    const tools = values.subagent
      ? createSubagentTools(baseTools, createDeepSeekModel(config, undefined, baseTools), config.maxIterations)
      : baseTools;
    const model = createDeepSeekModel(config, undefined, tools);
    if (values.chat) {
      return await runChat(new Session({ model, tools, maxIterations: config.maxIterations }), {
        input: process.stdin, output: process.stdout, error: process.stderr, signal: controller.signal,
      });
    }
    const answer = await runAgent(prompt, {
      model, tools,
      maxIterations: config.maxIterations,
      signal: controller.signal,
      onEvent: (event) => console.error(JSON.stringify(event)),
    });
    console.log(answer);
    return 0;
  } catch (error) {
    const known = error instanceof HarnessError;
    console.error(formatError(error));
    if (known && error.code === "USAGE") return 2;
    if (known && error.code === "CANCELLED") return 130;
    return 1;
  } finally {
    process.off("SIGINT", cancel);
  }
}

process.exitCode = await main(process.argv.slice(2));
