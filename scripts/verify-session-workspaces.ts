import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { chromium } from "playwright";
import type { Browser } from "playwright";
import { SessionManager } from "../src/session/manager.js";
import { SessionStore } from "../src/session/store.js";
import { createTools } from "../src/tools.js";
import { WebUiController } from "../webui/controller.js";
import { startWebUiServer } from "../webui/server.js";

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
  return { tools, maxIterations: 1, model: async () => ({ toolCalls: [], message: { role: "assistant" as const,
    content: JSON.stringify(await tools.execute("read", '{"path":"marker.txt"}')) } }) };
};
const store = new SessionStore({ root: join(base, "sessions") });
const other = await SessionManager.open(await factory(outside), { workspace: outside, store, selection: { name: "Project B" }, agentForWorkspace: factory });
const session = await SessionManager.open(await factory(workspace), { workspace, store, selection: { name: "Project A" },
  deferEmptySessions: true, agentForWorkspace: factory });
const controller = await WebUiController.create({ workspace, provider: "deepseek", model: "offline", permission: "read-only",
  shellPermission: "deny", webPermission: "deny", maxIterations: 1, maxRequestBytes: 262144, skills: 0, warnings: [] }, session);
const server = await startWebUiServer(controller, 0);
let browser: Browser | undefined;
try {
  browser = await chromium.launch({ headless: true, channel: "msedge" });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.locator(`[data-session-id="${other.current.id}"]`).click();
  await page.waitForFunction((expected) => document.getElementById("workspace")?.textContent === expected, outside);
  await page.locator("#workspace-picker").click();
  await page.locator("#workspace-directory-path").fill(workspace);
  await page.getByRole("button", { name: "Open directory", exact: true }).click();
  await page.getByRole("button", { name: "File: marker.txt", exact: true }).waitFor();
  if (process.env.FATCAT_VERIFY_SCREENSHOT) await page.screenshot({ path: resolve(process.env.FATCAT_VERIFY_SCREENSHOT) });
  await page.getByRole("button", { name: "Use this workspace", exact: true }).click();
  await page.waitForFunction((expected) => document.getElementById("workspace")?.textContent === expected, workspace);
  assert.equal(session.current.id, other.current.id);
  assert.equal((await store.loadAny(other.current.id)).workspace, workspace);
  await page.getByRole("button", { name: "New chat", exact: true }).click();
  await page.locator("#workspace-picker").click();
  await page.locator("#workspace-directory-path").fill(outside);
  await page.getByRole("button", { name: "Open directory", exact: true }).click();
  await page.getByRole("button", { name: "File: marker.txt", exact: true }).waitFor();
  await page.getByRole("button", { name: "Use this workspace", exact: true }).click();
  await page.waitForFunction((expected) => document.getElementById("workspace")?.textContent === expected, outside);
  assert.equal(session.current.revision, 0);
  await page.locator("#prompt").fill("Read marker");
  await page.locator("#prompt").press("Enter");
  await page.waitForFunction(() => document.getElementById("messages")?.textContent?.includes("Workspace B"));
  assert.equal(session.current.workspace, outside);
  assert.equal(session.current.turnCount, 1);
  await page.getByRole("button", { name: "Actions for Project A", exact: true }).click();
  await page.getByRole("menuitem", { name: "Change workspace", exact: true }).click();
  await page.getByRole("button", { name: "File: marker.txt", exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await page.locator("#workspace-dialog").boundingBox();
  assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 390);
  await page.keyboard.press("Escape");
  assert.deepEqual(errors, []);
  console.log("Verified real Edge: global session list, resume/workspace synchronization, existing and draft directory selection, actual workspace read, session menu, narrow-screen dialog and no page errors.");
} finally {
  await browser?.close();
  await server.close();
  const target = resolve(base);
  if (dirname(target) !== temporaryRoot || !basename(target).startsWith("fatcat-session-ui-")) throw new Error("Unexpected fixture cleanup path.");
  await rm(target, { recursive: true, force: true });
}
