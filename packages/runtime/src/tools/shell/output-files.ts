import { mkdir, mkdtemp, open, readdir, lstat, rm, readFile, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OutputSink } from "./types.js";
import { checkCancellation, HarnessError } from "../../errors.js";

export const commandLogLimit = 64 * 1024 * 1024;
const processLogLimit = 256 * 1024 * 1024;
let reservedBytes = 0;
let directory: Promise<string> | undefined;

async function logDirectory(): Promise<string> {
	if (!directory) directory = (async () => {
		const parent = tmpdir();
		// Only expired directories of dead Fatcat processes are eligible; never follow links.
		for (const entry of await readdir(parent, { withFileTypes: true })) {
			const match = /^fatcat-shell-logs-([1-9][0-9]*)-[A-Za-z0-9]+$/.exec(entry.name);
			if (!match || !entry.isDirectory() || entry.isSymbolicLink()) continue;
			const path = join(parent, entry.name);
			try {
				if (Date.now() - (await lstat(path)).mtimeMs < 86400000) continue;
				const marker = join(path, "owner.json");
				const stat = await lstat(marker);
				if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256) continue;
				const owner = JSON.parse(await readFile(marker, "utf8"));
				if (owner.kind !== "fatcat-shell-output" || owner.pid !== Number(match[1])) continue;
				try { process.kill(Number(match[1]), 0); continue; }
				catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue; }
				await rm(path, { recursive: true, force: true });
			} catch { /* Stale cleanup is best effort, never a reason to prevent command execution. */ }
		}
		const path = await mkdtemp(join(parent, `fatcat-shell-logs-${process.pid}-`));
		await writeFile(join(path, "owner.json"), JSON.stringify({ kind: "fatcat-shell-output", pid: process.pid }), { flag: "wx", mode: 0o600 });
		process.once("exit", () => { try { rmSync(path, { recursive: true, force: true }); } catch { /* Next startup may clean it. */ } });
		return path;
	})();
	return directory;
}

export interface OutputFile {
	path: string;
	dev: number;
	ino: number;
	size: number;
	mtimeMs: number;
	ctimeMs: number;
}

/** Files are private runtime artifacts. Quota/I/O failure drops capture, never kills the command. */
export async function createOutputFiles(id: string, limit = commandLogLimit) {
	const files: Partial<Record<"stdout" | "stderr", OutputFile>> = {};
	const handles: Partial<Record<"stdout" | "stderr", FileHandle>> = {};
	let reason: "command_quota" | "process_quota" | "storage_error" | undefined;
	let storedBytes = 0;
	let receivedBytes = 0;
	let writes = 0;
	let queue = Promise.resolve();
	try {
		const root = await logDirectory();
		const path = join(root, id);
		await mkdir(path, { mode: 0o700 });
		for (const stream of ["stdout", "stderr"] as const) {
			const filePath = join(path, `${stream}.log`);
			const handle = await open(filePath, "wx", 0o600);
			handles[stream] = handle;
			const stat = await handle.stat();
			files[stream] = { path: filePath, dev: stat.dev, ino: stat.ino, size: 0, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
		}
	} catch { reason = "storage_error"; }
	const append: OutputSink = (stream, chunk) => {
		writes++;
		receivedBytes += chunk.length;
		queue = queue.then(async () => {
			if (reason) return;
			const available = Math.max(0, Math.min(limit - storedBytes, processLogLimit - reservedBytes));
			const kept = chunk.subarray(0, available);
			reservedBytes += kept.length;
			if (kept.length < chunk.length) reason = storedBytes + kept.length >= limit ? "command_quota" : "process_quota";
			try {
				let offset = 0;
				while (offset < kept.length) {
					const { bytesWritten } = await handles[stream]!.write(kept, offset, kept.length - offset, null);
					if (!bytesWritten) throw new Error("No write progress");
					offset += bytesWritten;
					storedBytes += bytesWritten;
					files[stream]!.size += bytesWritten;
				}
			} catch { reason = "storage_error"; }
		});
		return queue;
	};
	async function finish() {
		await queue;
		for (const stream of ["stdout", "stderr"] as const) {
			const handle = handles[stream];
			if (!handle) continue;
			try {
				const stat = await handle.stat();
				Object.assign(files[stream]!, { mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs });
			} catch { reason = "storage_error"; }
			finally { try { await handle.close(); } catch { reason = "storage_error"; } }
		}
		return { files, storedBytes, receivedBytes, reason };
	}
	return { append, finish, get writes() { return writes; } };
}

/** Read bounded chunks from the exact completed file, refusing links/replacements/size changes. */
export async function* outputChunks(file: OutputFile | undefined, signal?: AbortSignal) {
	if (!file) throw new HarnessError("OUTPUT_UNAVAILABLE", "The output stream could not be stored.");
	const pathStat = await lstat(file.path);
	if (!pathStat.isFile() || pathStat.isSymbolicLink()) throw new HarnessError("OUTPUT_CHANGED", "The output file changed.");
	const handle = await open(file.path, "r");
	try {
		const before = await handle.stat();
		if (before.dev !== file.dev || before.ino !== file.ino || before.size !== file.size || before.nlink !== 1
			|| before.mtimeMs !== file.mtimeMs || before.ctimeMs !== file.ctimeMs) {
			throw new HarnessError("OUTPUT_CHANGED", "The captured output was replaced or changed.");
		}
		const decoder = new TextDecoder();
		const buffer = Buffer.alloc(65536);
		let offset = 0;
		while (offset < file.size) {
			checkCancellation(signal);
			const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, file.size - offset), offset);
			if (!bytesRead) throw new HarnessError("OUTPUT_CHANGED", "The captured output changed during reading.");
			offset += bytesRead;
			yield decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
		}
		// A quota can cut a UTF-8 scalar; omit that incomplete suffix.
		const after = await handle.stat();
		if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
			throw new HarnessError("OUTPUT_CHANGED", "The captured output changed during reading.");
		}
	} finally { await handle.close(); }
}
