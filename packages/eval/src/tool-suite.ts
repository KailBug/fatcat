import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createAgent } from "@fatcat/runtime/agent";
import { loadConfig } from "@fatcat/runtime/config";
import { createTurnReporter, type ExecutionReport } from "@fatcat/runtime/execution-report";
import type { Message } from "@fatcat/runtime/model-types";
import { SessionManager } from "@fatcat/runtime/session/manager";
import { createTools } from "@fatcat/runtime/tools";

export const toolCases = [
	{ id: "repair", split: "development", family: "repair" },
	{ id: "output", split: "development", family: "output" },
	{ id: "memory", split: "development", family: "memory" },
	{ id: "clarification", split: "development", family: "clarification" },
	{ id: "repair-unicode", split: "holdout", family: "repair" },
	{ id: "output-stderr", split: "holdout", family: "output" },
	{ id: "image", split: "holdout", family: "image" },
	{ id: "delegation", split: "holdout", family: "delegation" },
] as const;
export type ToolCase = typeof toolCases[number];
interface WireRequest { tools?: { function: { name: string } }[]; messages: { role: string; content: unknown; tool_call_id?: string }[] }
interface Step { name: string; args: object | ((last: Record<string, unknown>) => object) }
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ7sAAAAASUVORK5CYII=", "base64");
const prompt = "Remember that the fixture prefers blue. Correct that preference to green. Complete the fixture task.";
const response = (content: string) => Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] });

function plan(sample: ToolCase, file: string): Step[] {
	const stderr = sample.id === "output-stderr";
	const outputCommand = process.platform === "win32"
		? `[Console]::${stderr ? "Error" : "Out"}.Write(('x' * 1500000) + 'FINAL_SENTINEL')`
		: `head -c 1500000 /dev/zero | tr '\\0' x ${stderr ? ">&2" : ""}; printf FINAL_SENTINEL ${stderr ? ">&2" : ""}`;
	switch (sample.family) {
		case "repair": return [
			{ name: "glob", args: { pattern: "*.txt" } }, { name: "grep", args: { query: "wrong" } },
			{ name: "read", args: { path: file } },
			{ name: "edit", args: { path: file, edits: [{ oldText: "wrong", newText: "correct" }] } },
			{ name: "shell", args: { command: process.platform === "win32" ? "if ((Get-Content -Path *.txt -Raw) -notmatch 'correct') { exit 1 }" : "grep -q correct ./*.txt" } },
		];
		case "output": return [{ name: "shell", args: { command: outputCommand } },
			{ name: "output_read", args: (last) => ({ outputId: last.outputId, stream: stderr ? "stderr" : "stdout", tail: true, limit: 30 }) }];
		case "memory": return [
			{ name: "memory_write", args: { path: "memory:new", content: "The fixture prefers blue.", memoryEvidence: "Remember that the fixture prefers blue." } },
			{ name: "memory_read", args: (last) => ({ path: last.path }) },
			{ name: "memory_write", args: (last) => ({ path: last.path, content: "The fixture prefers green.", memoryEvidence: "Correct that preference to green." }) },
			{ name: "memory_read", args: (last) => ({ path: String(last.path).replace(/@\d+$/, "@1") }) },
			{ name: "memory_search", args: { query: "green" } },
		];
		case "clarification": return [{ name: "ask_user", args: { question: "Choose format", options: ["Text", "JSON"] } },
			{ name: "ask_user", args: { question: "Optional detail?" } }];
		case "image": return [{ name: "image_read", args: { path: "image.png", question: "Describe the image" } }];
		case "delegation": return [{ name: "delegate_task", args: { task: `Read ${file} and return its content.` } }];
	}
}

function toolResults(history: readonly Message[]): Record<string, unknown>[] {
	return history.filter((message) => message.role === "tool").map((message) => JSON.parse(String(message.content)) as Record<string, unknown>);
}

/** Grade observable final state, never require the injected policy's exact tool sequence. */
export async function gradeToolCase(sample: ToolCase, workspace: string, history: readonly Message[], report: ExecutionReport,
	memories: { content: string; revision: number }[]) {
	const results = toolResults(history);
	const values = results.filter((item) => item.ok === true).map((item) => item.result as Record<string, unknown>);
	assert.equal(report.outcome, "answered");
	switch (sample.family) {
		case "repair":
			assert.equal(await readFile(join(workspace, sample.id === "repair-unicode" ? "unicode.txt" : "source.txt"), "utf8"), sample.id === "repair-unicode" ? "\u4e2d\u6587 correct\r\n" : "correct\n");
			assert.ok(report.writes.some((item) => item.status === "committed"));
			assert.ok(report.commands.some((item) => item.succeeded && !item.laterWriteAttempt));
			break;
		case "output":
			assert.ok(values.some((item) => item.kind === "output" && String(item.content).endsWith("FINAL_SENTINEL") && item.captureTruncated === false));
			assert.ok(values.some((item) => item.success === true && Number(item.storedBytes) > 1500000));
			break;
		case "memory":
			assert.deepEqual(memories.map(({ content, revision }) => ({ content, revision })), [{ content: "The fixture prefers green.", revision: 2 }]);
			assert.ok(results.some((item) => (item.error as { code?: string } | undefined)?.code === "MEMORY_STALE"));
			break;
		case "clarification":
			assert.ok(values.some((item) => item.status === "answered" && item.answer === "Custom answer"));
			assert.ok(values.some((item) => item.status === "skipped"));
			assert.equal(history.filter((message) => message.role === "user").length, 1);
			assert.equal(report.writes.length, 0);
			break;
		case "image":
			assert.ok(values.some((item) => item.kind === "image" && item.sha256 === createHash("sha256").update(png).digest("hex") && item.width === 1));
			assert.doesNotMatch(JSON.stringify(history), /iVBORw0KGgo|data:image/);
			assert.equal(report.modelRequests.parent, 3);
			break;
		case "delegation":
			assert.ok(report.toolExecutions?.some((item) => item.parentCallId !== null && item.tool === "read" && item.status === "ok"));
			assert.ok(JSON.stringify(values).includes("wrong"));
			break;
	}
}

