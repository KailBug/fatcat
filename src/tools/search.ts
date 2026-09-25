import { opendir } from "node:fs/promises";
import { extname } from "node:path";
import { HarnessError, checkCancellation } from "../errors.js";
import { readTextFile, textExtensions } from "./text-file.js";
import type { Workspace } from "./workspace.js";

type Target = Awaited<ReturnType<Workspace["resolvePath"]>>;
type Match = { path: string; line: number; text: string };
const maxEntries = 1000;
const maxFiles = 128;
const maxDepth = 12;
const maxPageBytes = 16 * 1024;

/** Search a bounded, freshly validated subtree; never return partial traversal as complete. */
export async function searchText(workspace: Workspace, target: Target,
  options: { query: string; offset: number; limit: number }, signal?: AbortSignal) {
  const paths: string[] = [];
  let entries = 0;
  const recursive = target.stat.isDirectory();

  function limitExceeded(): never {
    throw new HarnessError("SEARCH_LIMIT", "Search supports at most 1000 raw entries, 128 candidate files, and 12 directory levels. Choose a narrower path.");
  }
  async function collect(directory: Target, depth: number): Promise<void> {
    checkCancellation(signal);
    if (depth > maxDepth) limitExceeded();
    const handle = await opendir(directory.absolute);
    for await (const entry of handle) {
      checkCancellation(signal);
      if (++entries > maxEntries) limitExceeded();
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) continue;
      if (entry.isFile() && !textExtensions.has(extname(entry.name).toLowerCase())) continue;
      let child: Target;
      try {
        child = await workspace.resolvePath(`${directory.relative}/${entry.name}`, signal);
      } catch (error) {
        if (error instanceof HarnessError && error.code === "PATH_NOT_ALLOWED") continue;
        throw error;
      }
      if (child.stat.isDirectory()) {
        await collect(child, depth + 1);
      } else if (textExtensions.has(extname(child.relative).toLowerCase())) {
        paths.push(child.relative);
        if (paths.length > maxFiles) limitExceeded();
      }
    }
  }
  if (recursive) await collect(target, 0);
  else paths.push(target.relative);
  paths.sort();

  const matches: Match[] = [];
  let totalMatches = 0;
  let scannedFiles = 0;
  let skippedFiles = 0;
  let pageBytes = 2;
  let pageFull = false;
  for (const path of paths) {
    checkCancellation(signal);
    // Resolve again after traversal so a changed file/link is not trusted from an earlier listing.
    const current = await workspace.resolvePath(path, signal);
    let content: string;
    try {
      ({ content } = await readTextFile(current, signal));
    } catch (error) {
      if (recursive && error instanceof HarnessError && ["FILE_TOO_LARGE", "UNSUPPORTED_FILE"].includes(error.code)) {
        skippedFiles++;
        continue;
      }
      throw error;
    }
    scannedFiles++;
    let line = 0;
    for (const item of content.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)) {
      checkCancellation(signal);
      if (!item[0]) continue;
      line++;
      const text = item[0].replace(/(?:\r\n|\r|\n)$/, "");
      if (!text.includes(options.query)) continue;
      const index = totalMatches++;
      if (index < options.offset || pageFull) continue;
      const match = { path, line, text };
      const size = Buffer.byteLength(JSON.stringify(match)) + (matches.length ? 1 : 0);
      if (pageBytes + size > maxPageBytes) {
        if (!matches.length) throw new HarnessError("OUTPUT_LIMIT", "One search match exceeds the 16384-byte page budget; narrow the query or inspect the file separately.");
        pageFull = true;
        continue;
      }
      matches.push(match);
      pageBytes += size;
      if (matches.length === options.limit) pageFull = true;
    }
  }
  checkCancellation(signal);
  const end = Math.min(options.offset, totalMatches) + matches.length;
  return { kind: "search", path: target.relative, query: options.query, offset: options.offset,
    totalMatches, matches, truncated: end < totalMatches, nextOffset: end < totalMatches ? end : null,
    scannedFiles, skippedFiles, complete: skippedFiles === 0,
  };
}
