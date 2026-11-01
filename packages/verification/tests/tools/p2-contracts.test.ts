import assert from "node:assert/strict";
import test from "node:test";
import { createAgent } from "@fatcat/runtime/agent";
import { loadConfig } from "@fatcat/runtime/config";
import { createTools } from "@fatcat/runtime/tools";
import { parseBrowserRequest } from "@fatcat/runtime/internal/browser/protocol";
import { temporaryWorkspace } from "../support/workspace.js";

test("all sixteen production definitions retain explicit object contracts and distinct names", async (t) => {
	const { workspace } = await temporaryWorkspace(t);
	const base = await createTools(workspace, "workspace-write", undefined, { permission: "allow" }, { permission: "deny" }, undefined, {}, async () => null);
	const agent = createAgent(loadConfig({ DEEPSEEK_API_KEY: "offline" }), base, async () => { throw new Error("No model request expected"); },
		undefined, undefined, undefined, { list: async () => [] });
	assert.deepEqual(agent.tools.definitions.map((tool) => tool.name).sort(), ["read", "glob", "grep", "write", "edit", "shell", "output_read", "web", "browser",
		"image_read", "memory_search", "memory_read", "memory_write", "ask_user", "delegate_task", "automation"].sort());
	for (const definition of agent.tools.definitions) {
		assert.ok(definition.description && definition.description.length > 40, definition.name);
		assert.equal(definition.parameters?.type, "object", definition.name);
		assert.equal(definition.parameters?.additionalProperties, false, definition.name);
	}
	for (const [name, args] of [
		["glob", { pattern: "\ud800" }], ["grep", { query: "a", limit: null }], ["read", { path: ".", offset: null }],
		["output_read", { outputId: "00000000-0000-4000-8000-000000000000", limit: null }],
		["output_read", { outputId: "00000000-0000-4000-8000-000000000000", action: "search", query: "a", tail: false }],
		["memory_read", { path: "memory:list" }], ["memory_search", { limit: null }], ["memory_write", { path: "memory:new", content: "missing evidence" }],
		["ask_user", { question: "Which?", options: null }], ["image_read", { path: "a.png", question: null }],
		["delegate_task", { task: "a", extra: true }], ["write", { path: "a.txt", content: null }], ["edit", { path: "a.txt", edits: [] }],
		["shell", { command: "pwd", timeoutMs: null }], ["web", { action: "fetch", url: "https://example.com/" + "x".repeat(2048) }],
		["web", { action: "search", query: "test", offset: 1 }],
	] as const) {
		const result = await agent.tools.execute(name, JSON.stringify(args));
		assert.equal(result.ok, false, `${name}: ${JSON.stringify(result)}`);
		if (!result.ok) assert.equal(result.error.code, "INVALID_ARGUMENTS", name);
	}
});

test("browser defaults distinguish omission, empty collections and explicit null", () => {
	assert.deepEqual(parseBrowserRequest({ path: "index.html", steps: [], selectors: [] }).steps, []);
	for (const key of ["steps", "selectors", "viewport", "screenshot"]) {
		assert.throws(() => parseBrowserRequest({ path: "index.html", [key]: null }), { code: "INVALID_ARGUMENTS" });
	}
});
