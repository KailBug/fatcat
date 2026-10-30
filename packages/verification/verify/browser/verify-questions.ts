import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { chromium } from "playwright";
import type { Browser } from "playwright";
import { withAskUser } from "@fatcat/runtime/tools/ask-user";
import { createTools } from "@fatcat/runtime/tools";
import { SessionManager } from "@fatcat/runtime/session/manager";
import { SessionStore } from "@fatcat/runtime/session/store";
import { WebUiController } from "@fatcat/webui/internal/controller";
import { startWebUiServer } from "@fatcat/webui/internal/server";

const root = await realpath(tmpdir());
const workspace = await mkdtemp(join(root, "fatcat-questions-ui-"));
let controller: WebUiController | undefined;
let server: Awaited<ReturnType<typeof startWebUiServer>> | undefined;
let browser: Browser | undefined;
try {
	const tools = withAskUser(await createTools(workspace), (request, signal) => controller!.askUser(request, signal));
	const manager = await SessionManager.open({ tools, maxIterations: 2, model: async (messages) => {
		if (messages.at(-1)?.role === "user") return { message: { role: "assistant", content: null,
			toolCalls: [{ id: "question", name: "ask_user", arguments: JSON.stringify({ question: "Which output format?", options: ["Text", "JSON", "Long option ".repeat(16), "x".repeat(200)] }) }] } };
		return { message: { role: "assistant", content: String(messages.at(-1)?.content) } };
	} }, { workspace, store: new SessionStore({ root: join(workspace, "sessions") }) });
	controller = await WebUiController.create({ workspace, provider: "deepseek", model: "injected", permission: "read-only",
		shellPermission: "deny", webPermission: "deny", maxIterations: 2, maxRequestBytes: 262144, skills: 0, warnings: [] }, manager);
	server = await startWebUiServer(controller, 0);
	browser = await chromium.launch({ headless: true, channel: "msedge" });
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(server.url);
	for (const mode of ["choice", "skip", "cancel"]) {
		await page.getByLabel("Message Fatcat", { exact: true }).fill(`Question ${mode}`);
		await page.locator("#send").click();
		const input = page.getByLabel("Your answer", { exact: true });
		await input.waitFor({ state: "visible" });
		assert.equal(await input.evaluate((element) => element === document.activeElement), true);
		assert.equal(controller.snapshot().approval, null);
		if (mode === "choice") {
			await page.getByRole("button", { name: "JSON", exact: true }).click();
			assert.equal(await input.inputValue(), "JSON");
			await input.fill("Custom JSON answer");
			const revision = controller.snapshot().revision;
			// Repeated state refresh must preserve typed input and focus.
			await page.evaluate(async () => { await new Promise((resolve) => setTimeout(resolve, 1200)); });
			assert.equal(await input.inputValue(), "Custom JSON answer");
			assert.ok(controller.snapshot().revision >= revision);
			await page.getByRole("button", { name: "Send answer", exact: true }).click();
		} else if (mode === "skip") {
			await page.setViewportSize({ width: 390, height: 844 });
			assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
			await page.getByRole("button", { name: "Skip", exact: true }).click();
		} else await page.locator("#stop").click();
		await input.waitFor({ state: "hidden" });
		await page.waitForFunction(() => !document.querySelector("#send")?.hasAttribute("hidden"));
		assert.equal(controller.snapshot().question, null);
		if (mode === "choice") assert.match(controller.snapshot().turns.at(-1)!.answer!, /Custom JSON answer/);
		if (mode === "skip") assert.match(controller.snapshot().turns.at(-1)!.answer!, /skipped/);
	}
	assert.equal(manager.history.filter((message) => message.role === "user").length, 2);
	assert.deepEqual(errors, []);
	console.log("Verified real Edge desktop/mobile: fresh questions, choices plus free text, preserved answer during polling, skip, cancellation, no approval grants and no page errors. Injected model only.");
} finally {
	await browser?.close();
	if (server) await server.close(); else await controller?.close();
	const target = resolve(workspace);
	if (dirname(target) !== root || !basename(target).startsWith("fatcat-questions-ui-")) throw new Error("Unexpected fixture cleanup target");
	await rm(target, { recursive: true, force: true });
}
