import { randomUUID } from "node:crypto";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { checkCancellation, HarnessError } from "../errors.js";
import { decodeMemoryRecords, invalidMemory, memoryScopeKey } from "./record.js";
import type { MemoryRecord, MemoryScope } from "./record.js";

// JSON escaping can expand content, request, and evidence bytes sixfold across the bounded revision log.
export const maxMemoryFileBytes = 64 * 1024 * 1024;
const maxLockBytes = 1024;

export async function readMemoryRecords(directory: string, scope: MemoryScope, signal?: AbortSignal): Promise<MemoryRecord[]> {
	checkCancellation(signal);
	const key = memoryScopeKey(scope);
	const path = join(directory, `${key}.json`);
	let bytes: Buffer;
	try {
		if ((await lstat(path)).isSymbolicLink()) return invalidMemory();
		bytes = await readBounded(path, maxMemoryFileBytes, signal);
	} catch (error) {
		if (error instanceof HarnessError) throw error;
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
		throw new HarnessError("MEMORY_IO", "Could not read saved memory.");
	}
	const json = bytes.toString("utf8");
	if (!Buffer.from(json, "utf8").equals(bytes)) return invalidMemory();
	let value: unknown;
	try { value = JSON.parse(json); } catch { return invalidMemory(); }
	return decodeMemoryRecords(value, scope);
}

export async function publishMemoryRecords(directory: string, scope: MemoryScope, records: MemoryRecord[], signal?: AbortSignal): Promise<void> {
	const json = JSON.stringify({ version: 1, scope, records });
	if (Buffer.byteLength(json, "utf8") > maxMemoryFileBytes) {
		throw new HarnessError("MEMORY_LIMIT", "Memory metadata exceeds the scope storage limit.");
	}
	const key = memoryScopeKey(scope);
	const temporary = join(directory, `${key}.${randomUUID()}.tmp`);
	try {
		checkCancellation(signal);
		const handle = await open(temporary, "wx", 0o600);
		try { await handle.writeFile(json, "utf8"); await handle.sync(); } finally { await handle.close(); }
		checkCancellation(signal);
		await rename(temporary, join(directory, `${key}.json`));
	} catch (error) {
		if (error instanceof HarnessError) throw error;
		throw new HarnessError("MEMORY_IO", "Could not save memory. Check the memory directory and available disk space.");
	} finally { await unlink(temporary).catch(() => {}); }
}

export async function readMemoryLockOwner(path: string, signal?: AbortSignal): Promise<number | undefined> {
	try {
		const value: unknown = JSON.parse((await readBounded(path, maxLockBytes, signal)).toString("utf8"));
		if (typeof value === "object" && value !== null && "pid" in value
			&& Number.isSafeInteger(value.pid) && Number(value.pid) > 0) return Number(value.pid);
	} catch (error) { checkCancellation(signal); }
	return undefined;
}

async function readBounded(path: string, maximum: number, signal?: AbortSignal): Promise<Buffer> {
	const handle = await open(path, "r");
	try {
		const info = await handle.stat();
		if (!info.isFile() || info.size > maximum) return invalidMemory();
		const bytes = Buffer.alloc(Math.min(info.size + 1, maximum + 1));
		let count = 0;
		while (count < bytes.length) {
			checkCancellation(signal);
			const next = await handle.read(bytes, count, bytes.length - count, count);
			if (!next.bytesRead) break;
			count += next.bytesRead;
		}
		checkCancellation(signal);
		if (count !== info.size || count > maximum) return invalidMemory();
		return bytes.subarray(0, count);
	} finally { await handle.close(); }
}
