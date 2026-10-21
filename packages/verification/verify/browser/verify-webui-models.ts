import { preparedChatRequest } from "../../tests/support/chat-protocol.js";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import { createAgent } from "@fatcat/runtime/agent";
import { loadConfig } from "@fatcat/runtime/config";
import { ModelConnections } from "@fatcat/runtime/model-connections";
import { PermissionPolicy } from "@fatcat/runtime/permissions/policy";
import { SessionManager } from "@fatcat/runtime/session/manager";
import { SessionStore } from "@fatcat/runtime/session/store";
import { createTools } from "@fatcat/runtime/tools";
import { WebUiController } from "@fatcat/webui/internal/controller";
import { startWebUiServer } from "@fatcat/webui/internal/server";

// Real Edge, real SDK preparation and local HTTP; all generation and counting are injected.
const temporaryRoot = await realpath(tmpdir());
const base = await mkdtemp(join(temporaryRoot, "fatcat-model-ui-"));
const workspace = join(base, "workspace");
const screenshots = process.env.FATCAT_VERIFY_SCREENSHOTS;
let browser: Browser | undefined;
let server: Awaited<ReturnType<typeof startWebUiServer>> | undefined;
let controller: WebUiController | undefined;
let release: (() => void) | undefined;

async function settled(page: Page, id: string): Promise<void> {
	await page.locator(id).evaluate(async (element) => {
		await Promise.all(element.getAnimations().map((animation) => animation.finished));
	});
}
async function closed(page: Page, id: string, trigger: string): Promise<void> {
	await page.locator(id).waitFor({ state: "hidden" });
	await page.waitForFunction((selector) => document.activeElement === document.querySelector(selector), trigger);
}
async function layout(page: Page, panel: string): Promise<void> {
	await settled(page, panel);
	const result = await page.locator(panel).evaluate((element) => {
		const rect = element.getBoundingClientRect();
		const overflow = [document.documentElement, element, ...element.querySelectorAll<HTMLElement>(".popover-content, .model-options, .context-summary")]
			.filter((item) => item.scrollWidth > item.clientWidth + 1).map((item) => item.id || item.className);
		return { inside: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
			modal: element.matches(":modal"), overflow };
	});
	assert.deepEqual(result, { inside: true, modal: true, overflow: [] });
}

