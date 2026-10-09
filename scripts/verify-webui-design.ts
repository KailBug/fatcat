import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import type { Model } from "../src/model.js";
import { PermissionPolicy } from "../src/permissions/policy.js";
import { SessionManager } from "../src/session/manager.js";
import { SessionStore } from "../src/session/store.js";
import { createTools } from "../src/tools.js";
import { WebUiController } from "../webui/controller.js";
import { startWebUiServer } from "../webui/server.js";

// Explicit Edge validation with temporary data and injected decisions; no model API or credentials.
const temporaryRoot = await realpath(tmpdir());
const base = await mkdtemp(join(temporaryRoot, "fatcat-design-"));
const workspace = join(base, "a-workspace-with-a-long-name-for-layout-review");
const screenshots = process.env.FATCAT_VERIFY_SCREENSHOTS;
let browser: Browser | undefined;
let server: Awaited<ReturnType<typeof startWebUiServer>> | undefined;
let controller: WebUiController | undefined;
let pickerCalls = 0;

async function checkLayout(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => {
    const containers = [document.documentElement, ...document.querySelectorAll<HTMLElement>("main, .scroll-area, .composer, dialog[open]")];
    return containers.filter((node) => node.scrollWidth > node.clientWidth + 1)
      .map((node) => `${node.tagName}.${node.className}: ${node.scrollWidth}/${node.clientWidth}`);
  });
  assert.deepEqual(overflow, [], `${label}: horizontal overflow`);
  if (screenshots) await page.screenshot({ path: join(resolve(screenshots), `${label}.png`), animations: "disabled" });
}

