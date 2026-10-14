import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { checkCancellation, HarnessError } from "../errors.js";
import { decodeMemoryRecords, invalidMemory, maxMemoryRecords, maxMemoryRevisions, memoryFingerprint, memoryIdPattern,
	memoryScopeKey, validateMemoryContent, validateMemoryScope, validateMemorySource } from "./record.js";
import type { MemoryChange, MemoryRecord, MemoryScope, MemorySource } from "./record.js";

// JSON escaping can expand content, request, and evidence bytes sixfold across the bounded revision log.
export const maxMemoryFileBytes = 64 * 1024 * 1024;
const maxLockBytes = 1024;
const lockAttempts = 40;
const lockRetryMilliseconds = 25;

/** Scope snapshots stay separate from session histories, attachments, and derived indexes. */
export class MemoryStore {
	readonly root: string | undefined;
	private readonly records = new Map<string, MemoryRecord[]>();
	private pending = Promise.resolve();

	constructor(root?: string) {
		if (root !== undefined && (typeof root !== "string" || !root.trim())) {
			throw new HarnessError("INVALID_ARGUMENTS", "The memory storage root must be a non-empty directory path.");
		}
		this.root = root === undefined ? undefined : join(resolve(root), "memory");
	}

	async list(scopes: readonly MemoryScope[], signal?: AbortSignal): Promise<MemoryRecord[]> {
		checkCancellation(signal);
		if (!Array.isArray(scopes)) {
			throw new HarnessError("INVALID_ARGUMENTS", "List memory using explicit scopes.");
		}
		const validated = scopes.map(validateMemoryScope);
		return this.withLock(async () => {
			const seen = new Set<string>();
			const records: MemoryRecord[] = [];
			for (const scope of validated) {
				checkCancellation(signal);
				const key = memoryScopeKey(scope);
				if (seen.has(key)) continue;
				seen.add(key);
				records.push(...await this.read(scope, signal));
			}
			checkCancellation(signal);
			return structuredClone(records);
		}, signal);
	}

	/** The caller holds the shared metadata gate until its durable session-move journal is published. */
	async previewSessionMove(sessionId: string, projectId: string, expectedFingerprint?: string): Promise<void> {
		const session = validateMemoryScope({ kind: "session", id: sessionId });
		const project = validateMemoryScope({ kind: "project", id: projectId });
		await this.withLock(async () => { await this.movedRecords(session, project, expectedFingerprint); });
	}

	/** Replayed by the metadata journal before readers can observe the changed session association. */
	async moveSessionToProject(sessionId: string, projectId: string): Promise<void> {
		const session = validateMemoryScope({ kind: "session", id: sessionId });
		const project = validateMemoryScope({ kind: "project", id: projectId });
		await this.withLock(async () => {
			const { privateRecords, merged } = await this.movedRecords(session, project);
			if (!privateRecords.length) return;
			if (this.root === undefined) {
				this.records.set(memoryScopeKey(project), merged);
				this.records.set(memoryScopeKey(session), []);
				return;
			}
			await this.publish(project, merged);
			await this.publish(session, []);
		});
	}

	private async movedRecords(session: MemoryScope, project: MemoryScope,
		expectedFingerprint?: string): Promise<{ privateRecords: MemoryRecord[]; merged: MemoryRecord[] }> {
		const privateRecords = await this.read(session);
		if (expectedFingerprint !== undefined && memoryFingerprint(privateRecords) !== expectedFingerprint) {
			throw new HarnessError("MEMORY_CONFLICT", "Private memory changed. Review a fresh sharing preview before moving this session.");
		}
		const merged = await this.read(project);
		for (const record of privateRecords) {
			const moved = { ...record, scope: project };
			const existing = merged.find((item) => item.id === record.id);
			if (!existing) merged.push(moved);
			else if (JSON.stringify(existing) !== JSON.stringify(moved)) {
				throw new HarnessError("MEMORY_CONFLICT", "The destination project has a different revision of the same memory. Repair the interrupted move before continuing.");
			}
		}
		if (merged.length > maxMemoryRecords) {
			throw new HarnessError("MEMORY_LIMIT", `Joining this project would exceed its ${maxMemoryRecords} memory records, including deleted records.`);
		}
		return { privateRecords, merged };
	}

	async create(scope: MemoryScope, content: string, source: MemorySource, signal?: AbortSignal): Promise<MemoryRecord> {
		checkCancellation(signal);
		const validatedScope = validateMemoryScope(scope);
		const validatedContent = validateMemoryContent(content);
		const validatedSource = validateMemorySource(source);
		return this.mutate(validatedScope, (records) => {
			if (records.length >= maxMemoryRecords) {
				throw new HarnessError("MEMORY_LIMIT", `A memory scope supports at most ${maxMemoryRecords} records, including deleted records.`);
			}
			const change: MemoryChange = { revision: 1, content: validatedContent, status: "active",
				source: validatedSource, updatedAt: new Date().toISOString() };
			const record: MemoryRecord = { id: randomUUID(), scope: validatedScope, ...change, changes: [change] };
			records.push(record);
			return record;
		}, signal);
	}

