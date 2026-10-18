import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { SessionManager } from "@fatcat/runtime/session/manager";
import { SessionStore } from "@fatcat/runtime/session/store";
import { createTools } from "@fatcat/runtime/tools";
import { WebUiController } from "@fatcat/webui/internal/controller";
import { startWebUiServer } from "@fatcat/webui/internal/server";

// Real Edge and persistent local fixtures; the model and folder-selection result are injected.
const temporaryRoot = await realpath(tmpdir());
const base = await mkdtemp(join(temporaryRoot, "fatcat-project-management-"));
const workspace = join(base, "original");
const destination = join(base, "destination");
await mkdir(workspace);
await mkdir(destination);
await writeFile(join(workspace, "marker.txt"), "Original project files");
await writeFile(join(destination, "marker.txt"), "Destination project files");
const factory = async (path: string) => {
	const tools = await createTools(path);
	return { tools, maxIterations: 1, model: async () => ({ toolCalls: [], message: { role: "assistant" as const,
		content: JSON.stringify(await tools.execute("read", '{"path":"marker.txt"}')) } }) };
};
const store = new SessionStore({ root: join(base, "sessions") });
const manager = await SessionManager.open(await factory(workspace), { workspace, store,
	deferEmptySessions: true, agentForWorkspace: factory });
const project = await manager.createProject("Research", workspace);
await manager.newSession("First", project.id);
await manager.run("First history");
const first = manager.current.id;
const originalHistory = manager.history;
await manager.newSession("Second", project.id);
await manager.run("Second history");
const second = manager.current.id;
const upload = async (sessionId: string, name: string) => {
	const target = await manager.beginAttachmentUpload(sessionId, name, 7);
	return manager.uploadAttachment(target, (async function* () { yield Buffer.from("fixture"); })());
};
await upload(first, "project-only.md");
await manager.newSession("Shared source", null);
const sharedSession = manager.current.id;
const shared = await upload(sharedSession, "retained.md");
await manager.fork("Outside fork");
const external = manager.current.id;
await manager.joinProject(await manager.previewProjectJoin(project.id, sharedSession));
await manager.resume(first);
const controller = await WebUiController.create({ workspace, provider: "deepseek", model: "offline", permission: "read-only",
	shellPermission: "deny", webPermission: "deny", maxIterations: 1, maxRequestBytes: 262144, skills: 0, warnings: [] }, manager);
const server = await startWebUiServer(controller, 0, async () => destination);
let browser: Browser | undefined;

async function menu(page: Page, name: string, action: string): Promise<void> {
	await page.getByRole("button", { name: `Actions for project ${name}`, exact: true }).click();
	await page.locator("#project-menu").getByRole("menuitem", { name: action, exact: true }).click();
}

async function rename(page: Page, before: string, after: string): Promise<void> {
	await menu(page, before, "Rename project");
	await page.locator("#project-action-name").fill(after);
	if (process.env.FATCAT_VERIFY_SCREENSHOT) await page.screenshot({ path: resolve(`${process.env.FATCAT_VERIFY_SCREENSHOT}.rename.png`), animations: "disabled" });
	await page.getByRole("button", { name: "Save project name", exact: true }).click();
	await page.locator("#project-action-dialog").waitFor({ state: "hidden" });
	await page.getByRole("button", { name: `Actions for project ${after}`, exact: true }).waitFor();
}