try {
  await mkdir(workspace);
  if (screenshots) await mkdir(resolve(screenshots), { recursive: true });
  await writeFile(join(workspace, "preview.html"), "<!doctype html><html lang=\"en\"><title>Preview fixture</title><h1>Local preview is ready</h1></html>");
  const policy = new PermissionPolicy("default");
  const tools = await createTools(workspace, "ask", (request, signal) => controller!.requestApproval("write", request, signal),
    { permission: "ask" }, undefined, policy);
  const model: Model = async (messages, signal) => {
    const prompt = messages.findLast((message) => message.role === "user")?.content;
    if (prompt === "Wait for cancellation") {
      await new Promise<void>((_resolve, reject) => {
        if (signal?.aborted) { reject(new Error("Cancelled fixture")); return; }
        signal?.addEventListener("abort", () => reject(new Error("Cancelled fixture")), { once: true });
      });
    }
    if (prompt === "Propose a file" && messages.at(-1)?.role === "user") {
      const tool = { id: "design-write", type: "function" as const,
        function: { name: "write", arguments: JSON.stringify({ path: "approved.txt", content: "Approved fixture\n" }) } };
      return { message: { role: "assistant", content: null, tool_calls: [tool] }, toolCalls: [tool] };
    }
    return { toolCalls: [], message: { role: "assistant", content: [
      "## A clear starting point", "This is an **injected UI fixture**, with a short plan and code to check the conversation layout.",
      "- Read the entry points.\n- Make a focused change.\n- Run the relevant checks.",
      "```typescript\nconst workspace = 'a-long-workspace-path/with-several/nested/directories';\nconsole.log(workspace);\n```",
      "Mixed-language text: \u8ba9\u6bcf\u4e00\u6b21\u4fee\u6539\u90fd\u6e05\u6670\u53ef\u89c1\uff0c\u4ece\u4e00\u4e2a\u5c0f\u800c\u6709\u7528\u7684\u6539\u8fdb\u5f00\u59cb\u3002",
    ].join("\n\n") } };
  };
  const session = await SessionManager.open({ model, tools, maxIterations: 3 },
    { workspace, store: new SessionStore({ root: join(base, "sessions") }), deferEmptySessions: true });
  await session.run("Explore the project structure");
  await session.rename("Explore the project structure");
  const savedId = session.current.id;
  await session.newSession("Review a long session title that should stay inside the sidebar");
  await session.newSession();
  controller = await WebUiController.create({ workspace, provider: "deepseek", model: "deepseek-chat", permission: "ask",
    shellPermission: "ask", webPermission: "deny", maxIterations: 3, maxRequestBytes: 262144, skills: 0, warnings: [] }, session, policy);
  server = await startWebUiServer(controller, 0, async () => { pickerCalls++; return null; });
  browser = await chromium.launch({ headless: true, channel: "msedge" });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, colorScheme: "light" });
  page.setDefaultTimeout(10000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(server.url);
  await page.waitForFunction(() => !(document.getElementById("prompt") as HTMLTextAreaElement).disabled);

  for (const colorScheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme });
    for (const width of [1440, 1024, 390, 320]) {
      await page.setViewportSize({ width, height: width < 760 ? 844 : 768 });
      await checkLayout(page, `welcome-${colorScheme}-${width}`);
      await page.locator("#permission-mode").click();
      await checkLayout(page, `permission-${colorScheme}-${width}`);
      await page.keyboard.press("Escape");
      assert.equal(await page.locator("#permission-mode").evaluate((node) => node === document.activeElement), true);
      if (width < 760) await page.locator("#toggle-sidebar").click();
      await page.locator("#show-cron").click();
      for (const trigger of ["interval", "cron", "at", "file_changed"]) {
        await page.getByLabel("Trigger", { exact: true }).selectOption(trigger);
        const layout = await page.locator(".cron-dialog").evaluate((dialog) => {
          const bounds = dialog.getBoundingClientRect();
          const fields = [...dialog.querySelectorAll<HTMLElement>("form input, form textarea, form select, form button")];
          return { scroll: dialog.scrollHeight > dialog.clientHeight + 1,
            visible: fields.every((field) => { const box = field.getBoundingClientRect(); return box.top >= bounds.top && box.bottom <= bounds.bottom && box.left >= bounds.left && box.right <= bounds.right; }) };
        });
        assert.deepEqual(layout, { scroll: false, visible: true }, `${width}px ${trigger}: all Cron creation controls must fit`);
      }
      await page.getByLabel("Trigger", { exact: true }).selectOption("interval");
      await checkLayout(page, `cron-${colorScheme}-${width}`);
      await page.keyboard.press("Escape");
      if (width < 760) {
        assert.equal(await page.locator("body").evaluate((node) => node.classList.contains("sidebar-open")), true);
        await page.keyboard.press("Escape");
        assert.equal(await page.locator("#toggle-sidebar").evaluate((node) => node === document.activeElement), true);
      }
    }
  }

  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 1440, height: 768 });
  await page.locator("#show-cron").click();
  for (const [index, linkedSession] of [savedId, "", savedId].entries()) {
    await page.getByLabel("Linked session", { exact: true }).selectOption(linkedSession);
    await page.getByLabel("Task instructions", { exact: true }).fill(`Scheduled fixture ${index + 1}. ${"Review the project and its tests. ".repeat(12)}`);
    await page.getByLabel("Interval (minutes)", { exact: true }).fill("60");
    await page.getByRole("button", { name: "Create task", exact: true }).click();
    await page.getByRole("heading", { name: `Scheduled tasks · ${index + 1}`, exact: true }).waitFor();
  }
  assert.equal(controller.snapshot().automations.length, 3);
  assert.ok(controller.snapshot().automations.some((task) => task.sessionId !== savedId));
  await page.getByRole("button", { name: "Next", exact: true }).click();
  const selectedTask = await page.locator(".cron-task-prompt").textContent();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByRole("button", { name: "Resume", exact: true }).waitFor();
  await page.getByRole("button", { name: "Resume", exact: true }).click();
  await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
  assert.equal(await page.locator(".cron-task-prompt").textContent(), selectedTask);
  await checkLayout(page, "cron-populated-desktop");
  assert.equal(await page.locator(".cron-dialog").evaluate((dialog) => dialog.scrollHeight > dialog.clientHeight + 1), false);
  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await page.getByRole("heading", { name: "Scheduled tasks · 2", exact: true }).waitFor();
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  assert.match(await page.locator(".cron-task-prompt").textContent() ?? "", /Scheduled fixture 1/);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Scheduled (2)", exact: true }).click();
  await checkLayout(page, "cron-populated-mobile");
  assert.equal(await page.locator(".cron-dialog").evaluate((dialog) => dialog.scrollHeight > dialog.clientHeight + 1), false);
  await page.getByRole("button", { name: "New task", exact: true }).click();
  assert.equal(await page.getByRole("button", { name: "Create task", exact: true }).isVisible(), true);
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#toggle-sidebar").click();
  await checkLayout(page, "sidebar-mobile");
  await page.locator(".brand").focus();
  await page.keyboard.press("Shift+Tab");
  assert.equal(await page.locator("#sidebar button:not(:disabled)").last().evaluate((node) => node === document.activeElement), true);
  await page.keyboard.press("Tab");
  assert.equal(await page.locator(".brand").evaluate((node) => node === document.activeElement), true);
  await page.getByRole("button", { name: "Actions for Explore the project structure", exact: true }).click();
  await page.getByRole("menuitem", { name: "Rename session", exact: true }).click();
  await checkLayout(page, "rename-mobile");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("body").evaluate((node) => node.classList.contains("sidebar-open")), true);
  await page.locator("#close-sidebar").click();
  assert.equal(await page.locator("#toggle-sidebar").evaluate((node) => node === document.activeElement), true);
  await page.locator("#toggle-sidebar").click();
  await page.locator("#sidebar-backdrop").click({ position: { x: 380, y: 400 } });
  assert.equal(await page.locator("#toggle-sidebar").evaluate((node) => node === document.activeElement), true);
  await page.locator("#toggle-sidebar").click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.waitForFunction(() => !document.querySelector("main")!.inert);

  assert.equal(await page.locator(".suggestions, [data-prompt]").count(), 0);
  assert.equal(await page.locator(".welcome-icon").evaluate((node) => node instanceof HTMLImageElement && node.complete && node.naturalWidth > 0), true);
  await page.locator("#prompt").fill("Explore this workspace");
  await page.locator("#send").click();
  await page.locator(".answer").waitFor();
  for (const width of [1440, 1024, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await checkLayout(page, `conversation-${width}`);
  }
  await page.locator("#prompt").fill("Propose a file");
  await page.locator("#send").click();
  await page.locator("#approval:not([hidden])").waitFor();
  await checkLayout(page, "approval-mobile");
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await page.locator("#approval").waitFor({ state: "hidden" });
  await page.locator("#stop").waitFor({ state: "hidden" });
  assert.equal(await readFile(join(workspace, "approved.txt"), "utf8"), "Approved fixture\n");
  await page.locator("#prompt").fill("Wait for cancellation");
  await page.locator("#send").click();
  await page.locator("#stop").click();
  await page.locator("#stop").waitFor({ state: "hidden" });

  await page.locator("#show-preview").click();
  await page.locator("#preview-path").fill("preview.html");
  await page.locator("#preview-open").click();
  await page.frameLocator("#preview-viewport iframe").getByRole("heading", { name: "Local preview is ready" }).waitFor();
  await checkLayout(page, "preview-mobile");
  await page.locator("#preview-refresh").click();
  await page.frameLocator("#preview-viewport iframe").getByRole("heading", { name: "Local preview is ready" }).waitFor();
  await page.locator("#preview-close").click();
  const workspaceBefore = session.current.workspace;
  await page.locator("#workspace-picker").click();
  await page.waitForFunction(() => !(document.getElementById("workspace-picker") as HTMLButtonElement).disabled);
  assert.equal(pickerCalls, 1);
  assert.equal(session.current.workspace, workspaceBefore);
  assert.equal(await page.locator("#workspace-dialog").count(), 0);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator(`[data-session-id="${savedId}"]`).click();
  await page.waitForFunction((id) => document.querySelector(`[data-session-id="${id}"]`)?.getAttribute("aria-current") === "true", savedId);
  assert.equal(session.current.id, savedId);
  await page.locator("#new-chat").click();
  await page.locator("#welcome:not([hidden])").waitFor();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.reload();
  await page.waitForFunction(() => !(document.getElementById("prompt") as HTMLTextAreaElement).disabled);
  assert.equal(await page.evaluate(() => document.getAnimations().length), 0);
  await checkLayout(page, "reduced-motion");
  const noScript = await browser.newPage({ javaScriptEnabled: false, viewport: { width: 390, height: 844 } });
  await noScript.goto(server.origin);
  await noScript.locator("noscript").waitFor();
  assert.match(await noScript.locator("noscript").textContent() ?? "", /Enable JavaScript/);
  assert.equal(await noScript.locator("h1").isVisible(), true);
  await noScript.close();
  assert.deepEqual(errors, []);
  console.log("Verified real Edge: four widths, both themes, all four Cron triggers fit without scrolling, menus/dialogs, mobile focus and Escape, logo/send, approval, cancellation, preview, injected workspace picker, session switching, reduced motion and JavaScript fallback. No model requests.");
} finally {
  await browser?.close();
  if (server) await server.close();
  else await controller?.close();
  const target = resolve(base);
  if (dirname(target) !== temporaryRoot || !basename(target).startsWith("fatcat-design-")) throw new Error("Unexpected fixture cleanup path.");
  await rm(target, { recursive: true, force: true });
}
