import { Worker } from "node:worker_threads";
import { HarnessError, checkCancellation } from "../errors.js";
import { readTextFile } from "../permissions/text-file.js";
import type { Workspace } from "../permissions/workspace.js";
import { discoverFiles } from "./discovery.js";
import type { SearchTarget, DiscoveryOptions } from "./discovery.js";

type Match = { path: string; line: number; text: string; context?: { line: number; text: string }[] };
type SearchOptions = DiscoveryOptions & { query: string; offset: number; limit: number;
	regex: boolean; ignoreCase: boolean; context: number };

/** Isolate regex evaluation so pathological patterns cannot block cancellation or the host. */
async function regexLines(lines: string[], query: string, ignoreCase: boolean, signal?: AbortSignal): Promise<number[]> {
	checkCancellation(signal);
	const worker = new Worker(new URL("./search-worker.js", import.meta.url), {
		workerData: { lines, query, ignoreCase }, resourceLimits: { maxOldGenerationSizeMb: 64 },
	});
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abort: (() => void) | undefined;
	try {
		return await new Promise<number[]>((resolve, reject) => {
			timer = setTimeout(() => reject(new HarnessError("SEARCH_TIMEOUT", "Regex evaluation exceeded 3 seconds for one file. Simplify query, narrow path, or use literal search.")), 3000);
			abort = () => reject(new HarnessError("CANCELLED", "Search cancelled."));
			signal?.addEventListener("abort", abort, { once: true });
			worker.once("message", resolve);
			worker.once("error", () => reject(new HarnessError("SEARCH_FAILED", "Regex worker failed. Narrow the search or use literal mode.")));
			worker.once("exit", (code) => { if (code !== 0) reject(new HarnessError("SEARCH_FAILED", "Regex worker stopped without results.")); });
			if (signal?.aborted) abort();
		});
	} finally {
		clearTimeout(timer);
		if (abort) signal?.removeEventListener("abort", abort);
		await worker.terminate();
	}
}

export async function searchText(workspace: Workspace, target: SearchTarget, options: SearchOptions, signal?: AbortSignal) {
	const paths = await discoverFiles(workspace, target, options, true, signal);
	const matches: Match[] = [];
	let totalMatches = 0;
	let scannedFiles = 0;
	let skippedFiles = 0;
	let pageBytes = 2;
	let pageFull = false;
	const needle = options.ignoreCase ? options.query.toLowerCase() : options.query;
	for (const path of paths) {
		checkCancellation(signal);
		const current = await workspace.resolvePath(path, signal);
		let content: string;
		try { ({ content } = await readTextFile(current, signal)); }
		catch (error) {
			if (target.stat.isDirectory() && error instanceof HarnessError && ["FILE_TOO_LARGE", "UNSUPPORTED_FILE"].includes(error.code)) {
				skippedFiles++; continue;
			}
			throw error;
		}
		scannedFiles++;
		const lines = content.split(/\r\n|\r|\n/);
		if (lines.at(-1) === "") lines.pop();
		const indices = options.regex ? await regexLines(lines, options.query, options.ignoreCase, signal)
			: lines.flatMap((text, index) => (options.ignoreCase ? text.toLowerCase() : text).includes(needle) ? [index] : []);
		for (const line of indices) {
			checkCancellation(signal);
			const index = totalMatches++;
			if (index < options.offset || pageFull) continue;
			const match: Match = { path, line: line + 1, text: lines[line]! };
			if (options.context) match.context = lines.slice(Math.max(0, line - options.context), line + options.context + 1)
				.map((text, offset) => ({ line: Math.max(0, line - options.context) + offset + 1, text }));
			const size = Buffer.byteLength(JSON.stringify(match)) + (matches.length ? 1 : 0);
			if (pageBytes + size > 16384) {
				if (!matches.length) throw new HarnessError("OUTPUT_LIMIT", "One match with context exceeds 16384 bytes. Reduce context or inspect the file separately.");
				pageFull = true; continue;
			}
			matches.push(match); pageBytes += size;
			if (matches.length === options.limit) pageFull = true;
		}
	}
	checkCancellation(signal);
	const end = Math.min(options.offset, totalMatches) + matches.length;
	return { kind: "search", path: target.relative, query: options.query, regex: options.regex, ignoreCase: options.ignoreCase,
		offset: options.offset, totalMatches, matches, truncated: end < totalMatches, nextOffset: end < totalMatches ? end : null,
		scannedFiles, skippedFiles, complete: skippedFiles === 0 };
}
