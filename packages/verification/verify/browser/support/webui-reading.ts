import assert from "node:assert/strict";
import type { Page } from "playwright";

/** Verify clipboard contents and recovery through the served conversation controls. */
export async function verifyConversationCopy(page: Page, answer: string,
	checkLayout: (page: Page, label: string) => Promise<void>): Promise<void> {
	await page.setViewportSize({ width: 320, height: 480 });
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	// Windows clipboard text uses CRLF even when writeText receives LF.
	const clipboardText = () => page.evaluate(async () => (await navigator.clipboard.readText()).replace(/\r\n/g, "\n"));
	const code = page.locator(".answer pre code").last();
	const codeCopy = page.getByRole("button", { name: "Copy code", exact: true }).last();
	await codeCopy.click();
	await page.waitForFunction(() => [...document.querySelectorAll(".code-header .copy-button")].at(-1)?.textContent === "Copied");
	assert.equal(await clipboardText(), await code.textContent());
	const answerCopy = page.getByRole("button", { name: "Copy answer", exact: true }).last();
	await answerCopy.focus();
	await page.keyboard.press("Enter");
	await page.waitForFunction(() => [...document.querySelectorAll(".answer-actions .copy-button")].at(-1)?.textContent === "Copied");
	assert.equal(await clipboardText(), answer.replace(/\r\n/g, "\n"), "Answer copy preserves Markdown and excludes activity/report text");
	await page.waitForResponse((response) => response.url().endsWith("/api/state"));
	assert.equal(await answerCopy.evaluate((button) => button === document.activeElement), true, "Polling preserves the focused copy control");

	await page.evaluate(() => {
		const clipboard = navigator.clipboard as Clipboard & { restoreWrite?: () => void };
		const write = clipboard.writeText.bind(clipboard);
		clipboard.restoreWrite = () => { clipboard.writeText = write; delete clipboard.restoreWrite; };
		clipboard.writeText = async () => { throw new DOMException("Fixture denied", "NotAllowedError"); };
	});
	try {
		await codeCopy.click();
		await page.locator(".code-header .copy-error").last().waitFor();
		assert.match(await page.locator(".code-header .copy-error").last().textContent() ?? "", /Try again.*manually/);
		assert.equal(await codeCopy.textContent(), "Copy code", "Denied clipboard access never reports success");
		assert.equal(await page.locator(".code-label").last().evaluate((label) => {
			const range = document.createRange(); range.selectNodeContents(label);
			return range.getClientRects().length;
		}), 1, "A copy error must not squeeze a short language label onto multiple lines");
		await checkLayout(page, "copy-denied-mobile");
	} finally {
		await page.evaluate(() => (navigator.clipboard as Clipboard & { restoreWrite: () => void }).restoreWrite());
	}
	await codeCopy.click();
	await page.waitForFunction(() => [...document.querySelectorAll(".code-header .copy-button")].at(-1)?.textContent === "Copied");
	assert.equal(await page.locator(".copy-error").count(), 0, "Retry clears the failure message");
	assert.equal(await clipboardText(), await code.textContent());
	await checkLayout(page, "copy-success-mobile");
	await page.locator("#prompt").focus();
}

/** Keep the background unreachable in overlay mode, including through the sandboxed frame. */
export async function verifyPreviewKeyboard(page: Page): Promise<void> {
	await page.setViewportSize({ width: 390, height: 768 });
	assert.equal(await page.locator("#file-preview").evaluate((panel) => panel.matches(":modal")), true);
	await page.locator("#preview-close").focus();
	for (let step = 0; step < 9; step++) {
		await page.keyboard.press("Tab");
		// Native dialogs allow visiting browser chrome (activeElement becomes body), never background controls.
		assert.equal(await page.evaluate(() => document.activeElement === document.body ||
			document.getElementById("file-preview")!.contains(document.activeElement)), true,
			"Overlay Tab navigation cannot reach background page controls");
	}
	await page.evaluate(() => document.getElementById("prompt")!.focus());
	assert.equal(await page.locator("#prompt").evaluate((input) => input === document.activeElement), false,
		"Even programmatic focus cannot enter the background of a modal preview");
	await page.locator("#preview-path").focus();
	await page.frameLocator("#preview-viewport iframe").getByRole("button", { name: "Preview action" })
		.evaluate((button) => { button.dataset.preserved = "true"; });
	await page.setViewportSize({ width: 1440, height: 768 });
	await page.waitForFunction(() => !document.getElementById("file-preview")!.matches(":modal"));
	assert.equal(await page.locator("#preview-path").evaluate((input) => document.activeElement === input), true);
	await page.locator("#prompt").fill("Keep preview draft");
	await page.setViewportSize({ width: 390, height: 768 });
	await page.waitForFunction(() => document.getElementById("file-preview")!.matches(":modal"));
	assert.equal(await page.evaluate(() => document.getElementById("file-preview")!.contains(document.activeElement)), true);
	assert.equal(await page.frameLocator("#preview-viewport iframe").getByRole("button", { name: "Preview action" })
		.getAttribute("data-preserved"), "true", "Resizing preserves the loaded document, not only its URL");
	await page.frameLocator("#preview-viewport iframe").getByRole("button", { name: "Preview action" }).focus();
	// The sandboxed document owns its key events; Tab must offer a path back to host controls.
	await page.keyboard.press("Shift+Tab");
	assert.equal(await page.locator("#preview-refresh").evaluate((button) => button === document.activeElement), true);
	await page.keyboard.press("Escape");
	await page.locator("#file-preview").waitFor({ state: "hidden" });
	assert.equal(await page.locator("#show-preview").evaluate((button) => document.activeElement === button), true);
	assert.equal(await page.locator("#prompt").inputValue(), "Keep preview draft");
	assert.equal(await page.locator("#preview-viewport iframe").count(), 0, "Closing disposes the isolated preview");
	await page.locator("#prompt").fill("");
	await page.locator("#show-preview").click();
	await page.frameLocator("#preview-viewport iframe").getByRole("button", { name: "Preview action" }).waitFor();
	await page.locator("#preview-path").focus();
	await page.keyboard.press("Escape");
	await page.locator("#file-preview").waitFor({ state: "hidden" });
	await page.locator("#show-preview").click();
	await page.frameLocator("#preview-viewport iframe").getByRole("button", { name: "Preview action" }).waitFor();
	await page.route("**/api/state", (route) => route.abort());
	try {
		await page.waitForFunction(() => document.getElementById("connection")?.textContent === "Disconnected");
		await page.locator("#preview-close").click();
		assert.equal(await page.locator("#scroll-area").evaluate((node) => document.activeElement === node), true,
			"Closing an offline preview retains focus on the reading area");
	} finally {
		await page.unroute("**/api/state");
	}
	await page.waitForFunction(() => document.getElementById("connection")?.textContent === "Local");
	await page.locator("#show-preview").click();
	await page.frameLocator("#preview-viewport iframe").getByRole("button", { name: "Preview action" }).waitFor();
}
