import assert from "node:assert/strict";
import { createTerminalInput } from "@fatcat/cli/internal/terminal";
import { withAskUser } from "@fatcat/runtime/tools/ask-user";
import { defaultTools } from "@fatcat/runtime/tools";
import { Session } from "@fatcat/runtime/session/session";
import { TuiApp } from "@fatcat/tui/internal/app";
import { setTimeout as delay } from "node:timers/promises";

assert.equal(process.platform, "win32");
assert.ok(process.stdin.isTTY && process.stdout.isTTY, "Use a native Windows interactive terminal.");
const raw = process.stdin.isRaw;
const interrupts = process.listenerCount("SIGINT");
const terminal = createTerminalInput(process.stdin, process.stdout);
try {
	assert.equal(await terminal.askUser({ question: "Choose JSON by entering 2", options: ["Text", "JSON"] }), "JSON");
	assert.equal(await terminal.askUser({ question: "Enter /skip to skip this clarification" }), null);
} finally { terminal.close(); }

const app = new TuiApp({ config: { provider: "deepseek", region: "global", model: "injected-questions", maxIterations: 3,
	requestTimeoutMs: 60000, maxRequestBytes: 262144 }, workspace: process.cwd(), permission: "read-only",
	shellPermission: "deny", webPermission: "deny", skills: 0, color: false });
const prompts: string[] = [];
const tools = withAskUser(defaultTools, app.askUser);
const session = new Session({ tools, maxIterations: 3, model: async (messages, signal) => {
	if (messages.at(-1)?.role === "tool") {
		const result = JSON.parse(String(messages.at(-1)?.content));
		assert.equal(result.result.answer, "JSON");
		return { message: { role: "assistant", content: "QUESTION ANSWERED; draft restored" } };
	}
	const prompt = String(messages.at(-1)?.content);
	prompts.push(prompt);
	if (prompt === "ask" || prompt === "cancel") {
		await delay(1500, undefined, { signal });
		return { message: { role: "assistant", content: null, toolCalls: [{ id: prompt, name: "ask_user",
			arguments: JSON.stringify({ question: prompt === "ask" ? "Choose JSON with 2" : "Press Esc to cancel", options: ["Text", "JSON"] }) }] } };
	}
	return { message: { role: "assistant", content: prompt === "draft" ? "DRAFT VERIFIED" : "CONTINUED" } };
} });
console.log("TUI: submit ask, immediately type draft without Enter, answer 2, submit the restored draft. Then submit cancel, wait for the question, Esc; submit continue, then Ctrl+D.");
const code = await app.run(session);
assert.equal(code, 1);
assert.deepEqual(prompts, ["ask", "draft", "cancel", "continue"]);
assert.deepEqual(session.messages.filter((message) => message.role === "user").map((message) => message.content), ["ask", "draft", "continue"]);
assert.equal(process.stdin.isRaw, raw);
assert.equal(process.listenerCount("SIGINT"), interrupts);
console.log(JSON.stringify({ passed: true, checks: "Native CLI choices/skip; TUI draft restoration, cancellation and continuation; terminal cleanup", liveModelRequests: 0 }));
