import type { Readable } from "node:stream";
import type { OutputSink } from "./types.js";

/** Pause each pipe while its chunk is written; preview memory never grows with output size. */
export function createProcessCapture(sink?: OutputSink) {
	const parts = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
	const sizes = { stdout: 0, stderr: 0 };
	const pending = new Set<Promise<void>>();
	let shortened = false;
	let failed = false;
	function collect(stream: "stdout" | "stderr", pipe: Readable, chunk: Buffer) {
		const keep = Math.min(chunk.length, 16384 - sizes[stream]);
		if (keep) { parts[stream].push(Buffer.from(chunk.subarray(0, keep))); sizes[stream] += keep; }
		shortened ||= keep < chunk.length;
		if (!sink) return;
		pipe.pause();
		const writing = Promise.resolve().then(() => sink(stream, chunk)).catch(() => { failed = true; })
			.finally(() => { pending.delete(writing); if (!pipe.destroyed) pipe.resume(); });
		pending.add(writing);
	}
	async function finish() {
		await Promise.all(pending);
		const decode = (stream: "stdout" | "stderr") => new TextDecoder().decode(Buffer.concat(parts[stream]), { stream: shortened });
		return { stdout: decode("stdout"), stderr: decode("stderr"), outputTruncated: shortened,
			truncated: failed || (!sink && shortened) };
	}
	return { collect, finish };
}
