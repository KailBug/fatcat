import assert from "node:assert/strict";
import type { Page } from "playwright";

type CheckLayout = (page: Page, label: string) => Promise<void>;

export async function verifySessionSearch(page: Page, checkLayout: CheckLayout): Promise<void> {
	await page.setViewportSize({ width: 1440, height: 900 });
	const rows = page.locator("#sessions [data-session-id]");
	const original = await rows.count();
	assert.ok(original >= 2);
	await page.locator("#prompt").fill("Search must preserve this draft");
	const search = page.locator("#session-search");
	await search.fill("REVIEW title");
	assert.equal(await rows.count(), 1, "Search matches multiple case-insensitive terms");
	await page.waitForResponse((response) => response.url().endsWith("/api/state"));
	assert.equal(await rows.count(), 1, "Polling preserves the filter");
	await search.press("ArrowDown");
	assert.equal(await rows.first().evaluate((row) => row === document.activeElement), true);
	await search.fill("no-matching-chat-938141");
	assert.equal(await rows.count(), 0);
	assert.match(await page.locator("#session-search-status").textContent() ?? "", /0 matching chats/);
	assert.match(await page.locator(".session-empty").textContent() ?? "", /No chats match/);
	await search.press("Escape");
	assert.equal(await rows.count(), original);
	await search.fill("workspace-with-a-long-name");
	assert.equal(await rows.count(), original, "Folders are searchable");
	await page.locator("#clear-session-search").click();
	assert.equal(await search.evaluate((input) => input === document.activeElement), true);
	assert.equal(await page.locator("#prompt").inputValue(), "Search must preserve this draft");
	await page.locator("#prompt").fill("");
	await page.setViewportSize({ width: 320, height: 600 });
	await page.locator("#toggle-sidebar").click();
	await search.fill("Explore");
	await checkLayout(page, "session-search-mobile");
	await search.press("Escape");
	assert.equal(await page.locator("body").evaluate((body) => body.classList.contains("sidebar-open")), true,
		"First Escape clears the search instead of closing the drawer");
	await search.press("Escape");
	await page.setViewportSize({ width: 1440, height: 1000 });
}

