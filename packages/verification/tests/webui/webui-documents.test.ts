import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import type { Message } from "@fatcat/runtime/model";
import { attachmentReference } from "@fatcat/runtime/attachments/record";
import { SessionManager } from "@fatcat/runtime/session/manager";
import { SessionStore } from "@fatcat/runtime/session/store";
import { createTools } from "@fatcat/runtime/tools";
import { createAgent } from "@fatcat/runtime/agent";
import { loadConfig } from "@fatcat/runtime/config";
import { attachmentEvidence } from "@fatcat/webui/internal/attachment-evidence";
import { parseSourceReference } from "@fatcat/webui/internal/client/attachments";
import { WebUiController } from "@fatcat/webui/internal/controller";
import { startWebUiServer } from "@fatcat/webui/internal/server";
import { temporaryWorkspace } from "../support/workspace.js";

const reference = `attachment:${randomUUID()}@${"a".repeat(64)}`;

function readMessages(result: unknown, name = "read"): Message[] {
	return [{ role: "assistant", content: null, tool_calls: [{ id: "source-read", type: "function", function: { name, arguments: "{}" } }] },
		{ role: "tool", tool_call_id: "source-read", content: JSON.stringify({ ok: true, result }) }];
}

test("document citation parsing preserves exact parse versions and rejects ambiguous locations", () => {
	assert.deepEqual(parseSourceReference(`${reference}#parse=documents-v1&unit=page-2`), {
		reference, offset: 0, limit: 100, parserVersion: "documents-v1", unit: "page-2",
	});
	for (const fragment of ["parse=v1", "parse=v1&unit=", "parse=v1&unit=page-2&unit=page-3", "parse=v1&parse=v2&unit=p1",
		"parse=v1&unit=../../secret", "parse=v1&unit=%00", "parse=v1&unit=p1%0A", "parse=v1&unit=p1\n", "parse=v1&unit=p1&mode=visual", "parse=v1&unit=p1&path=secret",
		`parse=${"a".repeat(97)}&unit=p1`, "parse=v1&unit=p1#L1-L1"]) {
		assert.equal(parseSourceReference(`${reference}#${fragment}`), undefined, fragment);
	}
	assert.deepEqual(parseSourceReference(`${reference}#L2-L4`), { reference, offset: 1, limit: 3 });
});

test("source evidence records returned coverage and immutable locations instead of model answer claims", () => {
	const citation = `${reference}#parse=documents-v1&unit=page-2`;
	const history: Message[] = [{ role: "user", content: "Please review the complete document" }, ...readMessages({
		kind: "document", path: reference, name: "report.pdf", units: [{ id: "page-2", citation,
			location: { kind: "page", page: 2 }, text: "An untrusted source", provenance: "native-text" }],
		coverage: { mode: "document", complete: false, returnedUnits: 1, selectedUnits: 3, totalUnits: 3, unreadUnits: 2, uncovered: ["Page 3 needs visual recognition"] },
		warnings: ["The chart was not parsed"],
	}), { role: "assistant", content: "I reviewed every page." }];
	const result = attachmentEvidence(history);
	assert.equal(result.reads.length, 1);
	assert.match(result.reads[0]!.summary, /1 of 3 selected locations.*2 locations were unread/);
	assert.deepEqual(result.reads[0]!.citations, [{ reference: citation, label: "Page 2 · native-text" }]);
	assert.deepEqual(result.reads[0]!.warnings, ["The chart was not parsed", "Page 3 needs visual recognition"]);
	assert.equal(JSON.stringify(result).includes("I reviewed every page"), false);
});

test("source evidence distinguishes transcription, descriptions and search from full native reading", () => {
	const vision = attachmentEvidence(readMessages({ kind: "document", path: reference, name: "scan.png",
		units: [{ id: "image", location: { kind: "image" }, provenance: "model-description", citation: `${reference}#parse=vision-abc&unit=image` }],
		coverage: { mode: "visual", complete: true, returnedUnits: 1, selectedUnits: 1, totalUnits: 1 }, warnings: [],
	}));
	assert.equal(vision.reads[0]!.mode, "visual");
	assert.equal(vision.reads[0]!.citations[0]!.label, "image · model-description");
	const search = attachmentEvidence(readMessages({ kind: "search", path: reference, name: "notes.md", totalMatches: 2,
		matches: [{ line: 7, citation: `${reference}#L7-L7` }], coverage: { complete: true },
	}));
	assert.match(search.reads[0]!.summary, /1 of 2 matching lines.*does not establish full reading/);
});

