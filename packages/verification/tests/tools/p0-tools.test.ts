import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createTools } from "@fatcat/runtime/tools";
import type { Tools, ToolResult } from "@fatcat/runtime/tools";
import { createShellTool } from "@fatcat/runtime/tools/shell";
import { createWorkspace } from "@fatcat/runtime/permissions/workspace";
import { PermissionPolicy } from "@fatcat/runtime/permissions/policy";
import { temporaryWorkspace } from "../support/workspace.js";

async function result(tools: Tools, name: string, args: object) {
	const value = await tools.execute(name, JSON.stringify(args));
	assert.equal(value.ok, true, JSON.stringify(value));
	return (value as { ok: true; result: Record<string, unknown> }).result;
}
function code(value: ToolResult, expected: string) {
	assert.equal(value.ok, false, JSON.stringify(value));
	if (!value.ok) assert.equal(value.error.code, expected);
}

test("glob filters paths, pages stably, observes permissions, and does not read binary contents", async (t) => {
	const { workspace, outside } = await temporaryWorkspace(t);
	await mkdir(join(workspace, "src", "nested"), { recursive: true });
	await mkdir(join(workspace, "node_modules"));
	await writeFile(join(workspace, "src", "a.ts"), "a");
	await writeFile(join(workspace, "src", "nested", "b.ts"), "b");
	await writeFile(join(workspace, "src", "nested", "image.png"), Buffer.from([0, 255]));
	await writeFile(join(workspace, "node_modules", "hidden.ts"), "private");
	await writeFile(join(outside, "private.ts"), "outside");
	const tools = await createTools(workspace);
	const first = await result(tools, "glob", { pattern: "src/**/*.ts", limit: 1 });
	assert.deepEqual(first.paths, ["src/a.ts"]);
	assert.equal(first.nextOffset, 1);
	const second = await result(tools, "glob", { pattern: "src/**/*.ts", limit: 1, offset: 1 });
	assert.deepEqual(second.paths, ["src/nested/b.ts"]);
	assert.equal(second.nextOffset, null);
	assert.deepEqual((await result(tools, "glob", { pattern: "*.png" })).paths, ["src/nested/image.png"]);
	assert.deepEqual((await result(tools, "glob", { pattern: "*.ts", exclude: ["**/nested/**"] })).paths, ["src/a.ts"]);
	assert.deepEqual((await result(tools, "glob", { pattern: "missing*" })).paths, []);
	code(await tools.execute("glob", JSON.stringify({ pattern: "*.ts", path: outside })), "PATH_NOT_ALLOWED");
	code(await tools.execute("glob", JSON.stringify({ pattern: "../*.ts" })), "INVALID_ARGUMENTS");
	code(await tools.execute("read", JSON.stringify({ path: ".", query: "a" })), "INVALID_ARGUMENTS");
});

test("grep separates literal and regex search, case folding, filters and context", async (t) => {
	const { workspace } = await temporaryWorkspace(t);
	await writeFile(join(workspace, "code.ts"), "start\r\nNeedle 42\r\nneedle.*\r\nend\r\n");
	await writeFile(join(workspace, "other.txt"), "needle hidden by filter");
	const tools = await createTools(workspace);
	const literal = await result(tools, "grep", { query: "needle.*" });
	assert.equal(literal.totalMatches, 1);
	const regex = await result(tools, "grep", { query: "^needle \\d+$", regex: true, ignoreCase: true, glob: "*.ts", context: 1 });
	assert.deepEqual(regex.matches, [{ path: "code.ts", line: 2, text: "Needle 42", context: [
		{ line: 1, text: "start" }, { line: 2, text: "Needle 42" }, { line: 3, text: "needle.*" },
	] }]);
	code(await tools.execute("grep", JSON.stringify({ query: "[", regex: true })), "INVALID_ARGUMENTS");
	code(await tools.execute("grep", JSON.stringify({ query: "needle", context: 6 })), "INVALID_ARGUMENTS");
});

test("pathological regex times out and cancellation remains responsive", async (t) => {
	const { workspace } = await temporaryWorkspace(t);
	await writeFile(join(workspace, "pathological.txt"), "a".repeat(50000) + "!");
	const tools = await createTools(workspace);
	const args = JSON.stringify({ path: "pathological.txt", query: "^(a+)+$", regex: true });
	code(await tools.execute("grep", args), "SEARCH_TIMEOUT");
	const controller = new AbortController();
	const pending = tools.execute("grep", args, controller.signal);
	const timer = setTimeout(() => controller.abort(), 100);
	try { await assert.rejects(pending, { code: "CANCELLED" }); }
	finally { clearTimeout(timer); }
	assert.equal((await result(tools, "grep", { path: "pathological.txt", query: "absent" })).totalMatches, 0);
});

