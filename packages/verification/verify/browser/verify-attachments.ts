import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { chromium } from "playwright";
import type { Browser } from "playwright";
import { attachmentReference } from "@fatcat/runtime/attachments/record";
import { SessionManager } from "@fatcat/runtime/session/manager";
import { SessionStore } from "@fatcat/runtime/session/store";
import { createTools } from "@fatcat/runtime/tools";
import { WebUiController } from "@fatcat/webui/internal/controller";
import { startWebUiServer } from "@fatcat/webui/internal/server";

// Real Edge and real HTTP/storage, with an offline model and a controlled streaming pause.
const temporaryRoot = await realpath(tmpdir());
const base = await mkdtemp(join(temporaryRoot, "fatcat-attachment-ui-"));
const workspace = join(base, "workspace");
await mkdir(workspace);
const notes = Array.from({ length: 240 }, (_, index) => `Evidence line ${index + 1}`).join("\n");
const notesPath = join(base, "evidence.md");
const slowPath = join(base, "slow.md");
const cancelPath = join(base, "cancel.md");
const pdfPath = join(base, "scan.pdf");
await writeFile(notesPath, notes);
await writeFile(slowPath, "Upload started in project A and finished after switching.");
await writeFile(cancelPath, "This original should never be accepted.");
await writeFile(pdfPath, "%PDF-1.7\nUnparsed fixture");
let citation = "";
const factory = async (root: string) => ({ tools: await createTools(root), maxIterations: 1,
	model: async () => ({ message: { role: "assistant" as const,
		content: `Offline source-link fixture: [Selected evidence](${citation}#L2-L3).` } }) });
const store = new SessionStore({ root: join(base, "sessions") });
const manager = await SessionManager.open(await factory(workspace), { workspace, store,
	deferEmptySessions: true, agentForWorkspace: factory });
const project = await manager.createProject("Research", workspace);
await manager.newSession("Project A", project.id);
await manager.rename("Project A");
const first = manager.current.id;
await manager.newSession("Private", null);
await manager.rename("Private");
const privateId = manager.current.id;
await manager.resume(first);

let paused = false;
let release: (() => void) | undefined;
const upload = manager.uploadAttachment.bind(manager);
manager.uploadAttachment = async (target, body, signal) => upload(target, (async function* () {
	for await (const chunk of body) {
		yield chunk;
		if (target.name === "slow.md" || target.name === "cancel.md") {
			paused = true;
			await new Promise<void>((resolve, reject) => {
				const abort = () => reject(new Error("Cancelled fixture upload."));
				release = () => { signal?.removeEventListener("abort", abort); resolve(); };
				if (signal?.aborted) abort();
				else signal?.addEventListener("abort", abort, { once: true });
			});
		}
	}
})(), signal);
const controller = await WebUiController.create({ workspace, provider: "deepseek", model: "offline",
	permission: "read-only", shellPermission: "deny", webPermission: "deny", maxIterations: 1,
	maxRequestBytes: 262144, skills: 0, warnings: [] }, manager);
const server = await startWebUiServer(controller, 0, async () => workspace);
let browser: Browser | undefined;

