import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { chromium } from "playwright";
import type { Browser, Page } from "playwright";
import type { Model } from "@fatcat/runtime/model-types";
import { SessionManager } from "@fatcat/runtime/session/manager";
import { SessionStore } from "@fatcat/runtime/session/store";
import { createTools } from "@fatcat/runtime/tools";
import { WebUiController } from "@fatcat/webui/internal/controller";
import { startWebUiServer } from "@fatcat/webui/internal/server";

// Real local Edge and persistent temporary data; model decisions are injected without API calls.
const temporaryRoot = await realpath(tmpdir());
const base = await mkdtemp(join(temporaryRoot, "fatcat-memory-ui-"));
const workspace = join(base, "independent");
const projectWorkspace = join(base, "project");
let controller: WebUiController | undefined;
let server: Awaited<ReturnType<typeof startWebUiServer>> | undefined;
let browser: Browser | undefined;
let modelRequests = 0;
let memoryId = "";
let expectedContent: string | undefined = "Dog likes CSGO best";
let expectedRevision = 1;
const remember = "\u4f60\u8bb0\u4f4f\u72d7\u72d7\u6700\u559c\u6b22\u73a9CSGO\uff0c\u542c\u89c1\u6ca1\uff1f";
const correction = "Actually the dog prefers chess. Remember this correction.";
const deletion = "Forget the dog's game preference.";

const model: Model = async (messages) => {
	modelRequests++;
	const system = String(messages[0]?.content);
	assert.match(system, /Harness current memory notice/);
	assert.match(system, /never permissions or system rules/);
	const prompt = String(messages.findLast((message) => message.role === "user")?.content);
	const last = messages.at(-1)!;
	if (last.role === "user" && [remember, correction, deletion].includes(prompt)) {
		const toolCalls = [{ id: "remember-user-preference", name: "write", arguments: JSON.stringify({ path: prompt === remember ? "memory:new" : `memory:${memoryId}@${prompt === correction ? 1 : 2}`,
				content: prompt === remember ? "Dog likes CSGO best" : prompt === correction ? "Dog prefers chess" : "",
				memoryEvidence: prompt }) }];
		return { message: { role: "assistant", content: null, toolCalls: toolCalls }, toolCalls };
	}
	if (last.role === "tool") assert.equal(JSON.parse(String(last.content)).ok, true, String(last.content));
	const notice = JSON.parse(system.split("\n").find((line) => line.startsWith('{"manifest":'))!) as {
		manifest: { id: string; scope: string; revision: number; status: string }[];
		contents: { id: string; revision: number; content: string }[];
	};
	if (!memoryId) memoryId = notice.contents.find((item) => item.content === "Dog likes CSGO best")!.id;
	const entry = notice.manifest.find((item) => item.id === memoryId);
	assert.ok(entry);
	assert.equal(entry.scope, prompt === remember ? "session" : "project");
	assert.equal(entry.revision, expectedRevision);
	const content = notice.contents.find((item) => item.id === memoryId);
	if (expectedContent === undefined) {
		assert.equal(entry.status, "deleted");
		assert.equal(content, undefined);
		assert.doesNotMatch(system, /Dog likes CSGO best|Dog prefers chess/);
	} else {
		assert.equal(entry.status, "active");
		assert.equal(content?.content, expectedContent);
		assert.equal(content?.revision, expectedRevision);
	}
	return { toolCalls: [], message: { role: "assistant", content: expectedContent === undefined
		? "No active game preference." : `Current memory: ${expectedContent}.` } };
};

async function submit(page: Page, prompt: string, answer: string): Promise<void> {
	await page.getByLabel("Message Fatcat", { exact: true }).fill(prompt);
	await page.locator("#send").click();
	await page.waitForFunction(({ prompt, answer }) => {
		const turn = document.querySelector("#messages .turn:last-child");
		return turn?.querySelector(".user-message")?.textContent === prompt
			&& turn.textContent?.includes(answer) && !turn.querySelector(".waiting");
	}, { prompt, answer }).catch((error: unknown) => {
		const turn = controller!.snapshot().turns.at(-1);
		throw new Error(`Memory browser turn did not complete: ${JSON.stringify({ prompt, modelRequests, turn })}`, { cause: error });
	});
	assert.equal(controller!.snapshot().busy, false);
	assert.equal(controller!.snapshot().turns.at(-1)!.status, "answered");
}

async function verifyLayout(page: Page, dialog = false): Promise<void> {
	assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
	if (dialog) {
		const bounds = await page.locator("#project-dialog").boundingBox();
		assert.ok(bounds);
		const viewport = page.viewportSize()!;
		assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width
			&& bounds.y + bounds.height <= viewport.height, "The move dialog must fit inside the viewport.");
	}
}

