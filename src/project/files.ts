import { randomUUID } from "node:crypto";
import { open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { HarnessError } from "../errors.js";
import { decodeProjectRecord, invalidProject, projectIdPattern } from "./record.js";
import type { ProjectRecord } from "./record.js";

const maxProjectBytes = 64 * 1024;

export async function readProjectRecord(directory: string, id: string): Promise<ProjectRecord> {
	if (!projectIdPattern.test(id)) throw new HarnessError("PROJECT_NOT_FOUND", "No matching project exists. Use /projects.");
	let handle;
	try {
		handle = await open(join(directory, `${id}.json`), "r");
		const info = await handle.stat();
		if (!info.isFile() || info.size > maxProjectBytes) return invalidProject();
		const bytes = Buffer.alloc(Math.min(info.size + 1, maxProjectBytes + 1));
		let count = 0;
		while (count < bytes.length) {
			const next = await handle.read(bytes, count, bytes.length - count, count);
			if (!next.bytesRead) break;
			count += next.bytesRead;
		}
		if (count !== info.size || count > maxProjectBytes) return invalidProject();
		const json = bytes.subarray(0, count).toString("utf8");
		if (!Buffer.from(json, "utf8").equals(bytes.subarray(0, count))) return invalidProject();
		let value: unknown;
		try { value = JSON.parse(json); } catch { return invalidProject(); }
		return decodeProjectRecord(value, id);
	} catch (error) {
		if (error instanceof HarnessError) throw error;
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new HarnessError("PROJECT_NOT_FOUND", "The session's project is missing. Restore its project record before continuing.");
		}
		throw new HarnessError("PROJECT_STORAGE", "Could not read the saved project.");
	} finally { await handle?.close(); }
}

export async function publishProjectRecord(directory: string, record: ProjectRecord): Promise<void> {
	const json = JSON.stringify(record);
	if (Buffer.byteLength(json) > maxProjectBytes) throw new HarnessError("PROJECT_LIMIT", "Project metadata exceeds the storage limit.");
	const temporary = join(directory, `${record.id}.${randomUUID()}.tmp`);
	try {
		const handle = await open(temporary, "wx", 0o600);
		try { await handle.writeFile(json, "utf8"); await handle.sync(); } finally { await handle.close(); }
		await rename(temporary, join(directory, `${record.id}.json`));
	} catch { throw new HarnessError("PROJECT_STORAGE", "Could not save project data. Check the project directory and available disk space."); }
	finally { await unlink(temporary).catch(() => {}); }
}

export async function readProjectLockOwner(path: string): Promise<number | undefined> {
	try {
		const owner: unknown = JSON.parse(await readFile(path, "utf8"));
		if (typeof owner === "object" && owner !== null && "pid" in owner
			&& Number.isSafeInteger(owner.pid) && Number(owner.pid) > 0) return Number(owner.pid);
	} catch { /* Incomplete locks are never assumed stale. */ }
	return undefined;
}