export async function verifyMarkdown(page: Page, checkLayout: CheckLayout): Promise<void> {
	const result = await page.evaluate(async () => {
		const path = "/markdown.js";
		const { renderMarkdown } = await import(path);
		const reference = `attachment:00000000-0000-4000-8000-000000000000@${"a".repeat(64)}#L1-L1`;
		const opened: string[] = [];
		const source = [
			"# Markdown capabilities", "[Jump to table](#data-table)",
			"*Emphasis*, **strong**, ~~deleted~~, &amp; entities and `&amp;` literal code.",
			"3. Third item\n   - Nested bullet\n     - Deep bullet\n4. Fourth item",
			"- [x] Completed\n- [ ] Pending", "> Outer quote\n>\n> > Nested quote",
			"## Data table", "| Name | Count | Notes |\n| :--- | ---: | :---: |\n| **Alpha** | 12 | `code` |\n| Beta | 9 | Long content that remains inside the table |",
			"~~~typescript\nconst raw = '<button> &amp;';\n~~~", "    indented &amp; code",
			"[Reference][docs] and <https://example.com>", "[docs]: https://example.com/docs \"Documentation\"",
			`[Source](${reference}) and \`${reference}\``, "![Remote illustration](https://example.com/no-request.png)",
			`[**${reference}** and \`${reference}\`](https://example.com/source)`,
			"[Unsafe](javascript:alert(1)) [Encoded](jav&#x61;script:alert(1))",
			"<img src=x onerror=alert(1)>\n<script>alert(1)</script>", "---", "### Smaller heading",
		].join("\n\n");
		const root = renderMarkdown(source, (reference: string) => opened.push(reference)) as HTMLElement;
		root.id = "markdown-fixture";
		const dialog = document.createElement("dialog"); dialog.id = "markdown-verification";
		dialog.setAttribute("aria-label", "Markdown verification"); dialog.append(root); document.body.append(dialog); dialog.showModal();
		root.querySelector<HTMLButtonElement>(".attachment-citation")!.click();
		return {
			headings: root.querySelectorAll("h2,h3,h4").length,
			nestedLists: root.querySelectorAll("ol ul ul").length,
			start: root.querySelector("ol")?.start,
			checkboxes: [...root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map((input) => [input.checked, input.disabled]),
			quotes: root.querySelectorAll("blockquote blockquote").length,
			tables: root.querySelectorAll("table tbody tr").length,
			unsafe: root.querySelectorAll("script,img,iframe,svg,style,[onerror]").length,
			nestedControls: root.querySelectorAll("a button,a a").length,
			unsafeLinks: [...root.querySelectorAll("a")].filter((link) => /^(javascript|data):/i.test(link.href)).length,
			code: [...root.querySelectorAll("pre code")].map((code) => code.textContent),
			inlineCode: root.querySelector("p code")?.textContent,
			emphasis: root.querySelectorAll("em,strong,del").length,
			opened, reference,
		};
	});
	assert.equal(result.headings, 3); assert.equal(result.nestedLists, 1); assert.equal(result.start, 3);
	assert.deepEqual(result.checkboxes, [[true, true], [false, true]]);
	assert.equal(result.quotes, 1); assert.equal(result.tables, 2); assert.ok(result.emphasis >= 4);
	assert.equal(result.unsafe, 0); assert.equal(result.unsafeLinks, 0);
	assert.equal(result.nestedControls, 0);
	assert.deepEqual(result.code, ["const raw = '<button> &amp;';", "indented &amp; code"]);
	assert.equal(result.inlineCode, "&amp;"); assert.deepEqual(result.opened, [result.reference]);
	await page.locator("#markdown-fixture").getByRole("link", { name: "Jump to table" }).click();
	assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Data table");
	for (const colorScheme of ["light", "dark"] as const) {
		await page.emulateMedia({ colorScheme });
		for (const width of [1440, 320]) {
			await page.setViewportSize({ width, height: 900 });
			await page.locator("#markdown-verification").evaluate((dialog) => { dialog.scrollTop = 0; });
			await checkLayout(page, `markdown-${colorScheme}-${width}`);
		}
	}
	await page.evaluate(() => { const dialog = document.getElementById("markdown-verification") as HTMLDialogElement; dialog.close(); dialog.remove(); });
	await page.emulateMedia({ colorScheme: "light" });
	await page.setViewportSize({ width: 1440, height: 1000 });
}

export async function verifyPreviewResize(page: Page, checkLayout: CheckLayout): Promise<void> {
	await page.setViewportSize({ width: 1440, height: 900 });
	const handle = page.locator("#preview-resizer");
	const preview = page.locator("#file-preview");
	await handle.waitFor();
	const width = () => preview.evaluate((panel) => panel.getBoundingClientRect().width);
	await handle.focus();
	await page.keyboard.press("Home"); assert.equal(await width(), 360);
	await page.keyboard.press("ArrowLeft"); assert.equal(await width(), 376);
	await page.keyboard.press("End");
	assert.ok(await page.locator("main").evaluate((main) => main.getBoundingClientRect().width >= 560));
	await page.keyboard.press("Home");
	const box = (await handle.boundingBox())!;
	await page.mouse.move(box.x + box.width / 2, box.y + 80); await page.mouse.down();
	await page.mouse.move(box.x - 80, box.y + 80); await page.mouse.up();
	const dragged = await width(); assert.ok(dragged > 430 && dragged < 460);
	await checkLayout(page, "preview-resized");
	await page.locator("#preview-close").click(); await page.locator("#show-preview").click();
	assert.equal(await width(), dragged, "Closing/reopening retains the user's width");
	await page.setViewportSize({ width: 390, height: 844 });
	await handle.waitFor({ state: "hidden" }); assert.equal(await width(), 390);
	await page.setViewportSize({ width: 1440, height: 900 }); await handle.waitFor();
	assert.equal(await width(), dragged, "Overlay mode does not overwrite the saved split width");
	const cancelBox = (await handle.boundingBox())!;
	await page.mouse.move(cancelBox.x + 4, cancelBox.y + 80); await page.mouse.down();
	await page.mouse.move(cancelBox.x - 40, cancelBox.y + 80); await page.keyboard.press("Escape"); await page.mouse.up();
	assert.equal(await width(), dragged, "Escape cancels a drag without persisting it");
	await page.reload();
	await page.waitForFunction(() => !(document.getElementById("prompt") as HTMLTextAreaElement).disabled);
	await page.locator("#show-preview").click();
	await page.locator("#preview-path").fill("preview.html");
	await page.locator("#preview-open").click();
	await page.frameLocator("#preview-viewport iframe").getByRole("heading", { name: "Local preview is ready" }).waitFor();
	assert.equal(await width(), dragged, "Reload restores the saved width");
	await handle.focus(); await page.keyboard.press("Enter");
	assert.equal(await page.evaluate(() => localStorage.getItem("fatcat-preview-width")), null);
}
