import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { arch, platform, release } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { ArtifactReference, Experiment } from "./experiment.js";

const execute = promisify(execFile);
const checkout = fileURLToPath(new URL("../../../../", import.meta.url));

export function sha256(value: Uint8Array | string): string {
	return createHash("sha256").update(value).digest("hex");
}

/** Paths in manifests are portable, relative file names, never host paths. */
export function relativeFile(value: string): string {
	if (!value || value.includes("\\") || value.includes(":") || isAbsolute(value)
		|| value.split("/").some((part) => !part || /[<>"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part)
			|| /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) {
		throw new Error("Expected a portable relative file path.");
	}
	return value;
}

export function inside(root: string, path: string): boolean {
	const part = relative(root, path);
	return !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`);
}

/** Resolve and verify local materials before any model or workspace operation. */
export async function readArtifact(root: string, reference: ArtifactReference): Promise<Buffer> {
	const base = await realpath(root);
	const path = resolve(base, relativeFile(reference.source));
	if (!inside(base, await realpath(path))) throw new Error("Artifact escapes its source directory.");
	const stat = await lstat(path);
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576) throw new Error("Artifact must be a regular file of at most 1 MiB.");
	const bytes = await readFile(path);
	if (bytes.length > 1_048_576 || sha256(bytes) !== reference.sha256) throw new Error("Artifact content does not match its digest.");
	return bytes;
}

export async function writeArtifact(root: string, name: string, value: unknown): Promise<ArtifactReference> {
	const bytes = JSON.stringify(value, null, 2) + "\n";
	await writeFile(join(root, relativeFile(name)), bytes, { flag: "wx" });
	return { source: name, sha256: sha256(bytes) };
}

/** Observe the checkout containing this built adapter, not the dataset directory. */
export async function inspectExecution(): Promise<{ code: Experiment["code"]; environment: Experiment["environment"]; buildDigest: string }> {
	const pnpm = /(?:^|\s)pnpm\/([^\s]+)/.exec(process.env.npm_config_user_agent ?? "")?.[1];
	if (!pnpm) throw new Error("Run the evaluation through pnpm so its actual version can be recorded.");
	const options = { cwd: checkout, encoding: "utf8" as const, windowsHide: true, timeout: 10_000 };
	const gitSha = (await execute("git", ["rev-parse", "HEAD"], options)).stdout.trim();
	const dirty = (await execute("git", ["status", "--porcelain", "--untracked-files=normal"], options)).stdout.trim().length > 0;
	const builds: { path: string; sha256: string }[] = [];
	for (const directory of ["packages/runtime/dist", "packages/eval/dist"]) {
		for (const file of (await readdir(join(checkout, directory), { recursive: true })).filter((name) => name.endsWith(".js")).sort()) {
			builds.push({ path: `${directory}/${file.replaceAll("\\", "/")}`, sha256: sha256(await readFile(join(checkout, directory, file))) });
		}
	}
	return { code: { gitSha, dirty }, environment: { os: `${platform()} ${release()} ${arch()}`, node: process.versions.node, pnpm },
		buildDigest: sha256(JSON.stringify(builds)) };
}