test("edit publishes disjoint original-file replacements once and rejects overlap or partial application", async (t) => {
	const { workspace } = await temporaryWorkspace(t);
	const original = "\ufeffalpha=1;\r\nbeta=2;\nuntouched\r\n";
	await writeFile(join(workspace, "code.ts"), original);
	let approvals = 0;
	const tools = await createTools(workspace, "ask", async (request) => {
		approvals++;
		assert.equal(request.oldText, original.slice(1));
		assert.equal(request.newText, "alpha=2;\r\nbeta=3;\nuntouched\r\n");
		return true;
	});
	for (const edits of [
		[{ oldText: "alpha", newText: "A" }, { oldText: "alpha=1", newText: "B" }],
		[{ oldText: "alpha=1", newText: "alpha=2" }, { oldText: "alpha=2", newText: "alpha=3" }],
	]) code(await tools.execute("edit", JSON.stringify({ path: "code.ts", edits })), "WRITE_CONFLICT");
	assert.equal(approvals, 0);
	assert.equal(await readFile(join(workspace, "code.ts"), "utf8"), original);
	await result(tools, "edit", { path: "code.ts", edits: [
		{ oldText: "beta=2", newText: "beta=3" }, { oldText: "alpha=1", newText: "alpha=2" },
	] });
	assert.equal(approvals, 1);
	assert.equal(tools.getWrites!().length, 1);
	assert.equal(tools.getWrites!()[0]!.status, "committed");
	assert.equal(await readFile(join(workspace, "code.ts"), "utf8"), original.replace("alpha=1", "alpha=2").replace("beta=2", "beta=3"));
	for (const edits of [[], Array(33).fill({ oldText: "a", newText: "b" }), [{ oldText: "a", newText: "a" }]]) {
		code(await tools.execute("edit", JSON.stringify({ path: "code.ts", edits })), "INVALID_ARGUMENTS");
	}
});

test("shell preview does not kill verbose commands and output_read can recover their complete output", { skip: process.platform !== "win32" }, async (t) => {
	const { workspace } = await temporaryWorkspace(t);
	const tools = await createTools(workspace, "workspace-write", undefined, { permission: "allow" });
	const command = "[Console]::Out.Write(('x' * 40000)); [Console]::Out.WriteLine('END'); [Console]::Error.WriteLine('DIAGNOSTIC'); [IO.File]::WriteAllText((Join-Path (Get-Location) 'finished.txt'), 'done')";
	const run = await result(tools, "shell", { command, timeoutMs: 10000 });
	assert.equal(run.success, true);
	assert.equal(run.status, "completed");
	assert.equal(run.truncated, false);
	assert.equal(run.outputTruncated, true);
	assert.ok(Buffer.byteLength(JSON.stringify(run)) < 17000);
	assert.equal(await readFile(join(workspace, "finished.txt"), "utf8"), "done");
	let offset: number | null = 0;
	let text = "";
	do {
		const page = await result(tools, "output_read", { outputId: run.outputId, offset });
		text += page.content;
		offset = page.nextOffset as number | null;
	} while (offset !== null);
	assert.equal(text, "x".repeat(40000) + "END\r\n");
	assert.match(String((await result(tools, "output_read", { outputId: run.outputId, tail: true, limit: 10 })).content), /END/);
	const search = await result(tools, "output_read", { outputId: run.outputId, stream: "stderr", action: "search", query: "DIAGNOSTIC" });
	assert.equal(search.totalMatches, 1);
	const other = await createTools(workspace);
	code(await other.execute("output_read", JSON.stringify({ outputId: run.outputId })), "OUTPUT_NOT_FOUND");
});

test("output logs retain capture failures, Unicode, tail bounds and launch scope without rerunning commands", async (t) => {
	const { workspace } = await temporaryWorkspace(t);
	const policy = new PermissionPolicy("freeToGo");
	const scope = await createWorkspace(workspace, policy);
	let launches = 0;
	const shell = createShellTool(scope, { permission: "allow" }, async () => {
		launches++;
		return { status: "output_limit", exitCode: null, stdout: "😀\n".repeat(5000) + "END", stderr: "",
			truncated: true, durationMs: 1, cleanup: "tree-killed" };
	}, policy);
	const run = await shell.tool.execute({ command: "pwd" });
	assert.equal(run.ok, true);
	const outputId = (run as { ok: true; result: Record<string, unknown> }).result.outputId;
	const tail = await shell.outputTool.execute({ outputId, tail: true, limit: 12000 });
	assert.equal(tail.ok, true);
	const page = (tail as { ok: true; result: Record<string, unknown> }).result;
	assert.equal(page.captureTruncated, true);
	assert.equal(page.nextOffset, null);
	assert.ok(String(page.content).endsWith("END"));
	assert.ok(!String(page.content).includes("\ufffd"));
	assert.ok(Buffer.byteLength(JSON.stringify(page)) < 13000);
	policy.select("plan");
	await assert.rejects(async () => shell.outputTool.execute({ outputId }), { code: "PERMISSION_DENIED" });
	assert.equal(launches, 1);
});
