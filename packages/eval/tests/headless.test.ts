import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { parseHeadlessOptions, runHeadlessTask, type HeadlessOptions } from "../src/headless.js";
import { completion } from "./fixtures/session.js";

async function fixture(t: TestContext): Promise<HeadlessOptions> {
	const root = await mkdtemp(join(tmpdir(), "fatcat-headless-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const taskCwd = join(root, "task with spaces");
	await mkdir(taskCwd);
	await writeFile(join(taskCwd, "input.txt"), "original");
	return { taskCwd, resultDirectory: join(root, "result"), instruction: "Read input.txt, create and edit output.txt, then verify it.",
		permission: { files: "workspace-write", shell: "allow" }, requests: 8, durationMs: 10000 };
}

function sequence(calls: { name: string; args: unknown }[]): () => typeof fetch {
	return () => {
		let index = 0;
		return async (_input, init) => {
			if (index > 0) assert.doesNotMatch(String(init?.body), /"ok":false/);
			const call = calls[index++];
			return call ? completion(null, [{ id: `call-${index}`, type: "function",
				function: { name: call.name, arguments: JSON.stringify(call.args) } }]) : completion("Verified");
		};
	};
}

describe("headless injected Session", () => {
	it("uses the actual task cwd for file and shell tools, and publishes evidence before owned cleanup", async (t) => {
		const options = await fixture(t);
		const result = await runHeadlessTask(options, sequence([
			{ name: "read", args: { path: "input.txt" } },
			{ name: "write", args: { path: "output.txt", content: "first" } },
			{ name: "edit", args: { path: "output.txt", edits: [{ oldText: "first", newText: "edited" }] } },
			{ name: "read", args: { path: "output.txt" } },
			{ name: "shell", args: { command: process.platform === "win32" ? "Get-Content output.txt; exit 7" : "cat output.txt; exit 7" } },
		]));
		assert.equal(result.status, "completed");
		assert.equal(result.cleanup, "removed");
		assert.equal(await readFile(join(options.taskCwd, "input.txt"), "utf8"), "original");
		assert.equal(await readFile(join(options.taskCwd, "output.txt"), "utf8"), "edited");
		const evidence = JSON.parse(await readFile(result.evidenceFile, "utf8"));
		assert.equal(evidence.requests.length, 6);
		assert.equal(evidence.commands[0].exitCode, 7);
		assert.equal(evidence.commands[0].stdout.trim(), "edited");
		assert.equal(evidence.writes.length, 2);
		assert.ok(evidence.session.history.some((message: { role: string }) => message.role === "tool"));
		assert.doesNotMatch(JSON.stringify(evidence.requests), /fatcat-headless-injected|api_key|Authorization/);
		await assert.rejects(access(evidence.temporaryRoot), { code: "ENOENT" });
		await assert.rejects(runHeadlessTask(options, sequence([])), { code: "EEXIST" });
	});

	it("retains cancelled and timed-out Session evidence after transport settlement", async (t) => {
		for (const timeout of [false, true]) {
			const options = await fixture(t);
			if (timeout) options.durationMs = 1000;
			const abort = new AbortController();
			let settled = false;
			const result = await runHeadlessTask(options, () => async (_input, init) => {
				if (!timeout) abort.abort();
				await new Promise<void>((resolve) => {
					if (init?.signal?.aborted) resolve();
					else init?.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				settled = true;
				throw new DOMException("Aborted", "AbortError");
			}, abort.signal);
			assert.equal(settled, true);
			assert.equal(result.status, timeout ? "timeout" : "cancelled");
			const evidence = JSON.parse(await readFile(result.evidenceFile, "utf8"));
			assert.equal(evidence.session.attempt.status, "cancelled");
			assert.equal(result.cleanup, "removed");
			await assert.rejects(access(evidence.temporaryRoot), { code: "ENOENT" });
		}
	});

	it("enforces explicit policy, request limits and already-aborted runs without network fallback", async (t) => {
		const options = await fixture(t);
		options.permission = { files: "read-only", shell: "deny" };
		let calls = 0;
		const denied = await runHeadlessTask(options, () => async (_input, init) => {
			if (++calls === 1) return completion(null, [{ id: "denied", type: "function", function: { name: "shell", arguments: '{"command":"exit 0"}' } }]);
			assert.match(String(init?.body), /PERMISSION_DENIED/);
			return completion("Denied");
		});
		assert.equal(denied.status, "completed");
		assert.deepEqual(JSON.parse(await readFile(denied.evidenceFile, "utf8")).commands, []);
		const bounded = await fixture(t);
		bounded.requests = 1;
		const limited = await runHeadlessTask(bounded, sequence([{ name: "read", args: { path: "input.txt" } }]));
		assert.equal(limited.status, "failed");
		assert.equal(JSON.parse(await readFile(limited.evidenceFile, "utf8")).requests.length, 1);
		const aborted = await runHeadlessTask(await fixture(t), () => assert.fail("Already-aborted run created a transport"), AbortSignal.abort());
		assert.equal(aborted.status, "cancelled");
		assert.equal(aborted.cleanup, "not-created");
	});

	it("rejects ambiguous approval, unbounded limits and task-local result storage", async (t) => {
		const options = await fixture(t);
		for (const patch of [{ taskCwd: "relative" }, { permission: { files: "ask", shell: "allow" } },
			{ permission: { files: "read-only", shell: "allow" } }, { requests: 0 }, { requests: 33 }, { durationMs: 120001 }]) {
			assert.throws(() => parseHeadlessOptions({ ...options, ...patch }));
		}
		await assert.rejects(runHeadlessTask({ ...options, resultDirectory: join(options.taskCwd, "result") }, sequence([])), /outside/);
	});

	it("shares explicit shell permission and execution records with delegated Session work", async (t) => {
		for (const allowed of [true, false]) {
			const options = await fixture(t);
			options.permission.shell = allowed ? "allow" : "deny";
			let requests = 0;
			const result = await runHeadlessTask(options, () => async (_input, init) => {
				requests++;
				const call = requests === 1 ? { name: "delegate_task", args: { task: "Read input.txt with shell." } }
					: requests === 2 ? { name: "shell", args: { command: process.platform === "win32" ? "Get-Content input.txt" : "cat input.txt" } } : null;
				if (requests === 3) assert.match(String(init?.body), allowed ? /original/ : /PERMISSION_DENIED/);
				return call ? completion(null, [{ id: `delegation-${requests}`, type: "function",
					function: { name: call.name, arguments: JSON.stringify(call.args) } }]) : completion("Delegation checked.");
			});
			assert.equal(result.status, "completed");
			assert.equal(requests, 4);
			const evidence = JSON.parse(await readFile(result.evidenceFile, "utf8"));
			assert.equal(evidence.commands.length, allowed ? 1 : 0);
			if (allowed) assert.equal(evidence.commands[0].stdout.trim(), "original");
		}
	});
});
