import { fixtureTools } from "../support/tool-fixture.js";
import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "@fatcat/runtime/config";
import { createModel } from "@fatcat/runtime/model";
import type { Message } from "@fatcat/runtime/model-types";
import { runAgent } from "@fatcat/runtime/loop";


const config = { ...loadConfig({ DEEPSEEK_API_KEY: "offline-message-contract" }), thinking: "off" as const };
const call = { id: "sum-1", name: "fixture_add", arguments: '{"numbers":[1,2]}' };
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
		{ id: "sum-1", type: "function", function: { name: "fixture_add", arguments: '{"numbers":[1,2]}' } },
	] },
	{ role: "tool", tool_call_id: "sum-1", content: '{"ok":true,"result":3}' },
];

test("canonical history and tools encode to the existing SDK payload without mutating their owners", async () => {
	const before = structuredClone(history);
	const definitions = structuredClone(fixtureTools.definitions);
	let sent = "";
	const model = createModel(config, async (input, init) => {
		sent = await new Request(input, init).text();
		const body = JSON.parse(sent);
		assert.deepEqual(body.messages, wireHistory);
		assert.deepEqual(body.tools, [{ type: "function", function: definitions[0] }]);
		assert.equal(body.stream, false);
		return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "3" } }] });
	}, fixtureTools);
	const prepared = await model.prepare!(history);
	assert.equal(sent, "");
	const result = await model(history);
	assert.equal(result.message.content, "3");
	assert.equal(sent, prepared.json);
	assert.equal(prepared.bytes, Buffer.byteLength(sent));
	assert.deepEqual(history, before);
	assert.deepEqual(fixtureTools.definitions, definitions);
});

test("canonical tool arguments preserve malformed JSON as a recoverable tool result", async () => {
	let requests = 0;
	const model = createModel(config, async (input, init) => {
		const body = await new Request(input, init).json() as { messages: Record<string, unknown>[] };
		if (++requests === 1) return Response.json({ choices: [{ finish_reason: "tool_calls", message: {
			role: "assistant", content: null,
			tool_calls: [{ id: "bad-json", type: "function", function: { name: "fixture_add", arguments: "{" } }],
		} }] });
		assert.deepEqual(body.messages.at(-1), { role: "tool", tool_call_id: "bad-json",
			content: '{"ok":false,"error":{"code":"INVALID_ARGUMENTS","message":"Tool arguments must be valid JSON."}}' });
		return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Recovered" } }] });
	}, fixtureTools);
	assert.equal(await runAgent("Add", { tools: fixtureTools, model, maxIterations: 2 }), "Recovered");
	assert.equal(requests, 2);
});

test("the byte gate measures the encoded request, including tool schemas and call envelopes", async () => {
	const prepared = await createModel(config, undefined, fixtureTools).prepare!(history);
	let sent = 0;
	const model = createModel({ ...config, maxRequestBytes: prepared.bytes - 1 }, async () => {
		sent++;
		throw new Error("The byte gate must run before transport.");
	}, fixtureTools);
	assert.ok(Buffer.byteLength(JSON.stringify(history)) < prepared.bytes - 1);
	await assert.rejects(model(history), { code: "MODEL_CONTEXT_LIMIT" });
	assert.equal(sent, 0);
});

test("canonical image parts retain their exact data URL and detail at the Chat Completions boundary", async () => {
	const messages: Message[] = [{ role: "user", content: [
		{ type: "text", text: "Read this" },
		{ type: "image", url: "data:image/png;base64,AA==", detail: "high" },
	] }];
	const prepared = await createModel(config, undefined, fixtureTools).prepare!(messages, undefined, { toolChoice: "none", purpose: "document" });
	assert.deepEqual(JSON.parse(prepared.json).messages, [{ role: "user", content: [
		{ type: "text", text: "Read this" },
		{ type: "image_url", image_url: { url: "data:image/png;base64,AA==", detail: "high" } },
	] }]);
	assert.equal(JSON.parse(prepared.json).tools, undefined);
});

test("replay extras follow call IDs while outgoing text and arguments come only from canonical messages", async () => {
	const thinkingConfig = { ...config, thinking: "high" as const };
	const raw = { role: "assistant", content: "Original", reasoning_content: "Reasoning", opaque_state: { signature: "message" },
		tool_calls: ["a", "b"].map((id) => ({ id, type: "function", signature: `call-${id}`,
			function: { name: "fixture_add", arguments: '{"numbers":[1,2]}', signature: `function-${id}` } })) };
	const model = createModel(thinkingConfig, async () => Response.json({ choices: [{ finish_reason: "tool_calls", message: raw }] }), fixtureTools);
	const { message } = await model([{ role: "user", content: "Add" }]);
	message.content = "Current";
	message.toolCalls!.reverse();
	message.toolCalls![0]!.arguments = '{"numbers":[3,4]}';
	const before = structuredClone(message);
	const prepared = await model.prepare!([message]);
	assert.deepEqual(JSON.parse(prepared.json).messages, [{ ...raw, content: "Current", tool_calls: [
		{ ...raw.tool_calls[1], function: { ...raw.tool_calls[1]!.function, arguments: '{"numbers":[3,4]}' } },
		raw.tool_calls[0],
	] }]);
	assert.deepEqual(message, before);
	assert.ok(!JSON.stringify(message.providerReplay).includes('"arguments"'));
	assert.ok(!JSON.stringify(message.providerReplay).includes('"Original"'));
	const off = await createModel(config, undefined, fixtureTools).prepare!([message]);
	assert.deepEqual(JSON.parse(off.json).messages, [{ role: "assistant", content: "Current", tool_calls: [
		{ id: "b", type: "function", function: { name: "fixture_add", arguments: '{"numbers":[3,4]}' } },
		{ id: "a", type: "function", function: { name: "fixture_add", arguments: '{"numbers":[1,2]}' } },
	] }]);
});
