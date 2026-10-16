import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { chromium } from "playwright";
import type { Browser } from "playwright";
import { attachmentReference } from "../../../src/attachments/record.js";
import { SessionManager } from "../../../src/session/manager.js";
import { SessionStore } from "../../../src/session/store.js";
import { createAgent } from "../../../src/agent.js";
import { loadConfig } from "../../../src/config.js";
import type { Message } from "../../../src/model.js";
import { createTools } from "../../../src/tools.js";
import { officeFixture, pdfFixture, imageFixture } from "../../../tests/fixtures/document-fixtures.js";
import { WebUiController } from "../../../webui/controller.js";
import { startWebUiServer } from "../../../webui/server.js";

const temporaryRoot = await realpath(tmpdir());
const base = await mkdtemp(join(temporaryRoot, "fatcat-document-ui-"));
const workspace = join(base, "workspace");
await mkdir(workspace);
let documentReference = "";
let imageReference = "";
let modelRequests = 0;
let imageRequests = 0;
const config = loadConfig({ HARNESS_PROVIDER: "kimi", MOONSHOT_API_KEY: "offline-document-ui-key", HARNESS_MAX_ITERATIONS: "4" });
const transport: typeof fetch = async (input, init) => {
	modelRequests++;
	const request = new Request(input, init);
	assert.equal(request.url, "https://api.moonshot.cn/v1/chat/completions");
	const body = await request.json() as { messages: Message[]; model: string; tools?: { function: { name: string } }[] };
	const messages = body.messages;
	assert.equal(body.model, "kimi-k2.6");
	const respond = (message: unknown, reason = "stop", promptTokens = 20) => Response.json({
		choices: [{ finish_reason: reason, message }], usage: { prompt_tokens: promptTokens, completion_tokens: 10, total_tokens: promptTokens + 10 },
	});
	if (messages.some((message) => Array.isArray(message.content))) {
		imageRequests++;
		const parts = messages[1]!.content;
		assert.ok(Array.isArray(parts));
		assert.ok(parts.some((part) => part.type === "image_url" && part.image_url.url.startsWith("data:image/png;base64,")));
		const transcription = String(messages[0]?.content).startsWith("Transcribe");
		return respond({ role: "assistant", content: transcription ? "Project Atlas\nTwo reviews required\n[uncertain: owner]"
			: "The image shows an illustrative mark. This description is not a complete transcription." }, "stop", 1800);
	}
	const prompt = String(messages.findLast((message) => message.role === "user")?.content);
	if (messages.at(-1)?.role === "user") {
		if (prompt === "Delegate page two inspection." && body.tools?.some((tool) => tool.function.name === "delegate_task")) {
			return respond({ role: "assistant", content: null, tool_calls: [{ id: "delegate-source", type: "function", function: {
				name: "delegate_task", arguments: JSON.stringify({ task: "Read only page two and report the evidence." }),
			} }] }, "tool_calls");
		}
		const mode = prompt === "Describe the image." ? "visual" : prompt === "Transcribe the image." ? "transcribe" : undefined;
		const toolCalls = [{ id: "read-document", type: "function" as const, function: { name: "read",
			arguments: JSON.stringify(mode ? { path: imageReference, mode, pages: [1] } : { path: documentReference, pages: [2] }) } }];
		return respond({ role: "assistant", content: null, tool_calls: toolCalls }, "tool_calls");
	}
	const tool = messages.at(-1);
	assert.equal(tool?.role, "tool");
	const result = JSON.parse(String(tool?.content)) as { ok: boolean; result: { units: { citation: string }[]; attachmentReads?: { units: { citation: string }[] }[] } };
	assert.equal(result.ok, true);
	if (result.result.attachmentReads) return respond({ role: "assistant",
		content: `Delegated source: [Delegated evidence](${result.result.attachmentReads[0]!.units[0]!.citation}).` });
	const label = prompt === "Describe the image." ? "Visual evidence" : prompt === "Transcribe the image." ? "Transcribed evidence" : "Page two evidence";
	return respond({ role: "assistant", content: `Selected source: [${label}](${result.result.units[0]!.citation}).` });
};
const factory = async (root: string) => createAgent(config, await createTools(root), transport);
const store = new SessionStore({ root: join(base, "sessions") });
const manager = await SessionManager.open(await factory(workspace), { workspace, store, agentForWorkspace: factory });
const project = await manager.createProject("Document research", workspace);
await manager.newSession("Uploader", project.id);
const files = new Map<string, Awaited<ReturnType<SessionManager["uploadAttachment"]>>>();
const pdf = pdfFixture(["Page one evidence", "Page two evidence"]);
for (const [name, bytes] of [["report.pdf", pdf], ["proposal.docx", officeFixture("docx")], ["budget.xlsx", officeFixture("xlsx")],
	["briefing.pptx", officeFixture("pptx")], ["scan.png", imageFixture()], ["legacy.doc", Buffer.from("Legacy format")]] as const) {
	const target = await manager.beginAttachmentUpload(manager.current.id, name, bytes.length);
	files.set(name, await manager.uploadAttachment(target, (async function* () { yield bytes; })()));
}
documentReference = attachmentReference(files.get("report.pdf")!);
imageReference = attachmentReference(files.get("scan.png")!);
await manager.newSession("Reader", project.id);
const reader = manager.current.id;
const controller = await WebUiController.create({ workspace, provider: config.provider, model: config.model, permission: "read-only",
	shellPermission: "deny", webPermission: "deny", maxIterations: config.maxIterations, maxRequestBytes: 262144, skills: 0, warnings: [] }, manager);
