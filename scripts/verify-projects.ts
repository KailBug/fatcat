import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { chromium } from "playwright";
import type { Browser } from "playwright";
import { SessionManager } from "../src/session/manager.js";
import { SessionStore } from "../src/session/store.js";
import { createTools } from "../src/tools.js";
import { WebUiController } from "../webui/controller.js";
import { startWebUiServer } from "../webui/server.js";

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
	return { tools, maxIterations: 2, model: async () => ({ toolCalls: [], message: { role: "assistant" as const,
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
const server = await startWebUiServer(controller, 0, async () => projectWorkspace);
let browser: Browser | undefined;
try {
	browser = await chromium.launch({ headless: true, channel: "msedge" });
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(server.url);
	await page.getByRole("button", { name: "New project", exact: true }).click();
	const createProjectDialog = page.getByRole("dialog", { name: "Create project", exact: true });
	await createProjectDialog.getByLabel("Project name", { exact: true }).fill("Research");
	await createProjectDialog.getByRole("button", { name: "Choose folder", exact: true }).click();
	await page.locator("#project-dialog").waitFor({ state: "hidden" });
	assert.equal(manager.current.id, original);
	const project = controller.snapshot().projects[0]!;
	await page.getByRole("button", { name: "New chat in Research", exact: true }).click();
	await page.waitForFunction((id) => document.getElementById("current-project")?.textContent === "Research"
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
	if (process.env.FATCAT_VERIFY_SCREENSHOT) await page.screenshot({ path: resolve(`${process.env.FATCAT_VERIFY_SCREENSHOT}.desktop.png`) });
	await page.locator(`[data-session-id="${original}"]`).click();
	await page.waitForFunction(() => document.getElementById("messages")?.textContent?.includes("Original history"));
	assert.equal(manager.current.workspace, projectWorkspace);

	await page.getByRole("button", { name: "New chat", exact: true }).click();
	await page.waitForFunction(() => document.getElementById("current-project")?.textContent === "Independent chat");
	assert.equal(manager.current.projectId, undefined);
	await page.reload();
	await page.getByRole("button", { name: "New chat in Research", exact: true }).waitFor();
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
	await page.getByRole("button", { name: "Actions for Original renamed", exact: true }).click();
	assert.equal(await page.getByRole("menuitem", { name: "Change workspace", exact: true }).isDisabled(), true);
	assert.equal(await page.getByRole("menuitem", { name: "Move to project", exact: true }).isDisabled(), true);
	await page.keyboard.press("Escape");
	await page.locator("#close-sidebar").click();
	const draft = manager.current.id;
	await page.getByRole("button", { name: "Move current chat to project", exact: true }).click();
	await page.getByRole("button", { name: "Review move", exact: true }).click();
	await page.getByRole("button", { name: "Confirm move", exact: true }).waitFor();
	if (process.env.FATCAT_VERIFY_SCREENSHOT) await page.screenshot({ path: resolve(`${process.env.FATCAT_VERIFY_SCREENSHOT}.mobile-move.png`) });
	await page.getByRole("button", { name: "Confirm move", exact: true }).click();
	await preview.waitFor({ state: "hidden" });
	assert.equal(manager.current.id, draft);
	assert.equal(manager.current.revision, 0);
	assert.equal(manager.current.projectId, project.id);
	await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
	if (process.env.FATCAT_VERIFY_SCREENSHOT) await page.screenshot({ path: resolve(process.env.FATCAT_VERIFY_SCREENSHOT) });
	assert.deepEqual(errors, []);
	console.log("Verified real Edge: project creation, grouped chats, separate histories, workspace binding, menu cancellation, stale confirmation across tabs, drag confirmation, inactive-session migration, independent chat and mobile controls. Models and folder selection were injected.");
} catch (error) {
	if (browser && process.env.FATCAT_VERIFY_SCREENSHOT) {
		const pages = browser.contexts().flatMap((context) => context.pages());
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
