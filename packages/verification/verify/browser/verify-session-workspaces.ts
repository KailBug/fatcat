import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { chromium } from "playwright";
import type { Browser } from "playwright";
import { SessionManager } from "@fatcat/runtime/session/manager";
import { SessionStore } from "@fatcat/runtime/session/store";
import { createTools } from "@fatcat/runtime/tools";
import { HarnessError } from "@fatcat/runtime/errors";
import type { Model } from "@fatcat/runtime/model-types";
import { WebUiController } from "@fatcat/webui/internal/controller";
import { startWebUiServer } from "@fatcat/webui/internal/server";

// Explicit local browser validation with injected model decisions; no credentials or model API calls.
const temporaryRoot = await realpath(tmpdir());
const base = await mkdtemp(join(temporaryRoot, "fatcat-session-ui-"));
const workspace = join(base, "project-a");
const outside = join(base, "project-b");
await mkdir(workspace);
await mkdir(outside);
await writeFile(join(workspace, "marker.txt"), "Workspace A");
await writeFile(join(outside, "marker.txt"), "Workspace B");
const factory = async (root: string) => {
  const tools = await createTools(root);
  const model: Model = async (messages, _signal, observe) => {
    if (messages.at(-1)?.content === "Continue with automatic compaction"
      && JSON.stringify(messages).includes("Auto history detail.")) {
      observe?.({ type: "model_input", bytes: 300000, limitBytes: 262144, accepted: false });
      throw new HarnessError("MODEL_CONTEXT_LIMIT", "Injected local request limit");
    }
    return { message: { role: "assistant",
      content: JSON.stringify(await tools.execute("read", '{"path":"marker.txt"}')) } };
  };
  return { tools, maxIterations: 8, model,
    compactionModel: async () => ({ message: { role: "assistant" as const,
      content: "Keep the workspace marker requirement. Inspect current marker.txt before reporting its content." } }) };
};
const store = new SessionStore({ root: join(base, "sessions") });
const other = await SessionManager.open(await factory(outside), { workspace: outside, store, selection: { name: "Project B" }, agentForWorkspace: factory });
const session = await SessionManager.open(await factory(workspace), { workspace, store, selection: { name: "Project A" },
  deferEmptySessions: true, agentForWorkspace: factory });
const controller = await WebUiController.create({ workspace, provider: "deepseek", model: "offline", permission: "read-only",
  shellPermission: "deny", webPermission: "deny", maxIterations: 8, maxRequestBytes: 262144, skills: 0, warnings: [] }, session);
const selections = [workspace, outside, null];
const initialPaths: string[] = [];
const server = await startWebUiServer(controller, 0, async (initialPath) => {
  initialPaths.push(initialPath);
  return selections.shift() ?? null;
});
let browser: Browser | undefined;
async function waitForIdle(): Promise<void> {
  const deadline = performance.now() + 10000;
  while (controller.snapshot().busy) {
    if (performance.now() >= deadline) throw new Error("Session operation did not settle within 10 seconds.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
try {
  browser = await chromium.launch({ headless: true, channel: "msedge" });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.locator(`[data-session-id="${other.current.id}"]`).click();
  await page.waitForFunction((expected) => document.getElementById("workspace")?.textContent === expected, outside);
  await page.locator("#workspace-picker").click();
  await page.waitForFunction((expected) => document.getElementById("workspace")?.textContent === expected, workspace);
  assert.equal(session.current.id, other.current.id);
  assert.equal((await store.loadAny(other.current.id)).workspace, workspace);
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await page.locator("#workspace-picker").click();
  await page.waitForFunction((expected) => document.getElementById("workspace")?.textContent === expected, outside);
  assert.equal(session.current.revision, 0);
  await page.locator("#prompt").fill("Read marker");
  await page.locator("#prompt").press("Enter");
  await page.waitForFunction(() => document.getElementById("messages")?.textContent?.includes("Workspace B"));
  assert.equal(session.current.workspace, outside);
  assert.equal(session.current.turnCount, 1);
  await page.getByRole("button", { name: "Actions for Project A", exact: true }).click();
  await page.getByRole("menuitem", { name: "Change workspace", exact: true }).click();
  await page.waitForFunction(() => !(document.getElementById("workspace-picker") as HTMLButtonElement).disabled);
  assert.deepEqual(initialPaths, [outside, workspace, workspace]);
  assert.equal(session.current.workspace, outside);
  await page.locator("#prompt").fill("Keep the workspace marker requirement. " + "Historical detail. ".repeat(500));
  await page.locator("#prompt").press("Enter");
  await page.waitForFunction(() => !(document.getElementById("prompt") as HTMLTextAreaElement).disabled);
  await page.waitForFunction(() => document.getElementById("messages")?.textContent?.includes("Historical detail."));
  // Wait for durable completion rather than relying on composer editing being enabled.
  await waitForIdle();
  await page.locator("#send").waitFor({ state: "visible" });
  await page.locator("#prompt").fill("Read the current marker again");
  await page.locator("#prompt").press("Enter");
  await page.waitForFunction(() => document.getElementById("messages")?.textContent?.includes("Read the current marker again"));
  await waitForIdle();
  await page.locator("#send").waitFor({ state: "visible" });
  const completeHistory = session.history;
  await page.locator("#prompt").fill("/compact Preserve the marker requirement");
  await page.locator("#prompt").press("Enter");
  await page.waitForFunction(() => document.getElementById("messages")?.textContent?.includes("Context compacted"));
  assert.deepEqual(session.history, completeHistory);
  assert.ok(session.context.projectedBytes < session.context.historyBytes);
  assert.equal(session.current.turnCount, 3);
  assert.ok((await store.loadAny(session.current.id)).compaction);
  await page.locator("#send").waitFor({ state: "visible" });
  await page.locator("#prompt").fill("/context");
  await page.locator("#prompt").press("Enter");
  await page.waitForFunction(() => document.getElementById("messages")?.textContent?.includes("Full history:"));
  for (const prompt of ["Auto history detail. ".repeat(500), "Retain the recent marker requirement", "Continue with automatic compaction"]) {
    await waitForIdle();
    await page.locator("#send").waitFor({ state: "visible" });
    await page.locator("#prompt").fill(prompt);
    await page.locator("#prompt").press("Enter");
    await page.waitForFunction((expected) => document.getElementById("messages")?.textContent?.includes(expected), prompt.trim());
    await waitForIdle();
  }
  await page.waitForFunction(() => document.getElementById("messages")?.textContent?.includes("compacting older turns"));
  assert.equal(session.current.turnCount, 6);
  assert.deepEqual(session.history.slice(0, completeHistory.length), completeHistory);
  assert.equal(controller.snapshot().turns.at(-1)?.status, "answered");
  assert.equal(controller.snapshot().turns.at(-1)?.report?.requestBytes.parent.rejected, 1);
  assert.equal((await store.loadAny(session.current.id)).compaction?.firstKeptMessage, 9);
  if (process.env.FATCAT_VERIFY_SCREENSHOT) await page.screenshot({ path: resolve(process.env.FATCAT_VERIFY_SCREENSHOT) });
  assert.deepEqual(errors, []);
  console.log("Verified real Edge with injected models and a native picker: global sessions, workspace selection/read, manual and automatic compaction, context status, preserved history, saved summary, session menus and no page errors.");
} finally {
  await browser?.close();
  await server.close();
  const target = resolve(base);
  if (dirname(target) !== temporaryRoot || !basename(target).startsWith("fatcat-session-ui-")) throw new Error("Unexpected fixture cleanup path.");
  await rm(target, { recursive: true, force: true });
}
