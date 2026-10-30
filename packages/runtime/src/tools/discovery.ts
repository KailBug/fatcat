import { opendir } from "node:fs/promises";
import { basename, extname, join, posix, relative } from "node:path";
import { HarnessError, checkCancellation } from "../errors.js";
import type { Workspace } from "../permissions/workspace.js";
import { textExtensions } from "../permissions/text-file.js";

export type SearchTarget = Awaited<ReturnType<Workspace["resolvePath"]>>;
export type DiscoveryOptions = { glob?: string; exclude: string[] };
export const discoveryLimits = { entries: 10000, files: 2048, depth: 32 };

export function validateGlob(value: unknown): string {
	if (typeof value !== "string" || !value.trim() || value.length > 512 || /[\\\x00-\x1f]/.test(value)
		|| value.startsWith("/") || value.split("/").includes("..") || /^[A-Za-z]:/.test(value)) {
		throw new HarnessError("INVALID_ARGUMENTS", "Glob patterns must be relative, use '/' separators, and contain 1 to 512 characters without '..'.");
	}
	return value;
}

export function matchesPattern(path: string, pattern: string): boolean {
	return posix.matchesGlob(pattern.includes("/") ? path : posix.basename(path), pattern);
}

/** Discover names within current permissions; filters never expand file access. */
export async function discoverFiles(workspace: Workspace, target: SearchTarget, options: DiscoveryOptions,
	textOnly: boolean, signal?: AbortSignal): Promise<string[]> {
	const paths = new Set<string>();
	const visited = new Set<string>();
	let entries = 0;
	const root = target.stat.isDirectory() ? target.absolute : undefined;
	function accept(child: SearchTarget): boolean {
		const path = root ? relative(root, child.absolute).replaceAll("\\", "/") : basename(child.absolute);
		return (!options.glob || matchesPattern(path, options.glob))
			&& !options.exclude.some((pattern) => matchesPattern(path, pattern))
			&& (!textOnly || target.unrestricted || textExtensions.has(extname(child.relative).toLowerCase()));
	}
	function overflow(): never {
		throw new HarnessError("SEARCH_LIMIT", "Discovery exceeds 10000 entries, 2048 matching files, or 32 directory levels. Narrow path, glob, or exclude; no complete result is available.");
	}
	async function collect(directory: SearchTarget, depth: number): Promise<void> {
		checkCancellation(signal);
		if (visited.has(directory.absolute)) return;
		visited.add(directory.absolute);
		if (depth > discoveryLimits.depth) overflow();
		const handle = await opendir(directory.absolute);
		for await (const entry of handle) {
			checkCancellation(signal);
			if (++entries > discoveryLimits.entries) overflow();
			const local = relative(root!, join(directory.absolute, entry.name)).replaceAll("\\", "/");
			if (options.exclude.some((pattern) => matchesPattern(local, pattern) || matchesPattern(`${local}/`, pattern))) continue;
			if (!target.unrestricted && (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory()))) continue;
			let child: SearchTarget;
			try {
				child = await workspace.resolvePath(directory.unrestricted ? join(directory.absolute, entry.name)
					: `${directory.relative}/${entry.name}`, signal);
			} catch (error) {
				if (error instanceof HarnessError && error.code === "PATH_NOT_ALLOWED") continue;
				if (target.unrestricted && ((error as NodeJS.ErrnoException).code === "ENOENT"
					|| error instanceof HarnessError && error.code === "UNSUPPORTED_FILE")) continue;
				throw error;
			}
			if (child.stat.isDirectory()) await collect(child, depth + 1);
			else if (accept(child)) paths.add(child.relative);
			if (paths.size > discoveryLimits.files) overflow();
		}
	}
	if (root) await collect(target, 0);
	else if (accept(target)) paths.add(target.relative);
	return [...paths].sort();
}

export function searchArguments(args: unknown, extra: string[] = []): Record<string, unknown> & {
	path: string; offset: number; limit: number; exclude: string[]; glob?: string;
} {
	if (!args || typeof args !== "object" || Array.isArray(args)
		|| Object.keys(args).some((key) => !["path", "offset", "limit", "glob", "exclude", ...extra].includes(key))) {
		throw new HarnessError("INVALID_ARGUMENTS", "Expected only documented search parameters.");
	}
	const input = args as Record<string, unknown>;
	const { path = ".", offset = 0, limit = 100, exclude = ["**/.git/**", "**/node_modules/**"] } = input;
	if (typeof path !== "string" || !path.trim() || path.length > 1024
		|| typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0
		|| typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1 || limit > 200
		|| !Array.isArray(exclude) || exclude.length > 32) {
		throw new HarnessError("INVALID_ARGUMENTS", "Expected path, a nonnegative safe offset, limit 1-200, and up to 32 exclusion patterns.");
	}
	return { ...input, path, offset, limit, exclude: exclude.map(validateGlob),
		...(input.glob === undefined ? {} : { glob: validateGlob(input.glob) }) };
}