async function until(predicate: () => Promise<boolean> | boolean): Promise<void> {
	const deadline = Date.now() + 10_000;
	while (!await predicate()) {
		assert.ok(Date.now() < deadline, "The asynchronous attachment operation should finish within ten seconds.");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

try {
	browser = await chromium.launch({ headless: true, channel: "msedge" });
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(server.url);
	await page.getByRole("button", { name: "Attachments", exact: true }).click();
	await page.getByLabel("Upload files", { exact: true }).setInputFiles(notesPath);
	await until(async () => (await manager.listAttachments(first)).length === 1);
	const file = (await manager.listAttachments(first))[0]!;
	citation = attachmentReference(file);
	const row = page.locator(`[data-attachment-id="${file.id}"]`);
	await row.getByRole("button", { name: "View text", exact: true }).click();
	await page.getByText("Showing lines 1–100 of 240.", { exact: true }).waitFor();
	assert.match(await page.locator("#attachment-source").innerText(), /Other lines have not been shown/);
	assert.match(await page.locator(".attachment-source-text").innerText(), /100 │ Evidence line 100/);
	await page.getByRole("button", { name: "Next lines", exact: true }).click();
	await page.getByText("Showing lines 101–200 of 240.", { exact: true }).waitFor();
	if (process.env.FATCAT_VERIFY_SCREENSHOT) await page.screenshot({ path: resolve(`${process.env.FATCAT_VERIFY_SCREENSHOT}.source.png`), animations: "disabled" });
	await page.getByRole("button", { name: "Close source", exact: true }).click();
	const downloading = page.waitForEvent("download");
	await row.getByRole("button", { name: "Download original", exact: true }).click();
	const downloaded = await downloading;
	assert.equal(downloaded.suggestedFilename(), "evidence.md");
	assert.equal(await readFile((await downloaded.path())!, "utf8"), notes);
	if (process.env.FATCAT_VERIFY_SCREENSHOT) await page.screenshot({ path: resolve(`${process.env.FATCAT_VERIFY_SCREENSHOT}.desktop.png`), animations: "disabled" });
	await page.getByRole("button", { name: "Close attachments", exact: true }).click();
	await page.getByRole("button", { name: "New chat in Research", exact: true }).click();
	await until(() => manager.current.id !== first);
	const second = manager.current.id;
	assert.equal(manager.current.revision, 0);
	await page.getByRole("button", { name: "Attachments", exact: true }).click();
	await page.locator(`[data-attachment-id="${file.id}"]`).waitFor();
	await page.getByRole("button", { name: "Close attachments", exact: true }).click();
	await page.getByLabel("Message Fatcat", { exact: true }).fill("Show a source link");
	await page.getByLabel("Message Fatcat", { exact: true }).press("Enter");
	await page.getByRole("button", { name: "Selected evidence", exact: true }).click();
	await page.getByText("Showing lines 2–3 of 240.", { exact: true }).waitFor();
	assert.equal(await page.locator(".attachment-source-text").innerText(), "2 │ Evidence line 2\n3 │ Evidence line 3");
	await page.getByRole("button", { name: "Close source", exact: true }).click();
	await page.locator(`[data-session-id="${first}"]`).click();
	await until(() => manager.current.id === first);
	await page.getByRole("button", { name: "Attachments", exact: true }).click();
	await page.getByLabel("Upload files", { exact: true }).setInputFiles(slowPath);
	await until(() => paused);
	await page.getByRole("button", { name: "Close attachments", exact: true }).click();
	await page.locator(`[data-session-id="${privateId}"]`).click();
	await until(() => manager.current.id === privateId);
	assert.ok(release);
	release();
	await until(async () => (await manager.listAttachments(first)).length === 2);
	assert.deepEqual(await manager.listAttachments(privateId), []);
	assert.equal(manager.current.id, privateId);
	assert.match(await page.locator("#attachment-uploads").innerText(), /slow\.md → project Research: Saved/);
	await page.getByRole("button", { name: "Attachments", exact: true }).click();
	await page.getByText("No files in this scope yet.", { exact: true }).waitFor();
	paused = false;
	await page.getByLabel("Upload files", { exact: true }).setInputFiles(cancelPath);
	await until(() => paused);
	await page.getByRole("button", { name: "Close attachments", exact: true }).click();
	await page.getByRole("button", { name: "Cancel upload", exact: true }).click();
	await until(async () => !(await readdir(store.root, { recursive: true })).some((path) => String(path).endsWith(".part")));
	assert.deepEqual(await manager.listAttachments(privateId), []);
	await page.getByRole("button", { name: "Attachments", exact: true }).click();
	await page.getByLabel("Upload files", { exact: true }).setInputFiles(pdfPath);
	await until(async () => (await manager.listAttachments(privateId)).length === 1);
	const pdf = (await manager.listAttachments(privateId))[0]!;
	const pdfRow = page.locator(`[data-attachment-id="${pdf.id}"]`);
	await pdfRow.waitFor();
	assert.match(await pdfRow.innerText(), /document parsing available/);
	assert.equal(await pdfRow.getByRole("button", { name: "View text", exact: true }).count(), 0);
	await pdfRow.getByRole("button", { name: "View source", exact: true }).click();
	await page.locator("#attachment-source .session-dialog-error").waitFor();
	assert.match(await page.locator("#attachment-source").innerText(), /corrupt|invalid|failed|PDF/i);
	await page.getByRole("button", { name: "Close source", exact: true }).click();
	await pdfRow.getByRole("button", { name: "Remove from chat", exact: true }).click();
	await page.getByRole("button", { name: "Confirm removal", exact: true }).click();
	await page.locator("#attachment-confirm").waitFor({ state: "hidden" });
	await page.getByText(/Removed from this scope/).waitFor();
	await pdfRow.getByRole("button", { name: "Permanently delete", exact: true }).click();
	await page.getByRole("button", { name: "Delete permanently", exact: true }).click();
	await page.locator("#attachment-confirm").waitFor({ state: "hidden" });
	await page.getByText(/Permanently deleted/).waitFor();
	await page.getByRole("button", { name: "Close attachments", exact: true }).click();
	await page.locator(`[data-session-id="${second}"]`).click();
	await until(() => manager.current.id === second);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByRole("button", { name: "Attachments", exact: true }).click();
	await page.locator(`[data-attachment-id="${file.id}"]`).waitFor();
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
	if (process.env.FATCAT_VERIFY_SCREENSHOT) await page.screenshot({ path: resolve(`${process.env.FATCAT_VERIFY_SCREENSHOT}.mobile.png`), animations: "disabled" });
	await page.locator(`[data-attachment-id="${file.id}"]`).getByRole("button", { name: "Remove from project", exact: true }).click();
	await page.getByRole("button", { name: "Confirm removal", exact: true }).waitFor();
	assert.match(await page.locator("#attachment-confirm").innerText(), /every chat in project Research/);
	await page.locator("#attachment-confirm").getByRole("button", { name: "Cancel", exact: true }).click();
	await page.getByRole("button", { name: "Close attachments", exact: true }).click();
	assert.deepEqual(errors, []);
	console.log("Verified real Edge: upload and download exact originals, project sharing including a new draft chat, private scope isolation, versioned source links and line paging, async upload across session switch, cancellation cleanup, corrupt PDF error, separate remove/delete confirmations, and mobile layout. The model and one stream pause were injected; no live API calls.");
} catch (error) {
	if (browser && process.env.FATCAT_VERIFY_SCREENSHOT) {
		const page = browser.contexts()[0]?.pages()[0];
		await page?.screenshot({ path: resolve(`${process.env.FATCAT_VERIFY_SCREENSHOT}.failure.png`), fullPage: true }).catch(() => {});
	}
	throw error;
} finally {
	release?.();
	await browser?.close();
	await server.close();
	const target = resolve(base);
	if (dirname(target) !== temporaryRoot || !basename(target).startsWith("fatcat-attachment-ui-")) throw new Error("Refusing to remove an unexpected fixture directory.");
	await rm(target, { recursive: true, force: true });
}