const server = await startWebUiServer(controller, 0);
let browser: Browser | undefined;

try {
	browser = await chromium.launch({ channel: "msedge", headless: true });
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(server.url);
	await page.getByRole("button", { name: "Attachments", exact: true }).click();
	const source = page.locator("#attachment-source");
	const open = async (name: string) => {
		await page.locator(`[data-attachment-id="${files.get(name)!.id}"]`).getByRole("button", { name: "View source", exact: true }).click();
		await source.locator(".attachment-document-unit").first().waitFor();
	};
	await open("proposal.docx");
	assert.match(await source.innerText(), /Project Atlas.*Paragraph 1/s);
	assert.match(await source.innerText(), /Launch requires two reviews/);
	assert.match(await source.innerText(), /Parse documents-v1/);
	await page.getByRole("button", { name: "Close source", exact: true }).click();
	await open("budget.xlsx");
	assert.match(await source.innerText(), /Budget!B3/);
	assert.match(await source.innerText(), /SUM\(B1:B2\)/);
	assert.match(await source.innerText(), /Cached result \(unverified\).*999/s);
	assert.match(await source.innerText(), /has not been recalculated/);
	await page.getByRole("button", { name: "Close source", exact: true }).click();
	await open("briefing.pptx");
	assert.match(await source.innerText(), /Slide 1 · speaker notes/);
	assert.match(await source.innerText(), /confirm project ownership/);
	await page.getByRole("button", { name: "Close source", exact: true }).click();
	await open("scan.png");
	assert.match(await source.innerText(), /No native text is assumed/);
	assert.match(await source.innerText(), /Not covered:/);
	await page.getByRole("button", { name: "Close source", exact: true }).click();
	const legacy = page.locator(`[data-attachment-id="${files.get("legacy.doc")!.id}"]`);
	assert.match(await legacy.innerText(), /analysis unavailable for this format/);
	assert.equal(await legacy.getByRole("button", { name: "View source", exact: true }).count(), 0);
	assert.equal(modelRequests, 0, "Source previews must not request a model.");
	await page.getByRole("button", { name: "Close attachments", exact: true }).click();
	await page.getByLabel("Message Fatcat", { exact: true }).fill("Read page two of the report.");
	await page.getByLabel("Message Fatcat", { exact: true }).press("Enter");
	await page.getByRole("button", { name: "Page two evidence", exact: true }).click();
	await source.getByRole("heading", { name: "Page 2", exact: true }).waitFor();
	assert.match(await source.innerText(), /Requested location: page-2/);
	assert.equal(await source.locator(".attachment-document-unit").count(), 1);
	assert.match(await source.locator(".attachment-source-text").innerText(), /Page two evidence/);
	const download = page.waitForEvent("download");
	await source.getByRole("button", { name: "Download original", exact: true }).click();
	assert.deepEqual(await readFile((await (await download).path())!), pdf);
	await page.getByRole("button", { name: "Browse document", exact: true }).click();
	await source.getByRole("heading", { name: "Page 1", exact: true }).waitFor();
	assert.equal(await source.locator(".attachment-document-unit").count(), 2);
	if (process.env.FATCAT_VERIFY_SCREENSHOT) await page.screenshot({ path: resolve(`${process.env.FATCAT_VERIFY_SCREENSHOT}.documents.png`), animations: "disabled" });
	await page.getByRole("button", { name: "Close source", exact: true }).click();
	await page.locator(".attachment-sources summary").click();
	assert.match(await page.locator(".attachment-sources").innerText(), /1 of 1 selected locations returned; 2 locations/);
	assert.equal(modelRequests, 2);
	await page.reload();
	await page.locator(".attachment-sources summary").click();
	assert.match(await page.locator(".attachment-sources").innerText(), /Page 2 · native-text/);
	assert.equal(manager.current.id, reader);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.getByRole("button", { name: "Page 2 · native-text", exact: true }).click();
	await source.getByRole("heading", { name: "Page 2", exact: true }).waitFor();
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
	await page.getByRole("button", { name: "Close source", exact: true }).click();
	await page.setViewportSize({ width: 1280, height: 900 });
	for (const [prompt, label, provenance] of [["Describe the image.", "Visual evidence", "Model description"],
		["Transcribe the image.", "Transcribed evidence", "Model transcription"]] as const) {
		await page.getByLabel("Message Fatcat", { exact: true }).fill(prompt);
		await page.getByLabel("Message Fatcat", { exact: true }).press("Enter");
		await page.getByRole("button", { name: label, exact: true }).click();
		await source.getByText(new RegExp(provenance)).first().waitFor();
		assert.match(await source.innerText(), /kimi · kimi-k2\.6/);
		assert.match(await source.innerText(), /may contain omissions or recognition errors/);
		if (provenance === "Model description") assert.match(await source.innerText(), /not a verbatim transcription/);
		else assert.match(await source.innerText(), /Two reviews required/);
		await page.getByRole("button", { name: "Close source", exact: true }).click();
		const turn = controller.snapshot().turns.at(-1)!;
		assert.equal(turn.report?.modelRequests.parent, 3);
		assert.equal(controller.snapshot().contextUsage.promptTokens, 20);
		assert.equal(turn.sources?.reads[0]?.mode, provenance === "Model description" ? "visual" : "transcribe");
	}
	assert.equal(imageRequests, 2);
	assert.equal(modelRequests, 8);
	assert.equal(JSON.stringify(manager.history).includes("data:image"), false);
	assert.equal(JSON.stringify(manager.history).includes(config.apiKey), false);
	await page.getByRole("button", { name: "New chat in Document research", exact: true }).click();
	await page.getByRole("button", { name: "Attachments", exact: true }).click();
	await open("scan.png");
	assert.match(await source.innerText(), /Model transcription/);
	assert.match(await source.innerText(), /Two reviews required/);
	assert.equal(modelRequests, 8, "Another project chat should reuse the saved transcription without an API request.");
	await page.getByRole("button", { name: "Close source", exact: true }).click();
	await page.getByRole("button", { name: "Close attachments", exact: true }).click();
	await page.getByLabel("Message Fatcat", { exact: true }).fill("Delegate page two inspection.");
	await page.getByLabel("Message Fatcat", { exact: true }).press("Enter");
	await page.getByRole("button", { name: "Delegated evidence", exact: true }).waitFor();
	await page.locator(".attachment-sources summary").click();
	assert.match(await page.locator(".attachment-sources").innerText(), /report\.pdf · document · subagent/);
	assert.equal(controller.snapshot().turns[0]!.sources?.reads[0]?.origin, "subagent");
	await page.getByRole("button", { name: "Page 2 · native-text", exact: true }).click();
	await source.getByRole("heading", { name: "Page 2", exact: true }).waitFor();
	assert.equal(modelRequests, 12);
	assert.deepEqual(errors, []);
	console.log("Verified real Edge with real local parsing and createAgent: project-shared DOCX headings, XLSX formula/cache warnings, PPTX notes, PNG uncovered status, legacy format status, immutable PDF source selection and exact download, source evidence after reload, mobile layout, same-model visual/transcription source provenance and request accounting, no credential/image bytes in history, cross-chat cached transcription without another model request, and delegated source evidence with working source links. SDK responses were injected; no live API calls or visual-quality claim.");
} finally {
	await browser?.close();
	await server.close();
	const target = resolve(base);
	if (dirname(target) !== temporaryRoot || !basename(target).startsWith("fatcat-document-ui-")) throw new Error("Refusing to remove an unexpected document fixture directory.");
	await rm(target, { recursive: true, force: true });
}