	async update(scope: MemoryScope, id: string, revision: number, content: string | null,
		source: MemorySource, signal?: AbortSignal): Promise<MemoryRecord> {
		checkCancellation(signal);
		const validatedScope = validateMemoryScope(scope);
		const validatedContent = content === null ? null : validateMemoryContent(content);
		const validatedSource = validateMemorySource(source);
		if (typeof id !== "string" || !memoryIdPattern.test(id) || !Number.isSafeInteger(revision) || revision < 1) {
			throw new HarnessError("INVALID_ARGUMENTS", "Update memory using its exact UUID and positive current revision.");
		}
		return this.mutate(validatedScope, (records) => {
			const index = records.findIndex((record) => record.id === id);
			const previous = records[index];
			if (!previous || previous.revision !== revision || previous.status !== "active") {
				throw new HarnessError("MEMORY_CONFLICT", "The memory is missing, deleted, or changed. List current memory before retrying.");
			}
			if (previous.revision >= maxMemoryRevisions || (validatedContent !== null && previous.revision >= maxMemoryRevisions - 1)) {
				throw new HarnessError("MEMORY_LIMIT", `A memory record supports at most ${maxMemoryRevisions} revisions; the final revision is reserved for deletion.`);
			}
			const change: MemoryChange = { revision: previous.revision + 1, content: validatedContent ?? "",
				status: validatedContent === null ? "deleted" : "active", source: validatedSource, updatedAt: new Date().toISOString() };
			const record: MemoryRecord = { id, scope: validatedScope, ...change, changes: [...previous.changes, change] };
			records[index] = record;
			return record;
		}, signal);
	}

	private async mutate(scope: MemoryScope, operation: (records: MemoryRecord[]) => MemoryRecord,
		signal?: AbortSignal): Promise<MemoryRecord> {
		checkCancellation(signal);
		const key = memoryScopeKey(scope);
		if (this.root === undefined) {
			return this.withLock(async () => {
				const records = structuredClone(this.records.get(key) ?? []);
				const record = operation(records);
				this.records.set(key, records);
				return structuredClone(record);
			}, signal);
		}
		return this.withLock(async () => {
			const records = await this.read(scope, signal);
			const record = operation(records);
			await this.publish(scope, records, signal);
			return structuredClone(record);
		}, signal);
	}

	private async withLock<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		checkCancellation(signal);
		if (this.root === undefined) {
			const result = this.pending.then(() => { checkCancellation(signal); return operation(); });
			this.pending = result.then(() => {}, () => {});
			return result;
		}
		try { await mkdir(this.root, { recursive: true, mode: 0o700 }); }
		catch { throw new HarnessError("MEMORY_IO", "Could not create the local memory directory."); }
		const release = await this.lock(signal);
		try { checkCancellation(signal); return await operation(); }
		finally { await release(); }
	}

	private async read(scope: MemoryScope, signal?: AbortSignal): Promise<MemoryRecord[]> {
		checkCancellation(signal);
		const key = memoryScopeKey(scope);
		if (this.root === undefined) return structuredClone(this.records.get(key) ?? []);
		const path = join(this.root, `${key}.json`);
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

	private async publish(scope: MemoryScope, records: MemoryRecord[], signal?: AbortSignal): Promise<void> {
		const json = JSON.stringify({ version: 1, scope, records });
		if (Buffer.byteLength(json, "utf8") > maxMemoryFileBytes) {
			throw new HarnessError("MEMORY_LIMIT", "Memory metadata exceeds the scope storage limit.");
		}
		const key = memoryScopeKey(scope);
		const temporary = join(this.root!, `${key}.${randomUUID()}.tmp`);
		try {
			checkCancellation(signal);
			const handle = await open(temporary, "wx", 0o600);
			try { await handle.writeFile(json, "utf8"); await handle.sync(); } finally { await handle.close(); }
			checkCancellation(signal);
			await rename(temporary, join(this.root!, `${key}.json`));
		} catch (error) {
			if (error instanceof HarnessError) throw error;
			throw new HarnessError("MEMORY_IO", "Could not save memory. Check the memory directory and available disk space.");
		} finally { await unlink(temporary).catch(() => {}); }
	}

	private async lock(signal?: AbortSignal): Promise<() => Promise<void>> {
		const path = join(this.root!, "store.lock");
		for (let attempt = 0; attempt < lockAttempts; attempt++) {
			checkCancellation(signal);
			try {
				const handle = await open(path, "wx", 0o600);
				try { await handle.writeFile(JSON.stringify({ pid: process.pid })); }
				catch (error) { await handle.close(); await unlink(path).catch(() => {}); throw error; }
				return async () => { await handle.close().catch(() => {}); await unlink(path).catch(() => {}); };
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
					throw new HarnessError("MEMORY_IO", "Could not lock the memory scope.");
				}
				await this.recoverLock(path, signal);
				try { await delay(lockRetryMilliseconds, undefined, { signal }); }
				catch { checkCancellation(signal); throw new HarnessError("MEMORY_IO", "Could not wait for the memory scope lock."); }
			}
		}
		throw new HarnessError("MEMORY_CONFLICT", "The memory scope is busy or its lock is incomplete. Try again shortly.");
	}

	private async lockOwner(path: string, signal?: AbortSignal): Promise<number | undefined> {
		try {
			const value: unknown = JSON.parse((await readBounded(path, maxLockBytes, signal)).toString("utf8"));
			if (typeof value === "object" && value !== null && "pid" in value
				&& Number.isSafeInteger(value.pid) && Number(value.pid) > 0) return Number(value.pid);
		} catch (error) { checkCancellation(signal); }
		return undefined;
	}

	private async recoverLock(path: string, signal?: AbortSignal): Promise<void> {
		const owner = await this.lockOwner(path, signal);
		if (owner === undefined || processAlive(owner)) return;
		let gate;
		try { gate = await open(`${path}.recovery`, "wx", 0o600); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
			throw new HarnessError("MEMORY_IO", "Could not recover the memory scope lock.");
		}
		try {
			const current = await this.lockOwner(path, signal);
			if (current !== undefined && !processAlive(current)) await unlink(path);
		} catch (error) {
			if (error instanceof HarnessError) throw error;
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new HarnessError("MEMORY_IO", "Could not recover the memory scope lock.");
		} finally { await gate.close().catch(() => {}); await unlink(`${path}.recovery`).catch(() => {}); }
	}
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

function processAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