test("source evidence ignores unrelated, failed and malformed tool data and bounds visible links", () => {
	const result = { kind: "file", path: reference, name: "evidence.md", startLine: 1, endLine: 2, totalLines: 20,
		citation: `${reference}#L1-L2`, coverage: { complete: false } };
	assert.deepEqual(attachmentEvidence(readMessages(result, "shell")).reads, []);
	assert.deepEqual(attachmentEvidence([{ role: "tool", tool_call_id: "source-read", content: JSON.stringify({ ok: true, result }) }]).reads, []);
	assert.deepEqual(attachmentEvidence(readMessages({ ...result, path: "file:///C:/private" })).reads, []);
	const failed = readMessages(result);
	failed[1] = { role: "tool", tool_call_id: "source-read", content: '{"ok":false,"error":{"message":"Failed"}}' };
	assert.deepEqual(attachmentEvidence(failed).reads, []);
	const many = attachmentEvidence(readMessages({ kind: "document", path: reference, name: "notes.docx",
		units: Array.from({ length: 20 }, (_, index) => ({ id: `p${index}`, location: { paragraph: index + 1 },
			provenance: "native-text", citation: `${reference}#parse=documents-v1&unit=p${index}` })),
		coverage: { mode: "document", complete: true, returnedUnits: 20, selectedUnits: 20, totalUnits: 20 },
	}));
	assert.equal(many.reads[0]!.citations.length, 8);
	assert.equal(many.reads[0]!.omittedLocations, 12);
});

test("delegated attachment evidence retains actual coverage and identifies bounded omitted locations", () => {
	const citation = `${reference}#parse=documents-v1&unit=page-2`;
	const child = { kind: "document", path: reference, name: "report.pdf", sourceLocationCount: 12,
		units: [{ id: "page-2", location: { kind: "page", page: 2 }, provenance: "native-text", citation }],
		coverage: { mode: "document", returnedUnits: 12, selectedUnits: 20, totalUnits: 20, unreadUnits: 8, complete: false } };
	const result = attachmentEvidence(readMessages({ answer: "I reviewed every page.", attachmentReads: [child], omittedAttachmentReads: 2 }, "delegate_task"));
	assert.equal(result.reads[0]!.origin, "subagent");
	assert.match(result.reads[0]!.summary, /12 of 20 selected locations.*8 locations were unread/);
	assert.deepEqual(result.reads[0]!.citations, [{ reference: citation, label: "Page 2 · native-text" }]);
	assert.equal(result.reads[0]!.omittedLocations, 11);
	assert.equal(result.omittedReads, 2);
	assert.deepEqual(attachmentEvidence(readMessages({ answer: "Unverified", attachmentReads: [child] }, "shell")).reads, []);
});

