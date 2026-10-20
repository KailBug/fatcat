import type { ChatMessage } from "../../tests/support/chat-protocol.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { runCli } from "@fatcat/cli";
import { SessionManager } from "@fatcat/runtime/session/manager";
import { SessionStore } from "@fatcat/runtime/session/store";

// Explicit interactive fixture: no environment file or real provider request is used.
assert.equal(process.platform, "win32", "This verification requires Windows.");
assert.ok(process.stdin.isTTY && process.stdout.isTTY && process.stderr.isTTY, "Use an interactive Windows terminal.");
assert.notEqual(process.env.TERM, "dumb", "Use a VT-capable Windows terminal with TERM unset or set to its supported type.");
const temporaryRoot = await realpath(tmpdir());
const base = await mkdtemp(join(temporaryRoot, "fatcat-cli-verify-"));
const workspace = join(base, "workspace");
const environment = {
  HARNESS_PROVIDER: "deepseek", DEEPSEEK_API_KEY: "offline-cli-terminal-only", DEEPSEEK_MODEL: "deepseek-flash",
  HARNESS_MAX_ITERATIONS: "3", HARNESS_REQUEST_TIMEOUT_MS: "120000", HARNESS_MAX_REQUEST_BYTES: "262144",
  HARNESS_AUTO_COMPACT: "false", FATCAT_SESSION_DIR: join(base, "sessions"), USERPROFILE: join(base, "home"),
};
const previous = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const initialRaw = process.stdin.isRaw;
const initialListeners = process.listenerCount("SIGINT");
const prompts: string[] = [];
let cancelled = false;

function assertReleased(): void {
  assert.equal(process.stdin.isRaw, initialRaw, "The previous input owner must restore raw mode.");
  assert.equal(process.listenerCount("SIGINT"), initialListeners, "The previous host must remove its SIGINT listener.");
}

try {
  await mkdir(workspace);
  await mkdir(environment.USERPROFILE);
  Object.assign(process.env, environment);
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    assert.equal(request.url, "https://api.deepseek.com/chat/completions");
    const { messages } = await request.json() as { messages: ChatMessage[] };
    const last = messages.at(-1)!;
    if (last.role === "tool") return Response.json({ choices: [{ finish_reason: "stop",
      message: { role: "assistant", content: "CLI APPROVAL VERIFIED" } }] });
    const prompt = String(last.content);
    prompts.push(prompt);
    if (prompt === "approval") return Response.json({ choices: [{ finish_reason: "tool_calls", message: {
      role: "assistant", content: null, tool_calls: [{ id: "native-write", type: "function", function: {
        name: "write", arguments: JSON.stringify({ path: "approved.txt", content: "CLI terminal handoff verified" }),
      } }],
    } }] });
    if (prompt === "cancel") {
      await new Promise<never>((_resolve, reject) => {
        const abort = () => { cancelled = true; reject(new DOMException("Injected request cancelled", "AbortError")); };
        if (request.signal.aborted) abort();
        else request.signal.addEventListener("abort", abort, { once: true });
      });
    }
    return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "CLI TUI HANDOFF VERIFIED" } }] });
  };
  const store = new SessionStore({ root: environment.FATCAT_SESSION_DIR });
  const seed = await SessionManager.open({ maxIterations: 1, model: async () => ({
    message: { role: "assistant", content: "Seed answer" }, toolCalls: [],
  }) }, { workspace, store, selection: { name: "native-cli" } });
  await seed.run("Seed terminal session");

  console.log("Phase 1: select native-cli; submit approval; answer yes; wait for CLI APPROVAL VERIFIED; submit /exit.");
  assert.equal(await runCli(["--resume", "--chat", "--workspace", workspace, "--web-permission", "deny"]), 0);
  assertReleased();
  assert.equal(await readFile(join(workspace, "approved.txt"), "utf8"), "CLI terminal handoff verified");
  assert.deepEqual(prompts, ["approval"]);

  console.log("Phase 2: cancel the resume picker with /exit. No model request should run.");
  assert.equal(await runCli(["--resume"]), 0);
  assertReleased();
  assert.deepEqual(prompts, ["approval"]);

  console.log("Phase 3: select native-cli; submit cancel; press Esc while running; submit continue; wait for the answer; press Ctrl+D.");
  assert.equal(await runCli(["--resume", "--tui", "--workspace", workspace, "--web-permission", "deny"]), 1);
  assertReleased();
  assert.deepEqual(prompts, ["approval", "cancel", "continue"]);
  assert.equal(cancelled, true);
  const saved = await store.loadAny(seed.current.id);
  assert.deepEqual(saved.history.filter((message) => message.role === "user").map((message) => message.content),
    ["Seed terminal session", "approval", "continue"]);
  console.log(JSON.stringify({ verification: "cli-windows-terminal", passed: true, injectedModel: true,
    pickerToChat: true, pickerCancelled: true, pickerToTui: true, approval: true, cancelled, continued: true, inputReleased: true }));
} finally {
  globalThis.fetch = originalFetch;
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const target = resolve(base);
  assert.equal(dirname(target), temporaryRoot);
  assert.ok(basename(target).startsWith("fatcat-cli-verify-"));
  await rm(target, { recursive: true, force: true });
}
