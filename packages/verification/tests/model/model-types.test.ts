import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "@fatcat/runtime/config";
import { createModel } from "@fatcat/runtime/model";
import type { Message } from "@fatcat/runtime/model-types";
import { runAgent } from "@fatcat/runtime/loop";
import { defaultTools } from "@fatcat/runtime/tools";

const config = { ...loadConfig({ DEEPSEEK_API_KEY: "offline-message-contract" }), thinking: "off" as const };
const call = { id: "sum-1", name: "sum", arguments: '{"numbers":[1,2]}' };
const history: Message[] = [
	{ role: "system", content: "Rules" },
	{ role: "user", content: "Add" },
	{ role: "assistant", content: null, toolCalls: [call] },
	{ role: "tool", callId: call.id, content: '{"ok":true,"result":3}' },
];
const wireHistory = [
	{ role: "system", content: "Rules" },
	{ role: "user", content: "Add" },
	{ role: "assistant", content: null, tool_calls: [
		{ id: "sum-1", type: "function", function: { name: "sum", arguments: '{"numbers":[1,2]}' } },
	] },
	{ role: "tool", tool_call_id: "sum-1", content: '{"ok":true,"result":3}' },
];

test("canonical history and tools encode to the existing SDK payload without mutating their owners", async () => {
	const before = structuredClone(history);
	const definitions = structuredClone(defaultTools.definitions);
	let sent = "";
	const model = createModel(config, async (input, init) => {
		sent = await new Request(input, init).text();
		const body = JSON.parse(sent);
		assert.deepEqual(body.messages, wireHistory);
		assert.deepEqual(body.tools, [{ type: "function", function: definitions[0] }]);
		assert.equal(body.stream, false);
		return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "3" } }] });
	});
	const prepared = await model.prepare!(history);
	assert.equal(sent, "");
	const result = await model(history);
	assert.equal(result.message.content, "3");
	assert.equal(sent, prepared.json);
	assert.equal(prepared.bytes, Buffer.byteLength(sent));
	assert.deepEqual(history, before);
	assert.deepEqual(defaultTools.definitions, definitions);
});

test("canonical tool arguments preserve malformed JSON as a recoverable tool result", async () => {
	let requests = 0;
	const model = createModel(config, async (input, init) => {
		const body = await new Request(input, init).json() as { messages: Record<string, unknown>[] };
		if (++requests === 1) return Response.json({ choices: [{ finish_reason: "tool_calls", message: {
			role: "assistant", content: null,
			tool_calls: [{ id: "bad-json", type: "function", function: { name: "sum", arguments: "{" } }],
		} }] });
		assert.deepEqual(body.messages.at(-1), { role: "tool", tool_call_id: "bad-json",
			content: '{"ok":false,"error":{"code":"INVALID_ARGUMENTS","message":"Tool arguments must be valid JSON."}}' });
		return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Recovered" } }] });
	});
	assert.equal(await runAgent("Add", { model, maxIterations: 2 }), "Recovered");
	assert.equal(requests, 2);
});

test("the byte gate measures the encoded request, including tool schemas and call envelopes", async () => {
	const prepared = await createModel(config).prepare!(history);
	let sent = 0;
	const model = createModel({ ...config, maxRequestBytes: prepared.bytes - 1 }, async () => {
		sent++;
		throw new Error("The byte gate must run before transport.");
	});
	assert.ok(Buffer.byteLength(JSON.stringify(history)) < prepared.bytes - 1);
	await assert.rejects(model(history), { code: "MODEL_CONTEXT_LIMIT" });
	assert.equal(sent, 0);
});

test("canonical image parts retain their exact data URL and detail at the Chat Completions boundary", async () => {
	const messages: Message[] = [{ role: "user", content: [
		{ type: "text", text: "Read this" },
		{ type: "image", url: "data:image/png;base64,AA==", detail: "high" },
	] }];
	const prepared = await createModel(config).prepare!(messages, undefined, { toolChoice: "none", purpose: "document" });
	assert.deepEqual(JSON.parse(prepared.json).messages, [{ role: "user", content: [
		{ type: "text", text: "Read this" },
		{ type: "image_url", image_url: { url: "data:image/png;base64,AA==", detail: "high" } },
	] }]);
	assert.equal(JSON.parse(prepared.json).tools, undefined);
});
