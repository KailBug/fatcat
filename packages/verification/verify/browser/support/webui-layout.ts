import assert from "node:assert/strict";
import type { Page } from "playwright";

export async function verifyComposerMotion(page: Page, checkLayout: (page: Page, label: string) => Promise<void>): Promise<void> {
	const composer = page.locator("#composer");
	const prompt = page.locator("#prompt");
	const wake = page.getByRole("button", { name: "Expand message box", exact: true });
	const turns = await page.locator(".turn").count();
	for (const width of [1440, 390, 320]) {
		await page.emulateMedia({ colorScheme: width === 390 ? "dark" : "light" });
		await page.setViewportSize({ width, height: width < 760 ? 640 : 900 });
		await prompt.fill("");
		await page.mouse.move(0, 0);
		await page.waitForTimeout(1500);
		assert.notEqual(await composer.getAttribute("data-collapsed"), "true", "Focused empty input stays open");
		await page.locator("#show-preview").focus();
		await composer.hover();
		await page.waitForTimeout(1500);
		assert.notEqual(await composer.getAttribute("data-collapsed"), "true", "Pointer inside the composer keeps it open");
		await page.mouse.move(0, 0);
		await page.waitForFunction(() => document.querySelector("#composer")?.getAttribute("data-collapsed") === "true");
		await page.waitForFunction(() => document.querySelector("#composer-input")!.getBoundingClientRect().height < 1);
		await composer.evaluate(async (node) => { await Promise.all(node.getAnimations({ subtree: true }).map((animation) => animation.finished)); });
		await checkLayout(page, `composer-asleep-${width}`);
		assert.equal(await page.locator("#composer-input").evaluate((node) => node instanceof HTMLElement && node.inert), true);
		assert.equal(await page.locator("#wake-composer img").evaluate((node) => node instanceof HTMLImageElement && node.complete && node.naturalWidth > 0), true);
		assert.ok(await composer.evaluate((node) => node.getBoundingClientRect().height <= 64), "Collapsed composer is a single toolbar");
		await wake.focus();
		await page.keyboard.press("Enter");
		assert.equal(await prompt.evaluate((node) => document.activeElement === node), true);
		await page.waitForFunction(() => document.querySelector("#composer-input")!.getBoundingClientRect().height >= 43);
		await composer.evaluate(async (node) => { await Promise.all(node.getAnimations({ subtree: true }).map((animation) => animation.finished)); });
		assert.equal(await page.locator(".turn").count(), turns, "Waking the composer never submits a message");
		await checkLayout(page, `composer-awake-${width}`);
	}
	await prompt.fill("Keep this unsent draft.");
	await page.locator("#show-preview").focus();
	await page.mouse.move(0, 0);
	await page.waitForTimeout(1500);
	assert.notEqual(await composer.getAttribute("data-collapsed"), "true", "A nonempty draft prevents sleep");
	assert.equal(await prompt.inputValue(), "Keep this unsent draft.");
	await prompt.fill("");
	await page.locator("#show-preview").focus();
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.waitForFunction(() => document.querySelector("#composer")?.getAttribute("data-collapsed") === "true");
	assert.equal(await composer.evaluate((node) => node.getAnimations({ subtree: true }).length), 0);
	await wake.click();
	assert.equal(await prompt.evaluate((node) => document.activeElement === node), true);
	await page.emulateMedia({ reducedMotion: "no-preference" });
}

