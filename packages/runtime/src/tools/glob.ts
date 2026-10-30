import { HarnessError, checkCancellation } from "../errors.js";
import type { Workspace } from "../permissions/workspace.js";
import type { Tool } from "./types.js";
import { discoverFiles, validateGlob, searchArguments } from "./discovery.js";

export function createGlobTool(workspace: Workspace): Tool {
	return {
		definition: {
			name: "glob",
			description: "Find permission-allowed files by relative glob pattern without reading contents. Example: pattern='src/**/*.ts'. Patterns without '/' match basenames at any depth. Supports Node glob syntax; use '/' separators. path defaults '.', offset 0, limit 100 (max 200). exclude defaults to ['**/.git/**','**/node_modules/**']; [] removes these filters but never expands permissions. No .gitignore parsing. Returns sorted paths usable by read, totalFiles and nextOffset. Each page has a 16 KiB budget; repeat identical options to continue. Every call rescans, not a snapshot. Discovery caps: 10000 entries, 2048 matching files, 32 levels; narrow path or exclusions on SEARCH_LIMIT.",
			parameters: { type: "object", properties: {
				pattern: { type: "string", minLength: 1, maxLength: 512 },
				path: { type: "string", minLength: 1, maxLength: 1024 },
				exclude: { type: "array", maxItems: 32, items: { type: "string", minLength: 1, maxLength: 512 } },
				offset: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
				limit: { type: "integer", minimum: 1, maximum: 200 },
			}, required: ["pattern"], additionalProperties: false },
		},
		execute: async (args, signal) => {
			const lease = workspace.permissionPolicy?.beginOperation();
			try {
				checkCancellation(signal);
				if (args && typeof args === "object" && "glob" in args) throw new HarnessError("INVALID_ARGUMENTS", "Use pattern for glob discovery.");
				const input = searchArguments(args, ["pattern"]);
				const pattern = validateGlob(input.pattern);
				const target = await workspace.resolvePath(input.path, signal);
				if (!target.stat.isDirectory()) throw new HarnessError("INVALID_ARGUMENTS", "glob path must be a directory. Use read for a known file.");
				const files = await discoverFiles(workspace, target, { glob: pattern, exclude: input.exclude }, false, signal);
				const paths: string[] = [];
				let bytes = 2;
				for (const path of files.slice(input.offset, input.offset + input.limit)) {
					const size = Buffer.byteLength(JSON.stringify(path)) + (paths.length ? 1 : 0);
					if (bytes + size > 16384) {
						if (!paths.length) throw new HarnessError("OUTPUT_LIMIT", "One path exceeds the page budget. Narrow the directory.");
						break;
					}
					paths.push(path); bytes += size;
				}
				checkCancellation(signal);
				const end = Math.min(input.offset, files.length) + paths.length;
				return { ok: true, result: { kind: "glob", path: target.relative, pattern, paths, offset: input.offset,
					totalFiles: files.length, truncated: end < files.length, nextOffset: end < files.length ? end : null } };
			} finally { lease?.release(); }
		},
	};
}