test("Web UI restores real delegated reads from the executing project's saved tool history", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	let source = "";
	const config = loadConfig({ DEEPSEEK_API_KEY: "offline-child-source", HARNESS_MAX_ITERATIONS: "4" });
	const factory = async (root: string) => createAgent(config, await createTools(root), async (input, init) => {
		const body = await new Request(input, init).json() as { tools?: { function: { name: string } }[]; messages: Message[] };
		const parent = body.tools?.some((tool) => tool.function.name === "delegate_task");
		if (body.messages.at(-1)?.role === "user") {
			const call = { id: parent ? "delegate" : "child-read", type: "function", function: {
				name: parent ? "delegate_task" : "read", arguments: JSON.stringify(parent ? { task: `Read ${source} and report its content.` } : { path: source }),
			} };
			return Response.json({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [call] } }] });
		}
		return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: parent ? "Finished the delegated read." : "Read the shared project note." } }] });
	});
	const store = new SessionStore({ root: join(base, "sessions") });
	const manager = await SessionManager.open(await factory(workspace), { workspace, store, agentForWorkspace: factory });
	const project = await manager.createProject("Shared evidence", workspace);
	await manager.newSession("Uploader", project.id);
	const bytes = Buffer.from("Project decision\nPreserve independent histories");
	const target = await manager.beginAttachmentUpload(manager.current.id, "decision.md", bytes.length);
	source = attachmentReference(await manager.uploadAttachment(target, (async function* () { yield bytes; })()));
	await manager.newSession("Reader", project.id);
	const info = { workspace, provider: config.provider, model: config.model, permission: "read-only", shellPermission: "deny", webPermission: "deny",
		maxIterations: config.maxIterations, maxRequestBytes: config.maxRequestBytes, skills: 0, warnings: [] };
	const controller = await WebUiController.create(info, manager);
	t.after(() => controller.close());
	controller.submit("Delegate the shared note inspection.");
	const deadline = Date.now() + 5000;
	while (controller.snapshot().busy) { assert.ok(Date.now() < deadline); await delay(10); }
	const turn = controller.snapshot().turns[0]!;
	assert.equal(turn.error, undefined);
	assert.equal(turn.sources?.reads[0]?.origin, "subagent");
	assert.equal(turn.sources?.reads[0]?.reference, source);
	assert.equal(turn.sources?.reads[0]?.citations[0]?.reference, `${source}#L1-L2`);
	await controller.close();
	const restored = await WebUiController.create(info, await SessionManager.open(await factory(workspace), {
		workspace, store, agentForWorkspace: factory, selection: { resume: manager.current.id },
	}));
	t.after(() => restored.close());
	assert.deepEqual(restored.snapshot().turns[0]!.sources, turn.sources);
});

test("document source HTTP preserves parse locations, rechecks scope and never triggers visual model calls", async (t) => {
	const { base, workspace } = await temporaryWorkspace(t);
	let modelRequests = 0;
	const factory = async (root: string) => ({ tools: await createTools(root), maxIterations: 1, model: async () => {
		modelRequests++;
		return { toolCalls: [], message: { role: "assistant" as const, content: "Offline answer" } };
	} });
	const manager = await SessionManager.open(await factory(workspace), { workspace,
		store: new SessionStore({ root: join(base, "sessions") }), agentForWorkspace: factory });
	const project = await manager.createProject("Document sources", workspace);
	await manager.newSession("Uploader", project.id);
	const bytes = Buffer.from("# Introduction\nFirst section\n# Details\nExact second section");
	const target = await manager.beginAttachmentUpload(manager.current.id, "source.md", bytes.length);
	const record = await manager.uploadAttachment(target, (async function* () { yield bytes; })());
	await manager.newSession("Reader", project.id);
	const reader = manager.current.id;
	const controller = await WebUiController.create({ workspace, provider: "deepseek", model: "offline", permission: "read-only",
		shellPermission: "deny", webPermission: "deny", maxIterations: 1, maxRequestBytes: 262144, skills: 0, warnings: [] }, manager);
	const server = await startWebUiServer(controller, 0);
	t.after(() => server.close());
	const token = new URL(server.url).hash.slice("#token=".length);
	const post = (body: unknown) => fetch(`${server.origin}/api/attachments/read`, { method: "POST",
		headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
	const request = { sessionId: reader, reference: attachmentReference(record) };
	const section = await post({ ...request, section: "Details" });
	assert.equal(section.status, 200, await section.clone().text());
	const result = await section.json() as { parserVersion: string; units: { id: string; text: string; citation: string }[] };
	assert.deepEqual(result.units.map((unit) => unit.text), ["# Details", "Exact second section"]);
	const citation = parseSourceReference(result.units[1]!.citation)!;
	const source = await post({ sessionId: reader, ...citation });
	assert.equal(source.status, 200, await source.clone().text());
	assert.equal((await source.json() as { units: { text: string }[] }).units[0]!.text, "Exact second section");
	assert.equal((await post({ ...request, mode: "visual", pages: [1] })).status, 400);
	assert.equal((await post({ ...request, question: "Analyze this file" })).status, 400);
	assert.equal((await post({ ...request, parserVersion: "../other" })).status, 400);
	const old = await post({ ...request, parserVersion: "documents-unavailable", unit: result.units[0]!.id });
	assert.equal(old.status, 400);
	assert.match(await old.text(), /exact parse version is unavailable/);
	await manager.newSession("Private", null);
	assert.equal((await post({ ...request, sessionId: manager.current.id, parserVersion: result.parserVersion, unit: result.units[0]!.id })).status, 400);
	assert.equal(modelRequests, 0);
});
