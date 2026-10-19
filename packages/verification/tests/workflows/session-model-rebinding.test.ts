import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { workspaceAgentFactory } from "@fatcat/runtime/agent";
import { attachmentReference } from "@fatcat/runtime/attachments/record";
import { loadConfig } from "@fatcat/runtime/config";
import { defaultModelSelection } from "@fatcat/runtime/model-catalog";
import { ModelConnections } from "@fatcat/runtime/model-connections";
import { SessionManager } from "@fatcat/runtime/session/manager";
import { SessionStore } from "@fatcat/runtime/session/store";
import { createTools } from "@fatcat/runtime/tools";
import { imageFixture } from "../fixtures/document-fixtures.js";
import { temporaryWorkspace } from "../support/workspace.js";

test("session switching rebinds parent, child, image and summary requests across workspaces", async (t) => {
	const { base, workspace, outside } = await temporaryWorkspace(t);
	const config = loadConfig({ DEEPSEEK_API_KEY: "offline-deepseek" });
	const selected = { ...defaultModelSelection("mimo"), thinking: "on" as const };
	const connections = new ModelConnections(config, { MIMO_API_KEY: "offline-mimo" });
	let reference = "";
	const seen: string[] = [];
	const factory = workspaceAgentFactory(config, (root) => createTools(root), async (input, init) => {
		const request = new Request(input, init);
		const body = await request.json() as { model: string; thinking: { type: string }; messages: { role: string; content: unknown }[];
			tools?: { function: { name: string } }[] };
		assert.equal(body.model, selected.model);
		assert.equal(request.headers.get("authorization"), "Bearer offline-mimo");
		assert.equal(new URL(request.url).hostname, "api.xiaomimimo.com");
		const parent = body.tools?.some((tool) => tool.function.name === "delegate_task");
		const image = body.messages.some((message) => Array.isArray(message.content));
		const kind = image ? "image" : !body.tools ? "summary" : parent ? "parent" : "child";
		seen.push(kind);
		assert.equal(body.thinking.type, kind === "parent" || kind === "child" ? "enabled" : "disabled");
		let message: Record<string, unknown> = { role: "assistant", content: `${kind} complete` };
		if (parent && body.messages.at(-1)?.role === "user") {
			const prompt = body.messages.at(-1)?.content;
			const call = prompt === "Delegate" ? { name: "delegate_task", arguments: JSON.stringify({ task: "Check the fixture" }) }
				: prompt === "Inspect image" ? { name: "read", arguments: JSON.stringify({ path: reference, mode: "visual", question: "Describe it" }) } : undefined;
			if (call) message = { role: "assistant", content: null, reasoning_content: "PRIVATE_PARENT",
				tool_calls: [{ id: "request-call", type: "function", function: call }] };
		}
		if (kind === "summary") assert.ok(!JSON.stringify(body).includes("PRIVATE_PARENT"));
		return Response.json({ choices: [{ finish_reason: message.tool_calls ? "tool_calls" : "stop", message }] });
	}, connections);
	const store = new SessionStore({ root: join(base, "sessions") });
	const manager = await SessionManager.open(await factory(workspace), { workspace, store, agentForWorkspace: factory });
	await manager.setModel(selected);
	const bytes = imageFixture();
	const target = await manager.beginAttachmentUpload(manager.current.id, "fixture.png", bytes.length);
	reference = attachmentReference(await manager.uploadAttachment(target, (async function* () { yield bytes; })()));
	await manager.run("Delegate");
	await manager.setWorkspace(outside);
	assert.deepEqual(manager.current.modelSelection, selected);
	await manager.run("Inspect image");
	await manager.compact();
	assert.deepEqual(seen, ["parent", "child", "parent", "parent", "image", "parent", "summary"]);
	assert.equal(manager.current.turnCount, 2);
	assert.ok(manager.context.summarizedMessages > 0);
	assert.deepEqual((await store.loadAny(manager.current.id)).modelSelection, selected);
});