/** Diagnostic injected baseline: no environment credentials, live transport or quality-score claim. */
export async function runToolCase(sample: ToolCase) {
	const root = await realpath(tmpdir());
	const workspace = await mkdtemp(join(root, "fatcat-tool-eval-"));
	const file = sample.id === "repair-unicode" ? "unicode.txt" : "source.txt";
	const steps = plan(sample, file);
	const traces: { name: string; arguments: object; child: boolean }[] = [];
	const responses = new Map<string, unknown>();
	let finalState: unknown = null;
	let report: ExecutionReport | undefined;
	let history: readonly Message[] = [];
	let index = 0, childIndex = 0, questions = 0;
	const started = performance.now();
	let passed = false, failure: string | null = null;
	try {
		await writeFile(join(workspace, file), sample.id === "repair-unicode" ? "\u4e2d\u6587 wrong\r\n" : "wrong\n");
		await writeFile(join(workspace, "image.png"), png);
		const base = await createTools(workspace, "workspace-write", undefined, { permission: "allow" }, undefined, undefined, undefined,
			async () => ++questions === 1 ? "Custom answer" : null);
		const config = loadConfig({ DEEPSEEK_API_KEY: "offline-tool-suite", HARNESS_MAX_ITERATIONS: "16" });
		const agent = createAgent(config, base, async (_input, init) => {
			const body = JSON.parse(String(init?.body)) as WireRequest;
			for (const message of body.messages) if (message.role === "tool" && message.tool_call_id) {
				responses.set(message.tool_call_id, JSON.parse(String(message.content)));
			}
			if (body.messages.some((message) => Array.isArray(message.content))) return response("A small fixture image.");
			const child = !body.tools?.some((tool) => tool.function.name === "delegate_task");
			const lastMessage = body.messages.at(-1)!;
			const last = lastMessage.role === "tool" ? JSON.parse(String(lastMessage.content)) : {};
			const step = child ? childIndex++ === 0 ? { name: "read", args: { path: file } } : undefined : steps[index++];
			if (!step) return response(child ? String(last.result?.content ?? "No content") : "Fixture completed.");
			const args = typeof step.args === "function" ? step.args(last.result ?? {}) : step.args;
			traces.push({ name: step.name, arguments: args, child });
			return Response.json({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null,
				tool_calls: [{ id: `call-${traces.length}`, type: "function", function: { name: step.name, arguments: JSON.stringify(args) } }] } }] });
		});
		const session = await SessionManager.open(agent, { workspace });
		try {
			await session.run(prompt, { signal: AbortSignal.timeout(30000), onEvent: createTurnReporter((event) => {
				if (event.type === "execution_report") report = event.report;
			}) });
		} finally {
			history = session.history;
			finalState = { content: await readFile(join(workspace, file), "utf8"), memories: await session.listMemories() };
		}
		const memories = await session.listMemories();
		assert.ok(report);
		await gradeToolCase(sample, workspace, history, report, memories);
		passed = true;
	} catch (error) { failure = error instanceof Error ? error.message : "Unknown fixture failure"; }
	finally {
		const target = resolve(workspace);
		if (dirname(target) !== root || !basename(target).startsWith("fatcat-tool-eval-")) throw new Error("Unexpected cleanup target");
		await rm(target, { recursive: true, force: true });
	}
	const executions = report?.toolExecutions ?? [];
	const seen = new Set<string>();
	let repeatedCalls = 0;
	for (const call of traces) { const key = JSON.stringify(call); if (seen.has(key)) repeatedCalls++; seen.add(key); }
	return { sampleId: sample.id, split: sample.split, evidence: "injected", passed, failure,
		durationMs: performance.now() - started, calls: executions.length, repeatedCalls,
		statuses: Object.fromEntries(["ok", "error", "cancelled", "threw"].map((status) => [status, executions.filter((item) => item.status === status).length])),
		inputBytes: executions.reduce((total, item) => total + item.inputBytes, 0),
		outputBytes: executions.reduce((total, item) => total + (item.outputBytes ?? 0), 0),
		outputComplete: executions.every((item) => item.outputBytes !== null),
		tokenUsage: report?.tokenUsage ?? null, traces, responses: Object.fromEntries(responses), finalState, history, report: report ?? null };
}
