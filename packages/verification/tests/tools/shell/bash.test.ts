import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { bashEnvironment, runBash } from "@fatcat/runtime/internal/tools/shell/bash";
import { outputLimit } from "@fatcat/runtime/internal/tools/shell/types";
import { PermissionPolicy } from "@fatcat/runtime/permissions/policy";
import { createTools } from "@fatcat/runtime/tools";
import { temporaryWorkspace } from "../../support/workspace.js";

const linux = { skip: process.platform !== "linux" };

async function readPid(path: string): Promise<number> {
	for (let count = 0; count < 250; count++) {
		try {
			const value = Number(await readFile(path, "utf8"));
			if (Number.isSafeInteger(value) && value > 0) return value;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		await delay(20);
	}
	throw new Error("The process did not publish its PID.");
}

async function stopped(pid: number): Promise<void> {
	for (let count = 0; count < 150; count++) {
		try {
			const stat = await readFile(`/proc/${pid}/stat`, "utf8");
			// A zombie is terminated but may await reaping by the container's init.
			if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z ")) return;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		await delay(20);
	}
	assert.fail(`Process ${pid} remains running after group termination.`);
}

test("Bash environment excludes credentials, startup scripts and loader hooks", () => {
	assert.deepEqual(bashEnvironment({ PATH: "/usr/bin", HOME: "/root", LANG: "C.UTF-8", BASH_ENV: "hook",
		ENV: "hook", SHELLOPTS: "xtrace", LD_PRELOAD: "hook", NODE_OPTIONS: "hook", PYTHONPATH: "hook",
		DEEPSEEK_API_KEY: "fake", CUSTOM_SECRET: "fake", Path: "wrong-case" }),
	{ PATH: "/usr/bin", HOME: "/root", LANG: "C.UTF-8" });
});

test("native Bash preserves cwd, Unicode, stderr, exit codes and fresh process state", linux, async (t) => {
	const { workspace } = await temporaryWorkspace(t);
	const nested = join(workspace, "space directory");
	await mkdir(nested);
	const result = await runBash("printf 'hello \u4e2d\u6587\\n'; printf 'diagnostic' >&2; pwd; exit 7", nested, 5000);
	assert.equal(result.status, "completed");
	assert.equal(result.exitCode, 7);
	assert.equal(result.cleanup, "foreground-exited");
	assert.match(result.stdout, /hello \u4e2d\u6587/);
	assert.ok(result.stdout.includes(nested));
	assert.equal(result.stderr, "diagnostic");
	await runBash("export FATCAT_EPHEMERAL=present; cd /", nested, 5000);
	const fresh = await runBash('test -z "$FATCAT_EPHEMERAL" && pwd', nested, 5000);
	assert.equal(fresh.exitCode, 0);
	assert.equal(fresh.stdout.trim(), nested);
	const missing = await runBash("exit 0", join(workspace, "missing"), 5000);
	assert.equal(missing.status, "spawn_failed");
	assert.equal(missing.cleanup, "not-started");
});

test("Bash caps both streams and refuses already-aborted launches", linux, async (t) => {
	const { workspace } = await temporaryWorkspace(t);
	const result = await runBash("while :; do printf '0123456789'; printf 'abcdefghij' >&2; done", workspace, 5000);
	assert.equal(result.status, "output_limit");
	assert.equal(result.cleanup, "tree-killed");
	assert.equal(result.truncated, true);
	assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= outputLimit);
	const aborted = await runBash("touch never.txt", workspace, 5000, AbortSignal.abort());
	assert.equal(aborted.status, "cancelled");
	assert.equal(aborted.cleanup, "not-started");
	await assert.rejects(readFile(join(workspace, "never.txt")), { code: "ENOENT" });
});

test("Bash timeout and cancellation stop parent and TERM-ignoring descendants", linux, async (t) => {
	const { workspace } = await temporaryWorkspace(t);
	const script = 'echo $$ > parent.pid; bash -c \'trap "" TERM; echo $$ > child.pid; sleep 60\' & wait';
	for (const mode of ["timeout", "cancel"] as const) {
		const cwd = join(workspace, mode);
		await mkdir(cwd);
		const abort = new AbortController();
		const pending = runBash(script, cwd, mode === "timeout" ? 1000 : 10000, abort.signal);
		let parent = 0;
		let child = 0;
		try {
			parent = await readPid(join(cwd, "parent.pid"));
			child = await readPid(join(cwd, "child.pid"));
		} finally {
			if (mode === "cancel" || !parent || !child) abort.abort();
		}
		const result = await pending;
		assert.equal(result.status, mode === "timeout" ? "timed_out" : "cancelled", JSON.stringify(result));
		assert.equal(result.cleanup, "tree-killed");
		await stopped(parent);
		await stopped(child);
	}
});

test("Linux tools retain case-sensitive paths, symlink restrictions and explicit shell policy", linux, async (t) => {
	const { workspace } = await temporaryWorkspace(t);
	await writeFile(join(workspace, "Case.txt"), "upper");
	await writeFile(join(workspace, "case.txt"), "lower");
	await symlink("/etc", join(workspace, "escape"));
	const tools = await createTools(workspace, "workspace-write", undefined, { permission: "allow" });
	assert.match(JSON.stringify(await tools.execute("read", '{"path":"Case.txt"}')), /upper/);
	assert.match(JSON.stringify(await tools.execute("read", '{"path":"case.txt"}')), /lower/);
	assert.equal((await tools.execute("read", '{"path":"escape/passwd"}')).ok, false);
	assert.equal((await tools.execute("read", '{"path":"../outside.txt"}')).ok, false);
	const result = await tools.execute("shell", '{"command":"cat Case.txt; exit 9"}');
	assert.equal(result.ok, true);
	if (result.ok) assert.equal((result.result as { success: boolean }).success, false);
	assert.equal(tools.getCommands!()[0]!.exitCode, 9);
	const denied = await createTools(workspace);
	assert.equal((await denied.execute("shell", '{"command":"touch forbidden.txt"}')).ok, false);
	const free = await createTools(workspace, "workspace-write", undefined, {}, undefined, new PermissionPolicy("freeToGo"));
	assert.equal((await free.execute("shell", '{"command":"pwd"}')).ok, false);
	assert.deepEqual(free.getCommands!(), []);
	await assert.rejects(readFile(join(workspace, "forbidden.txt")), { code: "ENOENT" });
});
