import { open } from "node:fs/promises";
import { extname } from "node:path";
import { HarnessError, checkCancellation } from "../errors.js";
import type { Workspace } from "./workspace.js";

/** Bound text access before reads, replacements and publication. */
export const maxFileBytes = 1024 * 1024;
export const textExtensions = new Set([
  ".txt", ".md", ".json", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".yaml", ".yml", ".toml", ".csv", ".html", ".css", ".xml", ".sql", ".py",
]);

type Target = Awaited<ReturnType<Workspace["resolvePath"]>>;

export async function readTextFile(target: Target, signal?: AbortSignal, extensions: ReadonlySet<string> = textExtensions) {
  if (!target.unrestricted && !extensions.has(extname(target.absolute).toLowerCase())) {
    throw new HarnessError("UNSUPPORTED_FILE", "Only supported text file extensions can be read.");
  }
  const file = await open(target.absolute, "r");
  try {
    const opened = await file.stat();
    if (!opened.isFile() || (!target.unrestricted && opened.nlink > 1) || opened.dev !== target.stat.dev || opened.ino !== target.stat.ino) {
      throw new HarnessError("PATH_NOT_ALLOWED", "The file changed during path validation.");
    }
    if (opened.size > maxFileBytes) throw new HarnessError("FILE_TOO_LARGE", "Text files must not exceed 1048576 bytes.");
    // One extra byte detects growth while keeping memory use bounded.
    const buffer = Buffer.alloc(maxFileBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      checkCancellation(signal);
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead) break;
      size += bytesRead;
    }
    checkCancellation(signal);
    if (size > maxFileBytes) throw new HarnessError("FILE_TOO_LARGE", "Text files must not exceed 1048576 bytes.");
    try {
      const content = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size));
      if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content)) throw new Error();
      return { content, bytes: buffer.subarray(0, size) };
    } catch {
      throw new HarnessError("UNSUPPORTED_FILE", "The file must contain UTF-8 text without binary control bytes.");
    }
  } finally {
    await file.close();
  }
}
