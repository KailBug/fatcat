import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { runHeadlessTask, type HeadlessOptions } from "../src/headless.js";
import { completion } from "../tests/fixtures/session.js";

const { values } = parseArgs({ options: { workspace: { type: "string" }, output: { type: "string" } }, strict: true });
if (process.platform !== "linux" || !values.workspace || !values.output) {
	throw new Error("Usage in the Linux task container: verify-linux --workspace /app --output /logs/fatcat");
}
const taskCwd = resolve(values.workspace);
const output = resolve(values.output);
await mkdir(output);
await access(join(taskCwd, "data/train.tsv"));
await access(join(taskCwd, "engine/apply.py"));
const options: HeadlessOptions = { taskCwd, instruction: "Run the injected file and Bash integration check in this task directory.",
	resultDirectory: join(output, "files"), permission: { files: "workspace-write", shell: "allow" }, requests: 9, durationMs: 30000 };
const calls = [
	{ name: "read", args: { path: "data/train.tsv", limit: 2 } },
	{ name: "write", args: { path: "fatcat smoke.txt", content: "first\n" } },
	{ name: "write", args: { path: "fatcat smoke.txt", oldText: "first", newText: "verified" } },
	{ name: "read", args: { path: "fatcat smoke.txt" } },
	{ name: "shell", args: { command: "test \"$PWD\" = /app && test \"$(cat 'fatcat smoke.txt')\" = verified && printf 'same-task-cwd'" } },
	{ name: "shell", args: { command: "printf 'expected-nonzero' >&2; exit 7" } },
];
let count = 0;
const files = await runHeadlessTask(options, () => async (_input, init) => {
	const body = String(init?.body);
	assert.doesNotMatch(body, /ground_truth|hidden_test|\/solution\/|reference answer/i);
	assert.match(body, /Linux Bash/);
	const call = calls[count++];
	return call ? completion(null, [{ id: `call-${count}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }])
		: completion("Injected file and command checks completed.");
});
assert.equal(files.status, "completed");
assert.equal(files.cleanup, "removed");
const fileEvidence = JSON.parse(await readFile(files.evidenceFile, "utf8"));
assert.equal(fileEvidence.commands[0].stdout, "same-task-cwd");
assert.equal(fileEvidence.commands[0].exitCode, 0);
assert.equal(fileEvidence.commands[1].exitCode, 7);
assert.equal(fileEvidence.writes.length, 2);
assert.equal(fileEvidence.requests.length, 7);
assert.equal(await readFile(join(taskCwd, "fatcat smoke.txt"), "utf8"), "verified\n");
await assert.rejects(access(fileEvidence.temporaryRoot), { code: "ENOENT" });

const abort = new AbortController();
const interrupted = runHeadlessTask({ ...options, resultDirectory: join(output, "cancel") }, () => async () => completion(null, [{
	id: "cancel-command", type: "function", function: { name: "shell", arguments: JSON.stringify({
		command: 'echo $$ > fatcat-parent.pid; bash -c \'trap "" TERM; echo $$ > fatcat-child.pid; sleep 60\' & wait', timeoutMs: 20000,
	}) },
}]), abort.signal);
const pids: number[] = [];
try {
	for (const name of ["fatcat-parent.pid", "fatcat-child.pid"]) {
		let pid = 0;
		for (let attempt = 0; attempt < 250 && !pid; attempt++) {
			try { pid = Number(await readFile(join(taskCwd, name), "utf8")); }
			catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
			if (!pid) await delay(20);
		}
		assert.ok(Number.isSafeInteger(pid) && pid > 0, `${name} was not created`);
		pids.push(pid);
	}
} finally {
	abort.abort();
}
const cancelled = await interrupted;
assert.equal(cancelled.status, "cancelled");
assert.equal(cancelled.cleanup, "removed");
const cancellationEvidence = JSON.parse(await readFile(cancelled.evidenceFile, "utf8"));
assert.equal(cancellationEvidence.session.attempt.status, "cancelled");
assert.equal(cancellationEvidence.commands[0].status, "cancelled");
assert.equal(cancellationEvidence.commands[0].cleanup, "tree-killed");
await assert.rejects(access(cancellationEvidence.temporaryRoot), { code: "ENOENT" });
for (const pid of pids) {
	let stopped = false;
	for (let attempt = 0; attempt < 150 && !stopped; attempt++) {
		try {
			const stat = await readFile(`/proc/${pid}/stat`, "utf8");
			stopped = stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			stopped = true;
		}
		if (!stopped) await delay(20);
	}
	assert.ok(stopped, `Process ${pid} is still executing`);
}
const summary = { evidence: "injected", workspace: taskCwd, platform: process.platform, node: process.version,
	files: files.status, cancellation: cancelled.status, parentAndChildStopped: true,
	temporaryStateRemoved: true, officialScore: null, modelRequestsSentToNetwork: 0 };
const configPath = join(output, "signal-config.json");
await writeFile(configPath, JSON.stringify({ ...options, resultDirectory: join(output, "signal") }), { flag: "wx" });
const entry = spawn(process.execPath, [fileURLToPath(new URL("headless.js", import.meta.url)), "--config", configPath,
	"--transport", fileURLToPath(new URL("../tests/fixtures/headless-signal.js", import.meta.url))], { stdio: ["ignore", "pipe", "pipe"] });
const entryExit = once(entry, "close");
const consoleOutput: Buffer[] = [];
entry.stdout.on("data", (bytes: Buffer) => consoleOutput.push(bytes));
entry.stderr.on("data", (bytes: Buffer) => consoleOutput.push(bytes));
const entryDeadline = setTimeout(() => entry.kill("SIGKILL"), 15000);
try {
	let ready = false;
	for (let attempt = 0; attempt < 250 && !ready; attempt++) {
		try { ready = Number(await readFile(join(taskCwd, "fatcat-signal-child.pid"), "utf8")) > 0; }
		catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
		if (!ready) await delay(20);
	}
	assert.ok(ready, "The executable did not start its shell child");
	entry.kill("SIGTERM");
	const [code] = await entryExit;
	assert.equal(code, 130, Buffer.concat(consoleOutput).toString());
	const signalEvidence = JSON.parse(await readFile(join(output, "signal/evidence.json"), "utf8"));
	assert.equal(signalEvidence.status, "cancelled");
	assert.equal(signalEvidence.session.attempt.status, "cancelled");
	assert.equal(signalEvidence.commands[0].cleanup, "tree-killed");
	await assert.rejects(access(signalEvidence.temporaryRoot), { code: "ENOENT" });
} finally {
	clearTimeout(entryDeadline);
	if (entry.exitCode === null && entry.signalCode === null) entry.kill("SIGKILL");
	await entryExit;
}
await writeFile(join(output, "signal-console.txt"), Buffer.concat(consoleOutput), { flag: "wx" });
await writeFile(join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n", { flag: "wx" });
process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
