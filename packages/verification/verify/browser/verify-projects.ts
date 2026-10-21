import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { chromium } from "playwright";
import type { BrowserContext, Page } from "playwright";
import { SessionManager } from "@fatcat/runtime/session/manager";
import { SessionStore } from "@fatcat/runtime/session/store";
import { createTools } from "@fatcat/runtime/tools";
import { WebUiController } from "@fatcat/webui/internal/controller";
import { startWebUiServer } from "@fatcat/webui/internal/server";

// Real local Edge, temporary data, injected model and folder selection; no online model requests.
const temporaryRoot = await realpath(tmpdir());
const base = await mkdtemp(join(temporaryRoot, "fatcat-project-ui-"));
const workspace = join(base, "independent");
const projectWorkspace = join(base, "project");
await mkdir(workspace);
await mkdir(projectWorkspace);
await writeFile(join(workspace, "marker.txt"), "Independent marker");
await writeFile(join(projectWorkspace, "marker.txt"), "Project marker");
const factory = async (root: string) => {
	const tools = await createTools(root);
	return { tools, maxIterations: 2, model: async () => ({ message: { role: "assistant" as const,
		content: JSON.stringify(await tools.execute("read", '{"path":"marker.txt"}')) } }) };
};
const store = new SessionStore({ root: join(base, "sessions") });
const manager = await SessionManager.open(await factory(workspace), { workspace, store,
	selection: { name: "Original conversation" }, deferEmptySessions: true, agentForWorkspace: factory });
await manager.run("Original history");
const original = manager.current.id;
const originalHistory = manager.history;
const controller = await WebUiController.create({ workspace, provider: "deepseek", model: "offline", permission: "read-only",
	shellPermission: "deny", webPermission: "deny", maxIterations: 2, maxRequestBytes: 262144, skills: 0, warnings: [] }, manager);
let chosenWorkspace = projectWorkspace;
let server = await startWebUiServer(controller, 0, async () => chosenWorkspace);
const browserProfile = join(base, "browser-profile");
let browser: BrowserContext | undefined;

async function verifyProjectField(page: Page, label: string): Promise<void> {
	const layout = await page.locator("#project-dialog").evaluate((dialog) => {
		const label = dialog.querySelector<HTMLLabelElement>("label")!;
		const field = label.control!;
		const labelBox = label.getBoundingClientRect();
		const fieldBox = field.getBoundingClientRect();
		const style = getComputedStyle(field);
		return { gap: fieldBox.top - labelBox.bottom,
			outline: parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset), focused: document.activeElement === field };
	});
	assert.equal(layout.focused, true);
	assert.ok(layout.gap > layout.outline, `${label}: label clears the focused field outline`);
	if (process.env.FATCAT_VERIFY_SCREENSHOT) await page.screenshot({ path: resolve(`${process.env.FATCAT_VERIFY_SCREENSHOT}.${label}.png`), animations: "disabled" });
}