export async function verifyNavigationSettings(page: Page, checkLayout: (page: Page, label: string) => Promise<void>): Promise<void> {
	assert.equal(await page.locator("#current-project,.local-tag,.new-chat,.composer-footer,.footnote").count(), 0);
	assert.equal(await page.locator("#composer #show-attachments,#composer #model,#composer #context-usage").count(), 3);
	assert.equal(await page.locator("#context-usage").innerText(), "");
	assert.equal(await page.locator("#connection").innerText(), "Local");
	for (const width of [1440, 390, 320]) {
		await page.setViewportSize({ width, height: 768 });
		if (width < 760) await page.locator("#toggle-sidebar").click();
		await page.locator("#show-settings").click();
		const appearance = page.locator("#settings-panel summary");
		if (await page.locator("#settings-panel details").getAttribute("open") === null) await appearance.press("Enter");
		await page.getByLabel("Dark", { exact: true }).check();
		assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
		await page.setViewportSize({ width, height: 480 });
		assert.equal(await page.locator("#settings-panel").evaluate((node) => node.matches(":modal")), true);
		// The entrance intentionally translates the dialog; measure its settled geometry.
		await page.waitForFunction(() => document.querySelector("#settings-panel")!.getAnimations()
			.every((animation) => animation.playState === "finished"));
		await checkLayout(page, `settings-short-${width}`);
		await page.setViewportSize({ width, height: 768 });
		await checkLayout(page, `settings-dark-${width}`);
		const dialog = await page.locator("#settings-panel").evaluate((node) => {
			const box = node.getBoundingClientRect();
			return { modal: node.matches(":modal"), x: box.left + box.width / 2 - innerWidth / 2,
				y: box.top + box.height / 2 - innerHeight / 2, transform: getComputedStyle(node).transform,
				animations: node.getAnimations().map((animation) => ({ state: animation.playState, time: animation.currentTime })) };
		});
		assert.equal(dialog.modal, true, "Settings blocks background interaction");
		assert.ok(Math.abs(dialog.x) <= 1 && Math.abs(dialog.y) <= 1, `Settings is centered in the whole viewport: ${JSON.stringify(dialog)}`);
		await page.locator("#close-settings").focus();
		await page.keyboard.press("Shift+Tab");
		assert.equal(await page.locator("#settings-panel button:not(:disabled)").last().evaluate((node) => node === document.activeElement), true,
			`Reverse tab must remain in Settings; focused ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 160))}`);
		await page.keyboard.press("Tab");
		assert.equal(await page.locator("#close-settings").evaluate((node) => node === document.activeElement), true);
		await page.getByLabel("Light", { exact: true }).check();
		assert.equal(await page.locator("html").getAttribute("data-theme"), "light");
		await page.getByLabel("System", { exact: true }).check();
		await page.emulateMedia({ colorScheme: "dark" });
		await page.waitForFunction(() => document.documentElement.dataset.theme === "dark");
		await page.emulateMedia({ colorScheme: "light" });
		await page.waitForFunction(() => document.documentElement.dataset.theme === "light");
		await page.keyboard.press("Escape");
		assert.equal(await page.locator("#show-settings").evaluate((node) => node === document.activeElement), true);
		await page.locator("#show-settings").click();
		await page.locator("#close-settings").click();
		assert.equal(await page.locator("#settings-panel").isVisible(), false);
		assert.equal(await page.locator("#show-settings").evaluate((node) => node === document.activeElement), true);
		await page.locator("#show-settings").click();
		await page.locator("#settings-session").click();
		await page.locator("#details[open]").waitFor();
		assert.match(await page.locator("#details-content").innerText(), /Provider/);
		assert.equal(await page.locator("#details-content dt", { hasText: "Saved locally" }).evaluate((node) => node.nextElementSibling?.textContent), "No");
		await page.setViewportSize({ width, height: 480 });
		await checkLayout(page, `details-top-${width}`);
		const detailsLayout = await page.locator("#details").evaluate((node) => {
			const scroll = node.querySelector<HTMLElement>(".details-scroll")!;
			const shell = node.getBoundingClientRect();
			const content = scroll.getBoundingClientRect();
			return { shellScroll: node.scrollHeight > node.clientHeight, contentScroll: scroll.scrollHeight > scroll.clientHeight,
				inset: Math.min(content.left - shell.left, shell.right - content.right, shell.bottom - content.bottom) };
		});
		assert.equal(detailsLayout.shellScroll, false, "Details scrolls inside its rounded shell");
		assert.equal(detailsLayout.contentScroll, true, "Session information remains scrollable in a short window");
		assert.ok(detailsLayout.inset >= 16, "The scrollbar stays away from the outer corners");
		await page.locator(".details-scroll").focus();
		await page.keyboard.press("Control+End");
		await page.waitForFunction(() => {
			const scroll = document.querySelector(".details-scroll")!;
			return scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 1;
		});
		await checkLayout(page, `details-bottom-${width}`);
		assert.equal(await page.locator("#close-details").evaluate((node) => {
			const box = node.getBoundingClientRect();
			return box.top >= 0 && box.bottom <= innerHeight;
		}), true);
		await page.keyboard.press("Escape");
		await page.setViewportSize({ width, height: 768 });
		assert.equal(await page.locator("#show-settings").evaluate((node) => node === document.activeElement), true);
		if (width < 760) await page.locator("#close-sidebar").click();
	}
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.locator("#show-settings").click();
	await page.getByLabel("Dark", { exact: true }).check();
	await page.reload();
	await page.waitForFunction(() => !(document.getElementById("prompt") as HTMLTextAreaElement).disabled);
	assert.equal(await page.locator("html").getAttribute("data-theme"), "dark");
	await page.locator("#show-settings").click();
	await page.locator("#settings-panel summary").click();
	await page.getByLabel("System", { exact: true }).check();
	await page.mouse.click(8, 8);
	assert.equal(await page.locator("#settings-panel").isVisible(), false);
	assert.equal(await page.locator("#show-settings").evaluate((node) => node === document.activeElement), true);
	await page.route("**/api/state", (route) => route.abort());
	await page.waitForFunction(() => document.getElementById("connection")?.textContent === "Disconnected");
	assert.equal(await page.locator("#connection-dot").getAttribute("data-connected"), "false");
	assert.equal(await page.locator("#connection-dot").isVisible(), true);
	await checkLayout(page, "disconnected-desktop");
	await page.unroute("**/api/state");
	await page.waitForFunction(() => document.getElementById("connection")?.textContent === "Local");
	assert.equal(await page.locator("#connection-dot").getAttribute("data-connected"), "true");
}