try {
	browser = await chromium.launch({ headless: true, channel: "msedge" });
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(server.url);
	const more = page.getByRole("button", { name: "Actions for project Research", exact: true });
	await more.focus();
	await more.press("ArrowDown");
	assert.equal(await page.locator("#project-menu [data-action=rename]").evaluate((element) => document.activeElement === element), true);
	await page.keyboard.press("End");
	assert.equal(await page.locator("#project-menu [data-action=delete]").evaluate((element) => document.activeElement === element), true);
	await page.keyboard.press("Escape");
	assert.equal(await more.evaluate((element) => document.activeElement === element), true);
	await rename(page, "Research", "Renamed research");
	assert.equal(manager.current.id, first);
	assert.deepEqual(manager.history, originalHistory);
	await menu(page, "Renamed research", "Change workspace");
	await page.getByRole("button", { name: "Choose folder", exact: true }).click();
	await page.getByRole("button", { name: "Confirm workspace change", exact: true }).waitFor();
	const actionDialog = page.locator("#project-action-dialog");
	assert.ok((await actionDialog.innerText()).includes(workspace));
	assert.ok((await actionDialog.innerText()).includes(destination));
	assert.match(await actionDialog.innerText(), /3 saved chat\(s\)/);
	assert.match(await actionDialog.innerText(), /Files in either workspace are not moved, copied or deleted/);
	if (process.env.FATCAT_VERIFY_SCREENSHOT) await page.screenshot({ path: resolve(`${process.env.FATCAT_VERIFY_SCREENSHOT}.workspace.png`), animations: "disabled" });
	await actionDialog.getByRole("button", { name: "Cancel", exact: true }).click();
	assert.equal(manager.current.workspace, workspace);
	await menu(page, "Renamed research", "Change workspace");
	await page.getByRole("button", { name: "Choose folder", exact: true }).click();
	await page.getByRole("button", { name: "Confirm workspace change", exact: true }).click();
	await actionDialog.waitFor({ state: "hidden" });
	assert.equal(manager.current.workspace, destination);
	assert.equal((await store.loadAny(second)).workspace, destination);
	assert.deepEqual(manager.history, originalHistory);
	await page.getByLabel("Message Fatcat", { exact: true }).fill("Check the new project folder");
	await page.getByLabel("Message Fatcat", { exact: true }).press("Enter");
	await page.waitForFunction(() => document.getElementById("messages")?.textContent?.includes("Destination project files"));
	await page.locator("#send").waitFor({ state: "visible" });
	await menu(page, "Renamed research", "Delete project");
	await page.getByRole("button", { name: "Delete project and data", exact: true }).waitFor();
	assert.match(await actionDialog.innerText(), /3 saved chat\(s\)/);
	assert.match(await actionDialog.innerText(), /2 project attachment original\(s\).*1 will be permanently deleted; 1 referenced outside/);
	const other = await browser.newPage();
	other.on("pageerror", (error) => errors.push(error.message));
	await other.goto(server.url);
	await rename(other, "Renamed research", "Latest research");
	await page.getByRole("button", { name: "Delete project and data", exact: true }).click();
	await actionDialog.getByRole("alert").waitFor();
	assert.match(await actionDialog.getByRole("alert").innerText(), /changed|review|refresh/i);
	assert.equal((await manager.listProjects()).length, 1);
	await actionDialog.getByRole("button", { name: "Cancel", exact: true }).click();
	await other.close();
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
	await menu(page, "Latest research", "Delete project");
	await page.getByRole("button", { name: "Delete project and data", exact: true }).waitFor();
	assert.match(await actionDialog.innerText(), /workspace folder and its files will remain untouched/);
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
	if (process.env.FATCAT_VERIFY_SCREENSHOT) await page.screenshot({ path: resolve(`${process.env.FATCAT_VERIFY_SCREENSHOT}.delete-mobile.png`), animations: "disabled" });
	await page.getByRole("button", { name: "Delete project and data", exact: true }).click();
	await actionDialog.waitFor({ state: "hidden" });
	assert.equal(manager.current.projectId, undefined);
	assert.equal(manager.current.revision, 0);
	assert.deepEqual(manager.history, []);
	assert.equal((await manager.listProjects()).length, 0);
	for (const id of [first, second, sharedSession]) await assert.rejects(store.loadAny(id));
	assert.equal((await manager.listAttachments(external))[0]!.id, shared.id);
	assert.equal(await readFile(join(workspace, "marker.txt"), "utf8"), "Original project files");
	assert.equal(await readFile(join(destination, "marker.txt"), "utf8"), "Destination project files");
	assert.deepEqual(errors, []);
	console.log("Verified real Edge: project menu keyboard/focus, revision-bound rename, native-picker workspace preview/cancel/confirm, all-member workspace updates and independent histories, stale delete preview across tabs, retained external attachment references, mobile delete confirmation, independent welcome after deletion, and untouched workspace files. Model and folder selection were injected.");
} catch (error) {
	if (browser && process.env.FATCAT_VERIFY_SCREENSHOT) {
		await browser.contexts()[0]?.pages()[0]?.screenshot({ path: resolve(`${process.env.FATCAT_VERIFY_SCREENSHOT}.failure.png`), fullPage: true, animations: "disabled" }).catch(() => {});
	}
	throw error;
} finally {
	await browser?.close();
	await server.close();
	const target = resolve(base);
	if (dirname(target) !== temporaryRoot || !basename(target).startsWith("fatcat-project-management-")) throw new Error("Refusing to remove an unexpected fixture directory.");
	await rm(target, { recursive: true, force: true });
}