try {
	browser = await chromium.launchPersistentContext(browserProfile, { headless: true, channel: "msedge", viewport: { width: 1280, height: 900 } });
	const page = await browser.newPage();
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(server.url);
	await page.getByRole("button", { name: "New project", exact: true }).click();
	const createProjectDialog = page.getByRole("dialog", { name: "Create project", exact: true });
	await createProjectDialog.getByLabel("Project name", { exact: true }).fill("Research");
	await verifyProjectField(page, "create-field");
	await createProjectDialog.getByRole("button", { name: "Choose folder", exact: true }).click();
	await page.locator("#project-dialog").waitFor({ state: "hidden" });
	assert.equal(manager.current.id, original);
	const project = controller.snapshot().projects[0]!;
	await page.getByRole("button", { name: "New chat in Research", exact: true }).click();
	await page.waitForFunction((id) => (document.getElementById("workspace-picker") as HTMLButtonElement)?.disabled
		&& document.querySelector(`[data-session-id="${id}"]`)?.getAttribute("aria-current") === "false", original);
	assert.equal(manager.current.revision, 0);
	assert.equal(await page.locator("#workspace-picker").isDisabled(), true);
	await page.getByLabel("Message Fatcat").fill("First project history");
	await page.getByLabel("Message Fatcat").press("Enter");
	await page.waitForFunction(() => document.getElementById("messages")?.textContent?.includes("Project marker"));
	await page.locator("#send").waitFor({ state: "visible" });
	const first = manager.current.id;
	await page.getByRole("button", { name: "New chat in Research", exact: true }).click();
	await page.waitForFunction(() => !document.getElementById("messages")?.textContent);
	await page.getByLabel("Message Fatcat").fill("Second project history");
	await page.getByLabel("Message Fatcat").press("Enter");
	await page.waitForFunction(() => document.getElementById("messages")?.textContent?.includes("Project marker"));
	await page.locator("#send").waitFor({ state: "visible" });
	const second = manager.current.id;
	assert.notEqual(first, second);
	assert.equal(manager.current.projectId, project.id);
	assert.ok(!JSON.stringify(manager.history).includes("First project history"));

	await page.getByRole("button", { name: "Actions for Original conversation", exact: true }).click();
	await page.getByRole("menuitem", { name: "Move to project", exact: true }).click();
	await verifyProjectField(page, "move-field");
	await page.getByRole("button", { name: "Review move", exact: true }).click();
	await page.getByRole("button", { name: "Confirm move", exact: true }).waitFor();
	const preview = page.locator("#project-dialog");
	assert.match(await preview.innerText(), /Future uploads will be shared/);
	assert.ok((await preview.innerText()).includes(workspace));
	assert.ok((await preview.innerText()).includes(projectWorkspace));
	if (process.env.FATCAT_VERIFY_SCREENSHOT) await page.screenshot({ path: resolve(`${process.env.FATCAT_VERIFY_SCREENSHOT}.move.png`) });
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	assert.equal((await store.loadAny(original)).location?.kind, "standalone");
	await page.getByRole("button", { name: "Actions for Original conversation", exact: true }).click();
	await page.getByRole("menuitem", { name: "Move to project", exact: true }).click();
	await page.getByRole("button", { name: "Review move", exact: true }).click();
	await page.getByRole("button", { name: "Confirm move", exact: true }).waitFor();
	const otherTab = await browser.newPage();
	otherTab.on("pageerror", (error) => errors.push(error.message));
	await otherTab.goto(server.url);
	await otherTab.getByRole("button", { name: "Actions for Original conversation", exact: true }).click();
	await otherTab.getByRole("menuitem", { name: "Rename session", exact: true }).click();
	await otherTab.getByLabel("Session name", { exact: true }).fill("Original renamed");
	await otherTab.getByRole("button", { name: "Save name", exact: true }).click();
	await otherTab.locator("#session-action-dialog").waitFor({ state: "hidden" });
	await page.getByRole("button", { name: "Confirm move", exact: true }).click();
	await preview.getByRole("alert").waitFor();
	assert.match(await preview.getByRole("alert").innerText(), /changed|fresh.*preview/i);
	assert.equal((await store.loadAny(original)).location?.kind, "standalone");
	await page.getByRole("button", { name: "Cancel", exact: true }).click();
	await otherTab.close();

	await page.locator(`[data-session-id="${original}"]`).dragTo(page.locator(`[data-project-id="${project.id}"] .project-heading`));
	await page.getByRole("button", { name: "Confirm move", exact: true }).click();
	await preview.waitFor({ state: "hidden" });
	assert.equal(manager.current.id, second);
	assert.deepEqual((await store.loadAny(original)).history, originalHistory);
	assert.equal(await readFile(join(workspace, "marker.txt"), "utf8"), "Independent marker");
	assert.equal(await page.locator(`[data-project-id="${project.id}"] [data-session-id]`).count(), 3);
	await page.getByRole("button", { name: "Collapse Research", exact: true }).click();
	assert.equal(await page.locator(`[data-session-id="${original}"]`).isVisible(), false);
	await page.waitForResponse((response) => response.url().endsWith("/api/state"));
	assert.equal(await page.getByRole("button", { name: "Expand Research", exact: true }).getAttribute("aria-expanded"), "false");
	await page.getByRole("button", { name: "Expand Research", exact: true }).press("Enter");
	assert.equal(await page.locator(`[data-session-id="${original}"]`).isVisible(), true);
	if (process.env.FATCAT_VERIFY_SCREENSHOT) await page.screenshot({ path: resolve(`${process.env.FATCAT_VERIFY_SCREENSHOT}.desktop.png`) });
	await page.locator(`[data-session-id="${original}"]`).click();
	await page.waitForFunction(() => document.getElementById("messages")?.textContent?.includes("Original history"));
	assert.equal(manager.current.workspace, projectWorkspace);

	await page.getByRole("button", { name: "New chat", exact: true }).click();
	await page.waitForFunction(() => !(document.getElementById("workspace-picker") as HTMLButtonElement)?.disabled);
	assert.equal(manager.current.projectId, undefined);
	await page.reload();
	await page.getByRole("button", { name: "New chat in Research", exact: true }).waitFor();
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
	await page.getByRole("button", { name: "Actions for Original renamed", exact: true }).click();
	assert.equal(await page.getByRole("menuitem", { name: "Change workspace", exact: true }).isDisabled(), true);
	assert.equal(await page.getByRole("menuitem", { name: "Move to project", exact: true }).isDisabled(), true);
	await page.keyboard.press("Escape");
	const draft = manager.current.id;
	await page.getByRole("button", { name: "Settings", exact: true }).click();
	await page.getByRole("button", { name: "Move current chat to project", exact: true }).click();
	await verifyProjectField(page, "mobile-move-field");
	await page.getByRole("button", { name: "Review move", exact: true }).click();
	await page.getByRole("button", { name: "Confirm move", exact: true }).waitFor();
	if (process.env.FATCAT_VERIFY_SCREENSHOT) await page.screenshot({ path: resolve(`${process.env.FATCAT_VERIFY_SCREENSHOT}.mobile-move.png`) });
	await page.getByRole("button", { name: "Confirm move", exact: true }).click();
	await preview.waitFor({ state: "hidden" });
	assert.equal(manager.current.id, draft);
	assert.equal(manager.current.revision, 0);
	assert.equal(manager.current.projectId, project.id);
	assert.equal(await page.locator("#show-settings").evaluate((node) => node === document.activeElement), true);
	assert.equal(await page.locator("body").evaluate((node) => node.classList.contains("sidebar-open")), true);
	if (process.env.FATCAT_VERIFY_SCREENSHOT) await page.screenshot({ path: resolve(process.env.FATCAT_VERIFY_SCREENSHOT) });
	await page.setViewportSize({ width: 1280, height: 900 });
	chosenWorkspace = join(base, "archive");
	await mkdir(chosenWorkspace);
	await page.getByRole("button", { name: "New project", exact: true }).click();
	await createProjectDialog.getByLabel("Project name", { exact: true }).fill("Archive");
	await createProjectDialog.getByRole("button", { name: "Choose folder", exact: true }).click();
	await preview.waitFor({ state: "hidden" });
	await page.getByRole("button", { name: "Collapse Research", exact: true }).click();
	await page.getByRole("button", { name: "Collapse Archive", exact: true }).click();
	const density = await page.evaluate(() => {
		const label = document.querySelector(".projects-label")!.getBoundingClientRect();
		const search = document.querySelector(".session-search")!.getBoundingClientRect();
		const groups = [...document.querySelectorAll(".project-group")].map((group) => group.getBoundingClientRect());
		const chats = document.querySelector(".independent-sessions .section-label")!.getBoundingClientRect();
		return { searchGap: search.top - label.bottom, firstGap: groups[0]!.top - search.bottom, betweenGap: groups[1]!.top - groups[0]!.bottom,
			lastGap: chats.top - groups.at(-1)!.bottom, heights: groups.map((group) => group.height) };
	});
	assert.ok(density.searchGap <= 8 && density.firstGap <= 8 && density.betweenGap <= 8 && density.lastGap <= 16,
		`Collapsed project navigation stays compact: ${JSON.stringify(density)}`);
	assert.ok(density.heights.every((height) => height <= 40));
	await page.locator("#session-search").fill("Research");
	assert.equal(await page.locator(`[data-project-id="${project.id}"] .project-sessions`).isVisible(), true);
	assert.equal(await page.getByRole("button", { name: "Collapse Research", exact: true }).isDisabled(), true);
	assert.equal(await page.getByRole("button", { name: "Expand Archive", exact: true }).count(), 0);
	await page.locator("#clear-session-search").click();
	await page.getByRole("button", { name: "Expand Research", exact: true }).waitFor();
	await page.getByRole("button", { name: "Expand Archive", exact: true }).waitFor();
	if (process.env.FATCAT_VERIFY_SCREENSHOT) await page.screenshot({ path: resolve(`${process.env.FATCAT_VERIFY_SCREENSHOT}.collapsed.png`) });
	await page.reload();
	await page.getByRole("button", { name: "Expand Research", exact: true }).waitFor();
	await page.getByRole("button", { name: "Expand Archive", exact: true }).click();
	const port = Number(new URL(server.origin).port);
	await browser.close();
	await server.close();
	const reopened = await SessionManager.open(await factory(workspace), { workspace, store,
		deferEmptySessions: true, agentForWorkspace: factory });
	const restarted = await WebUiController.create(controller.snapshot().info, reopened);
	server = await startWebUiServer(restarted, port, async () => chosenWorkspace);
	browser = await chromium.launchPersistentContext(browserProfile, { headless: true, channel: "msedge", viewport: { width: 1280, height: 900 } });
	const restored = await browser.newPage();
	restored.on("pageerror", (error) => errors.push(error.message));
	await restored.goto(server.url);
	await restored.getByRole("button", { name: "Expand Research", exact: true }).waitFor();
	await restored.getByRole("button", { name: "Collapse Archive", exact: true }).waitFor();
	assert.equal(await restored.locator(`[data-project-id="${project.id}"] .project-sessions`).isVisible(), false);
	if (process.env.FATCAT_VERIFY_SCREENSHOT) await restored.screenshot({ path: resolve(`${process.env.FATCAT_VERIFY_SCREENSHOT}.restored.png`), animations: "disabled" });
	const withoutStorage = await browser.newPage();
	withoutStorage.on("pageerror", (error) => errors.push(error.message));
	await withoutStorage.addInitScript(() => {
		Object.defineProperty(window, "localStorage", { get() { throw new DOMException("Storage unavailable", "SecurityError"); } });
	});
	await withoutStorage.goto(server.url);
	await withoutStorage.getByRole("button", { name: "Collapse Research", exact: true }).click();
	await withoutStorage.getByRole("button", { name: "Expand Research", exact: true }).waitFor();
	assert.deepEqual(errors, []);
	console.log("Verified real Edge: project creation, grouped chats, separate histories, workspace binding, menu cancellation, stale confirmation across tabs, drag confirmation, inactive-session migration, independent chat, mobile controls, collapse preferences after page reload and browser/server restart, and storage-unavailable fallback. Models and folder selection were injected.");
} catch (error) {
	if (browser && process.env.FATCAT_VERIFY_SCREENSHOT) {
		const pages = browser.pages();
		for (let index = 0; index < pages.length; index++) {
			await pages[index]!.screenshot({ path: resolve(`${process.env.FATCAT_VERIFY_SCREENSHOT}.failure-${index}.png`) }).catch(() => {});
		}
	}
	throw error;
} finally {
	await browser?.close();
	await server.close();
	const target = resolve(base);
	if (dirname(target) !== temporaryRoot || !basename(target).startsWith("fatcat-project-ui-")) throw new Error("Unexpected fixture cleanup path.");
	await rm(target, { recursive: true, force: true });
}