/** Exercise the production estimator, not the injected counter used for deterministic lifecycle checks. */
async function verifyDefaultContext(browser: Browser, root: string): Promise<void> {
	const workspace = join(root, "unicode-workspace");
	await mkdir(workspace);
	await writeFile(join(workspace, "unicode.txt"), "\u7ed3\u679c\uff1a\u5b8c\u6210\u3002 \u2713");
	const config = loadConfig({ DEEPSEEK_API_KEY: "offline-default-counter" });
	let calls = 0;
	const reply = "\u4f60\u597d\uff01\u6709\u4ec0\u4e48\u9700\u8981\u6211\u5e2e\u5fd9\u7684\u5417\uff1f\u53ef\u4ee5\u5e2e\u4f60\u67e5\u770b\u4ee3\u7801\uff0c\u4fee\u6539\u6587\u4ef6\u3002 \ud83d\udc08";
	const agent = createAgent(config, await createTools(workspace), async () => {
		calls++;
		const input = calls === 1 ? 100 : calls === 2 ? 300 : 1000;
		return Response.json({ choices: [{ finish_reason: calls === 1 ? "tool_calls" : "stop", message: calls === 1
			? { role: "assistant", content: null, reasoning_content: "\u8bfb\u53d6\u6587\u4ef6\u3002", tool_calls: [
				{ id: "unicode-read", type: "function", function: { name: "read", arguments: '{"path":"unicode.txt"}' } },
			] } : { role: "assistant", content: reply, reasoning_content: "\u5df2\u5b8c\u6210\u3002" } }],
			usage: { prompt_tokens: input, completion_tokens: 20, total_tokens: input + 20,
				prompt_cache_miss_tokens: calls === 1 ? 100 : calls === 2 ? 60 : 800,
				...(calls <= 2 ? { prompt_cache_hit_tokens: calls === 1 ? 0 : 240,
					prompt_tokens_details: { cached_tokens: calls === 1 ? 0 : 240 } } : {}),
				completion_tokens_details: { reasoning_tokens: 15 } } });
	});
	const session = await SessionManager.open(agent, { workspace, store: new SessionStore({ root: join(root, "unicode-sessions") }), deferEmptySessions: true });
	const host = await WebUiController.create({ workspace, provider: config.provider, model: config.model,
		permission: "ask", shellPermission: "deny", webPermission: "deny", maxIterations: config.maxIterations,
		maxRequestBytes: config.maxRequestBytes, skills: 0, warnings: [] }, session);
	const server = await startWebUiServer(host, 0);
	const page = await browser.newPage();
	page.setDefaultTimeout(10000);
	try {
		await page.goto(server.url);
		await page.waitForFunction(() => !(document.querySelector("#model") as HTMLButtonElement).disabled);
		const baseline = host.snapshot().contextUsage!.estimate;
		assert.equal(baseline.status, "ready");
		assert.ok(baseline.inputTokens! > 0, "System/tool baseline is real prepared input, not conversation consumption");
		await page.locator("#context-usage").click();
		assert.equal(await page.locator(".context-amount").innerText(), "Not started / 1M");
		assert.equal(await page.locator(".context-percentage").innerText(), "—");
		assert.equal(host.snapshot().contextUsage?.cacheHitRate, null);
		assert.equal(calls, 0);
		if (screenshots) { await settled(page, "#context-panel"); await page.screenshot({ path: join(screenshots, "context-empty.png") }); }
		await page.keyboard.press("Escape");
		await page.locator("#prompt").fill("\u4f60\u597d\uff0c\u8bf7\u8bfb\u53d6 unicode.txt\u3002");
		await page.locator("#send").click();
		await page.waitForFunction(() => document.querySelector("#context-usage")?.getAttribute("data-known") === "true");
		const usage = host.snapshot().contextUsage!;
		assert.equal(calls, 2);
		assert.equal(usage.estimate.status, "ready");
		assert.ok(usage.estimate.inputTokens! > baseline.inputTokens!);
		assert.equal(usage.lastReportedInput?.inputTokens, 300);
		assert.equal(usage.consumption.tokens?.totalTokens, 440);
		assert.equal(usage.cacheHitRate, 0.6);
		assert.notEqual(usage.estimate.inputTokens, 300);
		await page.locator("#context-usage").click();
		assert.match(await page.locator(".context-amount").innerText(), /^≈[\d.]+K \/ 1M$/);
		assert.notEqual(await page.locator(".context-percentage").innerText(), "—");
		if (screenshots) { await settled(page, "#context-panel"); await page.screenshot({ path: join(screenshots, "context-chinese.png") }); }
		await page.keyboard.press("Escape");
		await page.locator("#prompt").fill("Continue");
		await page.locator("#send").click();
		await page.waitForFunction(() => document.querySelectorAll(".turn").length === 2
			&& document.querySelector("#context-usage")?.getAttribute("data-known") === "true");
		assert.equal(calls, 3);
		assert.equal(host.snapshot().contextUsage?.cacheHitRate, 440 / 1400);
		assert.equal(host.snapshot().contextUsage?.consumption.tokens?.totalTokens, 1460);
		const id = session.current.id;
		await page.reload();
		await page.waitForFunction(() => document.querySelector("#context-usage")?.getAttribute("data-known") === "true");
		await page.locator("#new-chat").click();
		await page.waitForFunction(() => document.querySelector("#context-usage")?.getAttribute("title")?.includes("not started"));
		await page.locator(`[data-session-id="${id}"]`).click();
		await page.waitForFunction(() => document.querySelector("#context-usage")?.getAttribute("data-known") === "true");
		assert.equal(host.snapshot().contextUsage?.cacheHitRate, 440 / 1400);
		assert.equal(calls, 3, "Preview/reload/resume never generate");
	} finally { await page.close(); await server.close(); }
}