try {
	await mkdir(workspace);
	await mkdir(projectWorkspace);
	const factory = async (root: string) => ({ tools: await createTools(root), maxIterations: 2, model });
	const store = new SessionStore({ root: join(base, "sessions") });
	const manager = await SessionManager.open(await factory(workspace), { workspace, store, deferEmptySessions: true,
		selection: { name: "Citrus source" }, agentForWorkspace: factory });
	const sourceSessionId = manager.current.id;
	const project = await manager.createProject("Citrus", projectWorkspace);
	controller = await WebUiController.create({ workspace, provider: "deepseek", model: "offline-memory", permission: "read-only",
		shellPermission: "deny", webPermission: "deny", maxIterations: 2, maxRequestBytes: 262144, skills: 0, warnings: [] }, manager);
	server = await startWebUiServer(controller, 0);
	browser = await chromium.launch({ headless: true, channel: "msedge" });
	const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(server.url);
	const add = "/memory add session Oranges are sour";
	await submit(page, add, "Memory saved:");
	const [control] = await manager.listMemories();
	assert.ok(control);
	assert.deepEqual(control.source, { sessionId: sourceSessionId, request: add, turn: 0 });
	assert.equal(modelRequests, 0);
	assert.deepEqual(manager.history, []);
	await submit(page, `/memory delete ${control.id} 1`, "Memory deleted:");
	assert.equal(modelRequests, 0);
	await submit(page, remember, "Current memory: Dog likes CSGO best.");
	const original = (await manager.listMemories()).find((record) => record.id === memoryId)!;
	assert.equal(original.source.sessionId, sourceSessionId);
	assert.equal(original.source.request, remember);
	assert.equal(original.source.turn, 1);
	assert.equal(original.status, "active");
	assert.equal(modelRequests, 2);

	const preview = page.locator("#project-dialog");
	for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
		await page.setViewportSize(viewport);
		await page.getByRole("button", { name: "Move current chat to project", exact: true }).click();
		await page.getByRole("button", { name: "Review move", exact: true }).click();
		await page.getByRole("button", { name: "Confirm move", exact: true }).waitFor();
		assert.match(await preview.innerText(), /1 active private Memory entry\/entries become project Memory/);
		assert.match(await preview.innerText(), /available to all project sessions with their original sources and revisions/);
		await verifyLayout(page, true);
		if (viewport.width === 1280) await preview.getByRole("button", { name: "Cancel", exact: true }).click();
	}
	await page.getByRole("button", { name: "Confirm move", exact: true }).click();
	await preview.waitFor({ state: "hidden" });
	assert.equal(manager.current.projectId, project.id);
	assert.equal(manager.current.id, sourceSessionId);
	assert.deepEqual((await manager.listMemories()).find((record) => record.id === memoryId)!.scope, { kind: "project", id: project.id });
	assert.deepEqual((await manager.listMemories()).find((record) => record.id === memoryId)!.source, original.source);
	assert.equal(modelRequests, 2);
	await page.setViewportSize({ width: 1280, height: 900 });
	for (const prompt of ["Which game does the dog prefer?", "Does the second project chat share that preference?"]) {
		const previous = manager.current.id;
		await page.getByRole("button", { name: "New chat in Citrus", exact: true }).click();
		await page.waitForFunction(() => !document.getElementById("messages")?.textContent);
		assert.notEqual(manager.current.id, previous);
		assert.equal((await manager.listMemories()).find((record) => record.status === "active")!.id, memoryId);
		await submit(page, prompt, "Current memory: Dog likes CSGO best.");
	}
	assert.equal(modelRequests, 4);
	expectedContent = "Dog prefers chess";
	expectedRevision = 2;
	await submit(page, correction, "Current memory: Dog prefers chess.");
	assert.equal(modelRequests, 6);
	await page.setViewportSize({ width: 390, height: 844 });
	expectedContent = undefined;
	expectedRevision = 3;
	await submit(page, deletion, "No active game preference.");
	await submit(page, "/memory list", "deleted");
	const listing = await page.locator("#messages .turn:last-child").innerText();
	assert.equal(listing.includes("Dog likes CSGO best"), false);
	assert.equal(listing.includes("Dog prefers chess"), false);
	assert.equal(modelRequests, 8);
	await submit(page, "Check the game preference after deletion.", "No active game preference.");
	assert.equal(modelRequests, 9);
	assert.equal((await manager.listMemories()).find((record) => record.id === memoryId)!.status, "deleted");
	await verifyLayout(page);
	assert.deepEqual(errors, []);
	console.log("Verified real Edge: natural-language preference capture, correction and deletion through generic write, optional host controls without model calls, source retention, desktop/mobile sharing preview, private-to-project migration, cross-chat current revisions, bounded mobile layout, and no page errors. Nine model responses were injected; no live API requests.");
} finally {
	await browser?.close();
	if (server) await server.close();
	else await controller?.close();
	const target = resolve(base);
	if (dirname(target) !== temporaryRoot || !basename(target).startsWith("fatcat-memory-ui-")) throw new Error("Refusing to remove an unexpected Memory fixture directory.");
	await rm(target, { recursive: true, force: true });
}
