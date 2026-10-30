import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { createTools } from "@fatcat/runtime/tools";
import { createOutputFiles } from "@fatcat/runtime/internal/tools/shell/output-files";
import { readOutputPage, searchOutputPage } from "@fatcat/runtime/internal/tools/shell/output-pages";
import { temporaryWorkspace } from "../support/workspace.js";

test("large command output keeps executing and its end remains readable beyond 1 MiB", async (t) => {
	const { workspace } = await temporaryWorkspace(t);
	const tools = await createTools(workspace, "workspace-write", undefined, { permission: "allow" });
	const command = process.platform === "win32"
		? "[Console]::Out.Write(('x' * 1500000)); [Console]::Out.WriteLine('AFTER_LIMIT'); [Console]::Error.WriteLine('DONE')"
		: "head -c 1500000 /dev/zero | tr '\\0' x; printf 'AFTER_LIMIT\\n'; printf 'DONE\\n' >&2";
	const run = await tools.execute("shell", JSON.stringify({ command }));
	assert.equal(run.ok, true, JSON.stringify(run));
	if (!run.ok) return;
	const record = run.result as Record<string, unknown>;
	assert.equal(record.success, true);
	assert.equal(record.outputTruncated, true);
	assert.equal(record.truncated, false);
	assert.equal(record.captureStatus, "complete");
	assert.ok(Number(record.storedBytes) > 1500000);
	assert.ok(Buffer.byteLength(JSON.stringify(run)) < 18000);
	const tail = await tools.execute("output_read", JSON.stringify({ outputId: record.outputId, tail: true, limit: 30 }));
	assert.equal(tail.ok, true, JSON.stringify(tail));
	assert.match(JSON.stringify(tail), /AFTER_LIMIT/);
	const search = await tools.execute("output_read", JSON.stringify({ outputId: record.outputId, stream: "stderr", action: "search", query: "DONE" }));
	assert.match(JSON.stringify(search), /"totalMatches":1/);
	assert.ok(JSON.stringify(tools.getCommands!()).length < 3000);
});

test("quota drops further logging, counts received bytes and never rejects subsequent writes", async () => {
	const capture = await createOutputFiles(randomUUID(), 7);
	await capture.append("stdout", Buffer.from("abc😀END"));
	await capture.append("stderr", Buffer.from("STILL RUNNING"));
	const stored = await capture.finish();
	assert.equal(stored.reason, "command_quota");
	assert.equal(stored.storedBytes, 7);
	assert.equal(stored.receivedBytes, 23);
	assert.equal((await readOutputPage(stored.files.stdout, 0, 20, false)).content, "abc😀");
	assert.equal((await readOutputPage(stored.files.stderr, 0, 20, false)).content, "");
});

test("storage creation failure does not reject command output", async () => {
	const id = randomUUID();
	await (await createOutputFiles(id)).finish();
	const failed = await createOutputFiles(id);
	await failed.append("stdout", Buffer.from("command completes"));
	const stored = await failed.finish();
	assert.equal(stored.reason, "storage_error");
	assert.equal(stored.storedBytes, 0);
	assert.equal(stored.receivedBytes, 17);
});

test("streaming search handles split UTF-8, literal matches and CRLF across read boundaries", async () => {
	const text = "x".repeat(65535) + "\r\n😀needle\r\n" + "q".repeat(65520) + "needle\nend";
	const capture = await createOutputFiles(randomUUID());
	const bytes = Buffer.from(text);
	for (let offset = 0; offset < bytes.length; offset += 999) await capture.append("stdout", bytes.subarray(offset, offset + 999));
	const stored = await capture.finish();
	const page = await searchOutputPage(stored.files.stdout, "needle", 0, 1);
	assert.equal(page.totalMatches, 2);
	assert.equal(page.nextOffset, 1);
	assert.deepEqual(page.matches, [{ line: 2, text: "😀needle", characterOffset: 65537, textTruncated: false }]);
	const next = await searchOutputPage(stored.files.stdout, "needle", 1, 1);
	assert.equal(next.matches[0]!.line, 3);
	assert.equal(next.matches[0]!.textTruncated, true);
	assert.equal((await readOutputPage(stored.files.stdout, 65537, 7, false)).content, "😀needle");
	assert.equal((await readOutputPage(stored.files.stdout, 0, 3, true)).content, "end");
	await assert.rejects(readOutputPage(stored.files.stdout, 0, 20, false, AbortSignal.abort()), { code: "CANCELLED" });
	await writeFile(stored.files.stdout!.path, "changed");
	await assert.rejects(readOutputPage(stored.files.stdout, 0, 20, false), { code: "OUTPUT_CHANGED" });
});
