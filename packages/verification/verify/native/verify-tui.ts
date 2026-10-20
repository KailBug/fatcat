import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { checkCancellation } from "@fatcat/runtime/errors";
import type { Model, ModelTurn } from "@fatcat/runtime/model-types";
import { Session } from "@fatcat/runtime/session/session";
import { createTools } from "@fatcat/runtime/tools";
import { TuiApp } from "@fatcat/tui/internal/app";

// Drive this fixture through real terminal input; see Development's Windows terminal checks.
assert.equal(process.platform, "win32", "This verification requires Windows.");
assert.ok(process.stdin.isTTY && process.stdout.isTTY, "Run in an interactive Windows terminal, not redirected pipes.");
const workspace = await mkdtemp(join(tmpdir(), "fatcat-tui-verify-"));
const initialRaw = process.stdin.isRaw;
const initialInterruptListeners = process.listenerCount("SIGINT");
const prompts: string[] = [];
let cancelled = false;
let summaries = 0;
const answer = (content: string): ModelTurn => ({ message: { role: "assistant", content }, toolCalls: [] });
const app = new TuiApp({
  config: { provider: "deepseek", region: "global", model: "injected-terminal-model", maxIterations: 3,
    requestTimeoutMs: 60000, maxRequestBytes: 262144 },
  workspace, permission: "ask", shellPermission: "deny", webPermission: "deny", skills: 0, color: false,
});
const model: Model = async (messages, signal, observe) => {
  observe?.({ type: "model_usage", usage: { promptTokens: 80, completionTokens: 20, totalTokens: 100 } });
  if (messages.at(-1)?.role === "tool") return answer("APPROVED FILE SAVED");
  const prompt = String(messages.at(-1)?.content);
  prompts.push(prompt);
  if (prompt === "approval") {
    // Leave time to type a draft before the tool asks for a fresh approval answer.
    await delay(1500, undefined, { signal });
    const toolCalls = [{ id: "write-fixture", name: "write", arguments: JSON.stringify({ path: "approved.txt", content: "terminal approval verified" }) }];
    return { message: { role: "assistant", content: null, toolCalls: toolCalls }, toolCalls };
  }
  if (prompt === "cancel") {
    try {
      await delay(120000, undefined, { signal });
    } finally {
      cancelled = Boolean(signal?.aborted);
    }
    checkCancellation(signal);
  }
  return answer(prompt === "draft after approval" ? "DRAFT RESTORED" : "CONTINUED AFTER CANCELLATION");
};

try {
  const tools = await createTools(workspace, "ask", app.approveWrite, { permission: "deny" }, { permission: "deny" });
  const session = new Session({ model, tools, maxIterations: 3, compactionModel: async (_messages, _signal, observe) => {
    summaries++;
    observe?.({ type: "model_usage", usage: { promptTokens: 60, completionTokens: 10, totalTokens: 70 } });
    return answer("The user approved creating approved.txt, and the next draft was restored. Keep the file unchanged.");
  } });
  const code = await app.run(session);
  assert.equal(code, 1, "Cancellation retains the existing failed-turn exit status.");
  assert.equal(process.stdin.isRaw, initialRaw, "Raw mode must be restored.");
  assert.equal(process.listenerCount("SIGINT"), initialInterruptListeners, "The app must remove its signal listener.");
  assert.equal(await readFile(join(workspace, "approved.txt"), "utf8"), "terminal approval verified");
  assert.deepEqual(prompts, ["approval", "draft after approval", "cancel", "continue"]);
  assert.equal(cancelled, true);
  assert.equal(summaries, 1);
  assert.equal(app.telemetry.snapshot().conversation.completedTurns, 3);
  assert.equal(app.telemetry.snapshot().session.answered, 4, "The explicit summary counts as answered work, not a conversation turn.");
  assert.equal(app.telemetry.snapshot().session.stopped, 1);
  assert.equal(app.telemetry.snapshot().session.writes, 1);
  assert.ok(!session.messages.some((message) => message.role === "user" && ["yes", "cancel", "/compact"].includes(String(message.content))));
  console.log(JSON.stringify({ verification: "tui-windows-terminal", passed: true, injectedModel: true,
    approvals: 1, restoredDrafts: 1, summaries, cancelled, continued: true, rawModeRestored: true }));
} finally {
  await rm(workspace, { recursive: true, force: true });
}
