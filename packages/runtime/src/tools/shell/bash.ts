import { spawn } from "node:child_process";
import type { ProcessResult, OutputSink } from "./types.js";
import { createProcessCapture } from "./capture.js";

/** Keep host credentials and shell/loader hooks out of task commands. */
export function bashEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const allowed = new Set(["PATH", "HOME", "USER", "LOGNAME", "TMPDIR", "TMP", "TEMP", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "PNPM_HOME"]);
	return Object.fromEntries(Object.entries(env).filter(([key, value]) => allowed.has(key) && value !== undefined));
}

/** A fresh Linux process group, not an OS sandbox or a persistent terminal. */
export async function runBash(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal, sink?: OutputSink): Promise<ProcessResult> {
	const started = Date.now();
	if (signal?.aborted) return { status: "cancelled", cleanup: "not-started", exitCode: null,
		stdout: "", stderr: "", truncated: false, durationMs: 0 };
	return new Promise<ProcessResult>((resolve) => {
		const child = spawn("/bin/bash", ["--noprofile", "--norc", "-c", command], {
			cwd, env: bashEnvironment(), detached: true, stdio: ["ignore", "pipe", "pipe"],
		});
		const capture = createProcessCapture(sink);
		let settled = false;
		let exited = false;
		let exitCode: number | null = null;
		let reason: ProcessResult["status"] | undefined;
		let killed = false;
		let fallback: ReturnType<typeof setTimeout> | undefined;
		const deadline = setTimeout(() => stop("timed_out"), timeoutMs);
		const abort = () => stop("cancelled");

		async function finish(status: ProcessResult["status"], cleanup: ProcessResult["cleanup"]): Promise<void> {
			if (settled) return;
			settled = true;
			clearTimeout(deadline);
			clearTimeout(fallback);
			signal?.removeEventListener("abort", abort);
			child.stdout.destroy();
			child.stderr.destroy();
			child.unref();
      resolve({ status, cleanup, exitCode, ...await capture.finish(), durationMs: Date.now() - started });
		}
		function stop(status: ProcessResult["status"]): void {
			if (settled || reason) return;
			reason = status;
			if (!child.pid) return;
			// Do not signal a numeric group after its leader has exited and may have been reused.
			if (exited) { finish("termination_failed", "unconfirmed"); return; }
			try {
				// Kill the owned group immediately, including children that ignore TERM. No delayed PID signalling.
				process.kill(-child.pid, "SIGKILL");
				killed = true;
			} catch {
				finish("termination_failed", "unconfirmed");
				return;
			}
			fallback = setTimeout(() => finish("termination_failed", "unconfirmed"), 5000);
		}
		child.stdout.on("data", (chunk: Buffer) => capture.collect("stdout", child.stdout, chunk));
		child.stderr.on("data", (chunk: Buffer) => capture.collect("stderr", child.stderr, chunk));
		child.once("error", () => finish("spawn_failed", "not-started"));
		child.once("exit", (code) => { exited = true; exitCode = code; });
		child.once("close", (code) => {
			exitCode = code;
			finish(reason ?? "completed", killed ? "tree-killed" : "foreground-exited");
		});
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
	});
}