try {
	await mkdir(workspace);
	await writeFile(join(workspace, "fixture.txt"), "READ_RESULT_INCLUDED");
	const config = loadConfig({ DEEPSEEK_API_KEY: "offline-edge-deepseek" });
	const connections = new ModelConnections(config, { MOONSHOT_API_KEY: "offline-edge-kimi" });
	const policy = new PermissionPolicy({ permission: "ask", shellPermission: "deny" });
	const tools = await createTools(workspace, "ask", undefined, {}, undefined, policy);
	const requests: Record<string, unknown>[] = [];
	const projections: string[] = [];
	const agent = { ...createAgent(config, tools, async (input, init) => {
		const body = await new Request(input, init).json() as { model: string; messages: { role: string; content: unknown }[]; tools?: unknown[] };
		requests.push(body);
		const summary = !body.tools;
		if (!summary && body.messages.at(-1)?.role === "user" && requests.length === 1) {
			await new Promise<void>((done) => { release = done; });
			return Response.json({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null,
				reasoning_content: "Fixture reasoning", tool_calls: [{ id: "read-fixture", type: "function",
					function: { name: "read", arguments: JSON.stringify({ path: "fixture.txt" }) } }] } }],
				usage: { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020, prompt_cache_hit_tokens: 100 } });
		}
		return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: summary ? "Compact summary" : "Verified answer" } }],
			usage: { prompt_tokens: summary ? 500 : 1000, completion_tokens: 20, total_tokens: summary ? 520 : 1020,
				prompt_cache_hit_tokens: summary ? 50 : 100 } });
	}, undefined, undefined, undefined, undefined, connections), inputCounter: {
		supports: (selection: { provider: string }) => selection.provider === "deepseek",
		count: async (request: import("@fatcat/runtime/internal/model-preparation").PreparedModelRequest) => {
			const projection = JSON.stringify(preparedChatRequest(request).messages); projections.push(projection);
			return { inputTokens: projection.includes("Compact summary") ? 50_000 : projection.includes("Verified answer") ? 200_000 : 100_000,
				method: "injected Edge fixture counter", approximate: true, limitations: ["Fixture counts are not production token measurements."] };
		},
	} };
	const store = new SessionStore({ root: join(base, "sessions") });
	const session = await SessionManager.open(agent, { workspace, store, deferEmptySessions: true });
	controller = await WebUiController.create({ workspace, provider: config.provider, model: config.model, permission: "ask",
		shellPermission: "deny", webPermission: "deny", maxIterations: config.maxIterations, maxRequestBytes: config.maxRequestBytes,
		skills: 0, warnings: [] }, session, policy);
	server = await startWebUiServer(controller, 0);
	browser = await chromium.launch({ headless: true, channel: "msedge" });
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	page.setDefaultTimeout(10_000);
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(server.url);
	await page.waitForFunction(() => !(document.querySelector("#model") as HTMLButtonElement).disabled);
	const prompt = page.locator("#prompt");
	const model = page.locator("#model");
	const ring = page.locator("#context-usage");
	assert.match(await ring.getAttribute("aria-label") ?? "", /not started/);
	await prompt.fill("UNSENT_DRAFT_EXCLUDED");
	await ring.focus(); await page.keyboard.press("Enter");
	await layout(page, "#context-panel");
	await page.waitForFunction(() => !(document.querySelector("#send") as HTMLButtonElement).disabled);
	assert.equal(await page.locator(".context-amount").innerText(), "Not started / 1M");
	assert.equal(await page.locator(".context-percentage").innerText(), "—");
	assert.equal(await page.locator("#context-panel .popover-content").innerText(), "Context\nNot started / 1M\n—");
	assert.equal(controller.snapshot().contextUsage?.estimate.inputTokens, 100000, "Prepared baseline remains available independently of empty-chat display");
	assert.equal(controller.snapshot().contextUsage?.consumption.tokens, null);
	assert.ok(projections.every((projection) => !projection.includes("UNSENT_DRAFT_EXCLUDED")));
	assert.equal(requests.length, 0);
	await page.keyboard.press("Escape"); await closed(page, "#context-panel", "#context-usage");
	await model.focus(); await page.keyboard.press("Enter");
	assert.equal(await page.locator("#model-panel").evaluate((element) => element.matches(":modal")), true);
	assert.equal(await page.locator("#thinking-level").getAttribute("aria-valuetext"), "medium");
	assert.deepEqual(await page.locator(".thinking-ticks span").allTextContents(), ["low", "medium", "high", "max", "ultra"]);
	assert.equal(await page.locator("#model-panel label,#thinking-value,.metric-note").count(), 0);
	await page.locator("#model-choice").click();
	await layout(page, "#model-panel");
	assert.deepEqual(await page.locator("#model-options [role=option]").allTextContents(),
		controller.snapshot().modelChoices.filter((choice) => choice.available).map((choice) => choice.selection.model));
	assert.equal(await page.locator("#model-options [role=option]:disabled").count(), 0);
	await page.keyboard.press("End");
	assert.equal(await page.locator("#model-options [role=option]").last().evaluate((element) => document.activeElement === element), true);
	await page.keyboard.press("Home");
	assert.equal(await page.locator("#model-options [role=option]").first().evaluate((element) => document.activeElement === element), true);
	await page.keyboard.press("Escape");
	assert.equal(await page.locator("#model-panel").isVisible(), true);
	assert.equal(await page.locator("#model-options").isVisible(), false);
	await page.locator("#thinking-level").focus(); await page.keyboard.press("End");
	assert.equal(await page.locator("#thinking-level").getAttribute("aria-valuetext"), "ultra");
	assert.equal(await page.locator("#thinking-level").getAttribute("title"), "Provider level: max");
	if (screenshots) {
		await mkdir(screenshots, { recursive: true }); await settled(page, "#model-panel");
		await page.screenshot({ path: join(screenshots, "model-choice.png") });
	}
	await page.route("**/api/model", (route) => route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "Injected conflict; retry your choice." }) }));
	await page.getByRole("button", { name: "Apply", exact: true }).click();
	await page.locator("#model-panel [role=alert]:not([hidden])").waitFor();
	assert.match(await page.locator("#model-panel [role=alert]").innerText(), /Injected conflict/);
	assert.equal(session.current.modelSelection?.thinking, "medium");
	assert.equal(await prompt.inputValue(), "UNSENT_DRAFT_EXCLUDED");
	await page.unroute("**/api/model");
	await page.getByRole("button", { name: "Apply", exact: true }).click();
	await page.waitForFunction(() => document.querySelector("#model")?.getAttribute("title")?.includes("Thinking: ultra"));
	await page.locator("#model-panel").waitFor({ state: "hidden" });
	await page.waitForFunction(() => document.activeElement === document.querySelector("#model"));
	assert.equal(session.current.modelSelection?.thinking, "ultra");
	assert.equal(await prompt.inputValue(), "UNSENT_DRAFT_EXCLUDED");
	assert.equal(requests.length, 0);

	await prompt.fill("Read fixture"); await page.getByRole("button", { name: "Send message", exact: true }).click();
	await page.waitForFunction(() => !(document.querySelector("#stop") as HTMLButtonElement).hidden);
	assert.equal(await model.isDisabled(), true);
	await ring.click();
	await page.waitForFunction(() => document.querySelector("#context-usage")?.getAttribute("aria-label")?.includes("updating"));
	assert.equal(await ring.getAttribute("data-known"), "false");
	assert.equal(await page.locator(".context-amount").innerText(), "Updating / 1M");
	assert.equal(await page.locator(".context-track").getAttribute("aria-valuenow"), null);
	const token = new URL(server.url).hash.slice("#token=".length);
	const busy = await page.request.post(`${server.origin}/api/model`, { headers: { Authorization: `Bearer ${token}` }, data: {
		sessionId: session.current.id, revision: session.current.revision, previous: session.current.modelSelection,
		selection: { ...session.current.modelSelection, thinking: "off" },
	} });
	assert.equal(busy.status(), 409);
	assert.ok(release, "The injected transport must actually be waiting"); release();
	await page.waitForFunction(() => document.querySelector("#context-usage")?.getAttribute("aria-label")?.includes("200,000"));
	assert.equal(requests.length, 2);
	assert.equal(requests[0]!.reasoning_effort, "max", "Ultra is mapped through the runtime protocol, not sent as an SDK label");
	assert.ok(projections.at(-1)?.includes("READ_RESULT_INCLUDED"));
	assert.ok(projections.at(-1)?.includes("Verified answer"));
	assert.equal(await page.locator(".context-amount").innerText(), "≈200K / 1M");
	assert.equal(await page.locator(".context-percentage").innerText(), "19.1%");
	assert.equal(controller.snapshot().contextUsage?.consumption.tokens?.totalTokens, 2040);
	assert.equal(controller.snapshot().contextUsage?.consumption.cache?.hitTokens, 200);
	assert.equal(controller.snapshot().contextUsage?.consumption.cache?.inputTokens, 2000);
	assert.equal(controller.snapshot().contextUsage?.lastReportedInput?.inputTokens, 1000);
	assert.match(controller.snapshot().contextUsage?.lastReportedInput?.observedAt ?? "", /^\d{4}-/);
	assert.match(await ring.getAttribute("style") ?? "", /19\.073486328125%/);
	if (screenshots) {
		await settled(page, "#context-panel");
		await page.screenshot({ path: join(screenshots, "context-known.png") });
	}
	const id = session.current.id;
	await page.keyboard.press("Escape"); await closed(page, "#context-panel", "#context-usage");

	// Compaction preserves the latest complete turn; add a second so the first is eligible.
	await prompt.fill("Continue"); await page.getByRole("button", { name: "Send message", exact: true }).click();
	await page.waitForFunction(() => document.querySelectorAll("#messages .turn").length === 2
		&& !(document.querySelector("#model") as HTMLButtonElement).disabled);
	assert.equal(requests.length, 3);
	await prompt.fill("/compact"); await page.getByRole("button", { name: "Send message", exact: true }).click();
	await page.waitForFunction(() => document.querySelector("#context-usage")?.getAttribute("aria-label")?.includes("50,000"));
	assert.equal(requests.length, 4);
	assert.equal(controller.snapshot().contextUsage?.consumption.tokens?.totalTokens, 3580);
	assert.equal(controller.snapshot().contextUsage?.lastReportedInput?.inputTokens, 1000);
	await prompt.fill("Keep draft when switching");
	await model.click();
	const choices = controller.snapshot().modelChoices;
	const fixed = choices.findIndex((choice) => choice.available && choice.selection.model === "kimi-k2.7-code");
	assert.ok(fixed >= 0);
	await page.locator("#model-choice").click();
	await page.getByRole("option", { name: choices[fixed]!.selection.model, exact: true }).click();
	assert.equal(await page.locator("#thinking-level").isDisabled(), true);
	assert.deepEqual(await page.locator(".thinking-ticks span").allTextContents(), ["on"]);
	assert.equal(await page.locator("#thinking-level").getAttribute("aria-valuetext"), "on");
	await page.getByRole("button", { name: "Apply", exact: true }).click();
	await page.waitForFunction(() => document.querySelector("#model")?.textContent === "kimi-k2.7-code");
	assert.equal(await ring.getAttribute("data-known"), "false");
	assert.match(await ring.getAttribute("aria-label") ?? "", /unknown/);
	assert.equal(await prompt.inputValue(), "Keep draft when switching");
	await ring.click();
	assert.equal(await page.locator(".context-amount").innerText(), "Unknown / 262.1K");
	assert.equal(await page.locator(".context-percentage").innerText(), "—");
	assert.equal(controller.snapshot().contextUsage?.windowCapacityTokens, 262144);
	assert.equal(controller.snapshot().contextUsage?.lastReportedInput?.selection.model, "deepseek-flash");
	assert.equal(controller.snapshot().contextUsage?.lastReportedInput?.selection.thinking, "ultra");
	assert.match(await page.locator(".context-amount").getAttribute("title") ?? "", /No reliable local counter/);
	assert.equal(requests.length, 4);
	await page.keyboard.press("Escape");
	await page.reload();
	await page.waitForFunction(() => document.querySelector("#model")?.textContent === "kimi-k2.7-code");
	assert.equal((await store.loadAny(id)).modelSelection?.model, "kimi-k2.7-code");
	// Another authorized tab changes the shared selection; an open old form must close on refresh.
	await model.click();
	const second = await browser.newPage(); await second.goto(server.url);
	await second.waitForFunction(() => !(document.querySelector("#model") as HTMLButtonElement).disabled);
	await second.locator("#model").click();
	const toggle = choices.findIndex((choice) => choice.available && choice.selection.model === "kimi-k2.6");
	assert.ok(toggle >= 0);
	await second.locator("#model-choice").click();
	await second.getByRole("option", { name: choices[toggle]!.selection.model, exact: true }).click();
	await second.getByRole("button", { name: "Apply", exact: true }).click();
	await second.waitForFunction(() => document.querySelector("#model")?.textContent === "kimi-k2.6");
	await page.locator("#model-panel").waitFor({ state: "hidden" });
	await page.waitForFunction(() => document.querySelector("#model")?.textContent === "kimi-k2.6");
	assert.equal((await store.loadAny(id)).modelSelection?.model, "kimi-k2.6");
	await second.close();
	await page.locator("#new-chat").click();
	await page.locator("#welcome:not([hidden])").waitFor();
	await page.locator(`[data-session-id="${id}"]`).click();
	await page.waitForFunction(() => document.querySelector("#model")?.textContent === "kimi-k2.6");
	assert.equal(controller.snapshot().contextUsage?.consumption.tokens?.totalTokens, 3580);
	// A saved explicit off is preserved until the user applies the picker's enabled default.
	const off = await page.request.post(`${server.origin}/api/model`, { headers: { Authorization: `Bearer ${token}` }, data: {
		sessionId: session.current.id, revision: session.current.revision, previous: session.current.modelSelection,
		selection: { provider: "deepseek", region: "global", model: "deepseek-flash", thinking: "off" },
	} });
	assert.equal(off.status(), 202);
	await page.waitForFunction(() => document.querySelector("#model")?.getAttribute("title")?.includes("Thinking: off"));
	await model.click();
	assert.equal(await page.locator("#thinking-level").getAttribute("aria-valuetext"), "medium");
	assert.equal(await page.getByRole("button", { name: "Apply", exact: true }).isDisabled(), false);
	await page.keyboard.press("Escape"); await closed(page, "#model-panel", "#model");
	assert.equal((await store.loadAny(id)).modelSelection?.thinking, "off");
	await model.click(); await page.getByRole("button", { name: "Apply", exact: true }).click();
	await page.waitForFunction(() => document.querySelector("#model")?.getAttribute("title")?.includes("Thinking: medium"));
	assert.equal((await store.loadAny(id)).modelSelection?.thinking, "medium");

	for (const colorScheme of ["light", "dark"] as const) {
		await page.emulateMedia({ colorScheme });
		for (const width of [1440, 390, 320]) {
			await page.setViewportSize({ width, height: width === 320 ? 480 : 800 });
			await model.click(); await layout(page, "#model-panel");
			assert.ok((await page.locator("#model-panel").boundingBox())!.height <= 220, "Collapsed model panel stays compact");
			await page.locator("#model-choice").focus();
			assert.equal(await page.locator("#model-choice").evaluate((element) => {
				const bounds = element.getBoundingClientRect();
				const parent = element.parentElement!.getBoundingClientRect();
				const style = getComputedStyle(element);
				const inset = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
				return bounds.left - inset >= parent.left && bounds.right + inset <= parent.right
					&& bounds.top - inset >= parent.top && bounds.bottom + inset <= parent.bottom;
			}), true, "The selector's focus outline must not be clipped by its scroll container");
			await page.locator("#model-choice").click(); await layout(page, "#model-panel");
			assert.equal(await page.locator("#model-options").evaluate((element) => getComputedStyle(element).borderRadius), "12px");
			if (screenshots) await page.screenshot({ path: join(screenshots, `picker-${colorScheme}-${width}.png`) });
			await page.keyboard.press("Escape");
			await page.keyboard.press("Escape"); await closed(page, "#model-panel", "#model");
			await ring.click(); await layout(page, "#context-panel");
			assert.ok((await page.locator("#context-panel").boundingBox())!.height <= 80, "Context is a single summary row and bar");
			assert.equal(await page.locator("#context-panel .popover-close").isVisible(), false);
			if (screenshots) { await mkdir(screenshots, { recursive: true }); await page.screenshot({ path: join(screenshots, `models-${colorScheme}-${width}.png`) }); }
			await page.keyboard.press("Escape"); await closed(page, "#context-panel", "#context-usage");
			const radius = await page.locator("#show-attachments").evaluate((element) => getComputedStyle(element).borderRadius);
			for (const trigger of [model, ring]) {
				await trigger.hover();
				await trigger.evaluate(async (element) => { await Promise.all(element.getAnimations().map((animation) => animation.finished)); });
				const style = await trigger.evaluate((element) => {
					const value = getComputedStyle(element); return { radius: value.borderRadius, shadow: value.boxShadow, background: value.backgroundColor };
				});
				assert.equal(style.radius, radius);
				assert.notEqual(style.shadow, "none");
				assert.notEqual(style.background, "rgba(0, 0, 0, 0)");
			}
			const icons = await page.locator("#show-attachments .icon, .permission-mode-icon .icon, .workspace-path-icon .icon").evaluateAll((items) => items.map((item) => {
				const box = item.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, width: box.width, height: box.height };
			}));
			assert.equal(icons.length, 3);
			assert.ok(icons.every((icon) => icon.width === 16 && icon.height === 16));
			assert.ok(Math.max(...icons.map((icon) => icon.top)) - Math.min(...icons.map((icon) => icon.top)) <= 1);
			assert.ok(Math.max(...icons.map((icon) => icon.bottom)) - Math.min(...icons.map((icon) => icon.bottom)) <= 1);
		}
	}
	await page.setViewportSize({ width: 1440, height: 900 });
	await model.click(); await settled(page, "#model-panel");
	await page.mouse.click(2, 2); await closed(page, "#model-panel", "#model");
	await page.emulateMedia({ reducedMotion: "reduce" });
	await ring.click();
	assert.equal(await page.locator("#context-panel").evaluate((element) => element.getAnimations().length), 0);
	assert.equal(requests.length, 4, "Opening panels, polling and selecting models must not generate");
	assert.deepEqual(errors, []);
	await verifyDefaultContext(browser, base);
	console.log("Verified real Edge: model/effort selection and protocol mapping, unavailable choices, error/retry, preserved drafts, busy rejection, runtime estimate vs cumulative/reported input, tool/answer and compaction refresh, old model observation isolation, unknown counts, saved selection/reload/resume, both themes at 1440/390/320px, short viewport, icon alignment, modal dismissal/focus and reduced motion. Only injected model transport and counting; no provider network requests.");
} catch (error) {
	console.error(JSON.stringify({ status: controller?.snapshot().status, lastTurn: controller?.snapshot().turns.at(-1),
		context: controller?.snapshot().contextUsage }));
	throw error;
} finally {
	release?.();
	await browser?.close();
	if (server) await server.close(); else await controller?.close();
	const target = resolve(base);
	if (dirname(target) !== temporaryRoot || !basename(target).startsWith("fatcat-model-ui-")) throw new Error("Unexpected fixture cleanup path.");
	await rm(target, { recursive: true, force: true });
}