/** Check usable space and input continuity in the served page, including split previews. */
export async function verifyConversationLayout(page: Page, checkLayout: (page: Page, label: string) => Promise<void>): Promise<void> {
	await page.setViewportSize({ width: 1440, height: 600 });
	await page.locator("#scroll-area").evaluate((node) => node.scrollTo({ top: node.scrollHeight, behavior: "instant" }));
	const gaps = await page.locator(".turn").last().evaluate((turn) => {
		const answer = turn.querySelector(".answer")!.getBoundingClientRect();
		const actions = turn.querySelector(".answer-actions")!.getBoundingClientRect();
		const activity = turn.querySelector('details[data-kind="activity"]')!.getBoundingClientRect();
		const report = turn.querySelector('details[data-kind="report"]')!.getBoundingClientRect();
		return { answer: activity.top - actions.bottom, actions: actions.top - answer.bottom, summaries: report.top - activity.bottom,
			composer: document.querySelector("#composer")!.getBoundingClientRect().top - report.bottom };
	});
	assert.ok(gaps.answer >= 0 && gaps.answer <= 12 && gaps.summaries >= 0 && gaps.summaries <= 4,
		`Collapsed turn evidence stays close to its answer: ${JSON.stringify(gaps)}`);
	assert.ok(gaps.actions >= 0 && gaps.actions <= 8, "Copy actions stay close to the answer text");
	assert.ok(gaps.composer >= 0 && gaps.composer <= 32, `Conversation bottom gap: ${JSON.stringify(gaps)}`);
	await checkLayout(page, "conversation-evidence");
	const activitySummary = page.locator('.turn details[data-kind="activity"]>summary').last();
	await activitySummary.click();
	await page.locator("#scroll-area").evaluate((node) => node.scrollTo({ top: node.scrollHeight, behavior: "instant" }));
	await checkLayout(page, "conversation-activity-expanded");
	const reportSummary = page.locator('.turn details[data-kind="report"]>summary').last();
	await reportSummary.click();
	await reportSummary.evaluate((node) => node.scrollIntoView({ block: "center", behavior: "instant" }));
	await checkLayout(page, "conversation-evidence-expanded");
	await reportSummary.click();
	await activitySummary.click();
	const draft = "Review the layout and keep this unsent draft.\n".repeat(12);
	for (const colorScheme of ["light", "dark"] as const) {
		await page.emulateMedia({ colorScheme });
		for (const [width, height] of [[1440, 900], [1024, 768], [761, 600], [760, 600], [390, 844], [320, 480], [1024, 360]] as const) {
			await page.setViewportSize({ width, height });
			await page.locator("#prompt").fill(draft);
			await checkLayout(page, `draft-${colorScheme}-${width}-${height}`);
			const layout = await page.evaluate(() => {
				const bounds = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
				const messages = bounds("#messages");
				const composer = bounds("#composer");
				const scroll = bounds("#scroll-area");
				const controls = ["#prompt", "#send", "#permission-mode", "#workspace-picker", "#show-attachments", "#show-preview", "#model", "#context-usage"];
				const toolbar = ["#show-attachments", "#permission-mode", "#workspace-picker", "#model", "#context-usage", "#send"].map(bounds);
				const center = toolbar.at(-1)!.top + toolbar.at(-1)!.height / 2;
				return {
					oneRow: toolbar.every((box) => Math.abs(box.top + box.height / 2 - center) <= 1),
					ordered: toolbar.every((box, index) => index === 0 || box.left >= toolbar[index - 1]!.right - 1),
					aligned: Math.abs(messages.left - composer.left) <= 1 && Math.abs(messages.right - composer.right) <= 1,
					readingSpace: scroll.height,
					blocked: controls.filter((selector) => {
						const element = document.querySelector(selector)!;
						const box = element.getBoundingClientRect();
						const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
						return box.top < 0 || box.bottom > innerHeight || box.left < 0 || box.right > innerWidth || !hit || !element.contains(hit);
					}),
				};
			});
			assert.equal(layout.aligned, true, `${width}px: message and composer edges align`);
			assert.equal(layout.oneRow, true, `${width}px: all composer controls share the send button centerline`);
			assert.equal(layout.ordered, true, `${width}px: attachment, permissions, workspace, model, context and send stay in order`);
			assert.ok(layout.readingSpace >= 100, `${width}x${height}: long drafts leave room to read`);
			assert.deepEqual(layout.blocked, [], `${width}x${height}: essential controls remain reachable`);
			assert.equal(await page.locator("#prompt").inputValue(), draft);
			await page.locator("#prompt").fill("");
		}
	}

	await page.emulateMedia({ colorScheme: "light" });
	await page.setViewportSize({ width: 1440, height: 900 });
	const wrappedDraft = "A draft that should grow when the conversation column becomes narrow. ".repeat(3);
	await page.locator("#prompt").fill(wrappedDraft);
	const wideHeight = await page.locator("#prompt").evaluate((node) => node.clientHeight);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.waitForFunction((height) => document.querySelector("textarea")!.clientHeight > height, wideHeight);
	assert.equal(await page.locator("#prompt").inputValue(), wrappedDraft);
	await page.locator("#prompt").fill("Unsent input");
	await page.locator("#prompt").press("End");
	await page.locator("#prompt").press("Shift+Enter");
	assert.equal(await page.locator("#prompt").inputValue(), "Unsent input\n");
	const turns = await page.locator(".turn").count();
	await page.locator("#prompt").dispatchEvent("keydown", { key: "Enter", isComposing: true });
	await page.waitForResponse((response) => response.url().endsWith("/api/state"));
	assert.equal(await page.locator(".turn").count(), turns, "IME confirmation does not submit a turn");
	assert.equal(await page.locator("#prompt").inputValue(), "Unsent input\n");
	await page.locator("#prompt").fill("");
	assert.equal(await page.locator(".answer pre").first().evaluate((node) => node.scrollWidth > node.clientWidth), true,
		"Long code lines scroll inside their code block on narrow screens");
	await page.setViewportSize({ width: 390, height: 480 });
	await page.locator("#prompt").fill("Keep navigation draft");
	await page.locator("#scroll-area").evaluate((node) => { node.scrollTo({ top: 0, behavior: "instant" }); });
	await page.waitForResponse((response) => response.url().endsWith("/api/state"));
	assert.equal(await page.locator("#scroll-area").evaluate((node) => node.scrollTop), 0,
		"Polling does not pull the reader away from earlier content");
	await page.locator("#scroll-bottom").waitFor();
	await checkLayout(page, "back-to-bottom-mobile");
	await page.locator("#scroll-bottom").focus();
	await page.keyboard.press("Enter");
	await page.locator("#scroll-bottom").waitFor({ state: "hidden" });
	assert.ok(await page.locator("#scroll-area").evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight < 2));
	assert.equal(await page.locator("#prompt").evaluate((node) => document.activeElement === node), true,
		"Returning to the bottom restores a visible keyboard focus");
	assert.equal(await page.locator("#prompt").inputValue(), "Keep navigation draft");
	await page.route("**/api/state", (route) => route.abort());
	try {
		await page.waitForFunction(() => document.getElementById("connection")?.textContent === "Disconnected");
		await page.locator("#scroll-area").evaluate((node) => node.scrollTo({ top: 0, behavior: "instant" }));
		await page.locator("#scroll-bottom").click();
		await page.locator("#scroll-bottom").waitFor({ state: "hidden" });
		assert.equal(await page.locator("#scroll-area").evaluate((node) => document.activeElement === node), true,
			"Offline navigation focuses the reading area instead of a disabled input");
		assert.equal(await page.locator("#prompt").inputValue(), "Keep navigation draft");
	} finally {
		await page.unroute("**/api/state");
	}
	await page.waitForFunction(() => document.getElementById("connection")?.textContent === "Local");
	await page.locator("#prompt").fill("");
}

export async function verifyPreviewLayout(page: Page, checkLayout: (page: Page, label: string) => Promise<void>): Promise<void> {
	for (const colorScheme of ["light", "dark"] as const) {
		await page.emulateMedia({ colorScheme });
		for (const width of [1440, 1201, 1200, 390, 320]) {
			await page.setViewportSize({ width, height: 768 });
			await checkLayout(page, `preview-${colorScheme}-${width}`);
			const layout = await page.evaluate(() => {
				const main = document.querySelector("main")!.getBoundingClientRect();
				const preview = document.querySelector("#file-preview")!.getBoundingClientRect();
				return { chatWidth: main.width, sideBySide: main.right <= preview.left + 1, previewRight: preview.right };
			});
			assert.ok(layout.previewRight <= width, "Preview stays inside the viewport");
			if (width > 1200) {
				assert.equal(layout.sideBySide, true, "Wide previews do not cover the conversation");
				assert.ok(layout.chatWidth >= 560, "Split view preserves a usable conversation column");
			}
		}
	}
	await page.emulateMedia({ colorScheme: "light" });
}
