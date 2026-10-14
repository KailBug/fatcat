import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { HarnessError } from "../errors.js";
import { decodeSessionRecord, encodeSessionRecord, projectIdOf, workspaceKey } from "../session/record.js";
import type { SessionRecord } from "../session/record.js";
import { decodeProjectRecord, projectIdPattern } from "../project/record.js";
import type { ProjectRecord } from "../project/record.js";
import { maxProjectMembers, movedProjectSession } from "../project/management.js";
import type { ProjectSessionMove } from "../project/management.js";
import { attachmentIdPattern, decodeAttachmentCatalog, emptyAttachmentCatalog, parseAttachmentReference } from "./record.js";
import type { AttachmentCatalog, AttachmentRef } from "./record.js";

export interface AttachmentSessionAccess {
	load(id: string): Promise<SessionRecord>;
	prepareDraft(record: SessionRecord): Promise<SessionRecord>;
	publish(record: SessionRecord): Promise<void>;
	remove(id: string, storageWorkspace: string): Promise<void>;
}

export interface MetadataCommit {
	catalog: AttachmentCatalog;
	writes?: SessionRecord[];
	deletes?: Array<{ id: string; storageWorkspace: string }>;
	purge?: AttachmentRef[];
	projectWrite?: ProjectRecord;
	projectDelete?: string;
	sessionMoves?: ProjectSessionMove[];
}

const maxCatalogBytes = 16 * 1024 * 1024;
const maxJournalBytes = 96 * 1024 * 1024;
const metadataQueues = new Map<string, Promise<void>>();

/** One short metadata gate covers Session identity, attachment associations and recovery. */
export class AttachmentTransactions {
	readonly directory: string;
	private readonly journal: string;

	constructor(private readonly root: string, private readonly sessions?: AttachmentSessionAccess) {
		this.directory = join(root, "attachments");
		this.journal = join(this.directory, "pending.json");
	}

	async withLock<T>(operation: () => Promise<T>, create = true): Promise<T> {
		const key = process.platform === "win32" ? this.root.toLowerCase() : this.root;
		const previous = metadataQueues.get(key) ?? Promise.resolve();
		let releaseQueue!: () => void;
		const current = new Promise<void>((resolve) => { releaseQueue = resolve; });
		metadataQueues.set(key, current);
		await previous;
		try { return await this.withProcessLock(operation, create); }
		finally {
			releaseQueue();
			if (metadataQueues.get(key) === current) metadataQueues.delete(key);
		}
	}

	private async withProcessLock<T>(operation: () => Promise<T>, create: boolean): Promise<T> {
		if (!create) {
			try { await stat(this.root); }
			catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return operation(); throw error; }
		}
		try { await mkdir(this.root, { recursive: true, mode: 0o700 }); }
		catch { throw new HarnessError("SESSION_STORAGE", "Could not open the local session metadata directory."); }
		const release = await this.lock();
		try {
			await this.recover();
			return await operation();
		} finally { await release(); }
	}

	async catalog(): Promise<AttachmentCatalog> {
		const value = await boundedJson(join(this.directory, "catalog.json"), maxCatalogBytes, true);
		return value === undefined ? emptyAttachmentCatalog() : decodeAttachmentCatalog(value);
	}

	async publishCatalog(catalog: AttachmentCatalog): Promise<void> {
		await atomicJson(join(this.directory, "catalog.json"), decodeAttachmentCatalog(catalog), maxCatalogBytes);
	}

	/** The journal is the durable decision. Readers recover it before observing either owner. */
	async commit(change: MetadataCommit): Promise<void> {
		const journal = { version: 2, catalog: change.catalog, writes: (change.writes ?? []).map(encodeSessionRecord),
			deletes: change.deletes ?? [], purge: change.purge ?? [], sessionMoves: change.sessionMoves ?? [],
			...(change.projectWrite ? { projectWrite: change.projectWrite } : {}),
			...(change.projectDelete ? { projectDelete: change.projectDelete } : {}) };
		const validated = this.decodeCommit(journal);
		if (Buffer.byteLength(JSON.stringify(validated.catalog)) > maxCatalogBytes) {
			throw new HarnessError("ATTACHMENT_LIMIT", "Attachment metadata exceeds the local storage limit.");
		}
		for (const record of validated.writes ?? []) {
			if (Buffer.byteLength(JSON.stringify(encodeSessionRecord(record))) > 64 * 1024 * 1024) {
				throw new HarnessError("SESSION_LIMIT", "Session data exceeds the 64 MiB storage limit. Start a new session.");
			}
		}
		if (validated.projectWrite && Buffer.byteLength(JSON.stringify(validated.projectWrite)) > 64 * 1024) {
			throw new HarnessError("PROJECT_LIMIT", "Project metadata exceeds the storage limit.");
		}
		await atomicJson(this.journal, journal, maxJournalBytes);
		try { await this.apply(validated); await unlink(this.journal); }
		catch { throw new HarnessError("ATTACHMENT_RECOVERY_PENDING", "The confirmed metadata change needs recovery. Retry or reopen the session; do not repeat the upload or migration."); }
	}

	blobPath(ref: AttachmentRef): string {
		parseAttachmentReference(`attachment:${ref.attachmentId}@${ref.contentVersion}`);
		return join(this.directory, "blobs", ref.attachmentId, ref.contentVersion);
	}

	private async recover(): Promise<void> {
		const raw = await boundedJson(this.journal, maxJournalBytes, true);
		if (raw === undefined) return;
		try {
			await this.apply(this.decodeCommit(raw));
			await unlink(this.journal);
		} catch { throw new HarnessError("ATTACHMENT_RECOVERY_PENDING", "Attachment metadata recovery could not finish. Restore storage access before continuing."); }
	}

	private decodeCommit(raw: unknown): MetadataCommit {
		if (!isRecord(raw) || (raw.version !== 1 && raw.version !== 2) || !Array.isArray(raw.writes) || raw.writes.length > 2
			|| !Array.isArray(raw.deletes) || raw.deletes.length > maxProjectMembers
			|| !Array.isArray(raw.purge) || raw.purge.length > 10000) throw new HarnessError("ATTACHMENT_CORRUPT", "Invalid metadata transaction.");
		const writes = raw.writes.map((value) => {
			if (!isRecord(value) || typeof value.id !== "string" || typeof value.storageWorkspace !== "string") throw new Error("Invalid session snapshot.");
			return decodeSessionRecord(value, value.storageWorkspace, value.id);
		});
		const deletes = raw.deletes.map((value) => {
			if (!isRecord(value) || typeof value.id !== "string" || !attachmentIdPattern.test(value.id)
				|| typeof value.storageWorkspace !== "string" || !isAbsolute(value.storageWorkspace)) throw new Error("Invalid session deletion.");
			return { id: value.id, storageWorkspace: value.storageWorkspace };
		});
		const purge = raw.purge.map((value) => {
			if (!isRecord(value)) throw new Error("Invalid original deletion.");
			return parseAttachmentReference(`attachment:${String(value.attachmentId)}@${String(value.contentVersion)}`);
		});
		const moves = raw.sessionMoves ?? [];
		if (!Array.isArray(moves) || moves.length > maxProjectMembers) throw new Error("Too many project sessions.");
		const sessionMoves = moves.map(decodeSessionMove);
		let projectWrite: ProjectRecord | undefined;
		if (raw.projectWrite !== undefined) {
			if (!isRecord(raw.projectWrite) || typeof raw.projectWrite.id !== "string") throw new Error("Invalid project snapshot.");
			projectWrite = decodeProjectRecord(raw.projectWrite, raw.projectWrite.id);
		}
		if (raw.projectDelete !== undefined && (typeof raw.projectDelete !== "string" || !projectIdPattern.test(raw.projectDelete))) throw new Error("Invalid project deletion.");
		if (projectWrite && raw.projectDelete !== undefined) throw new Error("Conflicting project changes.");
		if (sessionMoves.some((move) => move.projectId !== projectWrite?.id || move.toWorkspace !== projectWrite.workspace)
			|| new Set(sessionMoves.map((move) => move.id)).size !== sessionMoves.length
			|| new Set(deletes.map((item) => item.id)).size !== deletes.length) throw new Error("Invalid project members.");
		return { catalog: decodeAttachmentCatalog(raw.catalog), writes, deletes, purge, sessionMoves,
			...(projectWrite ? { projectWrite } : {}), ...(typeof raw.projectDelete === "string" ? { projectDelete: raw.projectDelete } : {}) };
	}

	private async apply(change: MetadataCommit): Promise<void> {
		for (const record of change.writes ?? []) await this.publishSession(record);
		if (change.projectWrite) await atomicJson(join(this.root, "projects", `${change.projectWrite.id}.json`), change.projectWrite, 64 * 1024);
		for (const move of change.sessionMoves ?? []) await this.moveSession(move);
		await this.publishCatalog(change.catalog);
		for (const record of change.deletes ?? []) {
			if (this.sessions) await this.sessions.remove(record.id, record.storageWorkspace);
			else await removeFile(join(this.root, workspaceKey(record.storageWorkspace), `${record.id}.json`));
		}
		if (change.projectDelete) await removeFile(join(this.root, "projects", `${change.projectDelete}.json`));
		for (const ref of change.purge ?? []) {
			await unlink(this.blobPath(ref)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
		}
	}

	private async publishSession(record: SessionRecord): Promise<void> {
		if (this.sessions) return this.sessions.publish(record);
		await atomicJson(join(this.root, workspaceKey(record.storageWorkspace ?? record.workspace), `${record.id}.json`), encodeSessionRecord(record), 64 * 1024 * 1024);
	}

	private async moveSession(move: ProjectSessionMove): Promise<void> {
		const value = await boundedJson(join(this.root, workspaceKey(move.storageWorkspace), `${move.id}.json`), 64 * 1024 * 1024);
		const record = decodeSessionRecord(value, move.storageWorkspace, move.id);
		if (record.revision === move.expectedRevision + 1 && projectIdOf(record) === move.projectId
			&& record.locationRevision === move.locationRevision + 1 && record.locationChanges?.some((change) => change.id === move.changeId)) return;
		await this.publishSession(movedProjectSession(record, move));
	}

	private async lock(): Promise<() => Promise<void>> {
		const path = join(this.root, "metadata.lock");
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const handle = await open(path, "wx", 0o600);
				try { await handle.writeFile(JSON.stringify({ pid: process.pid })); }
				catch (error) { await handle.close(); await unlink(path).catch(() => {}); throw error; }
				return async () => { await handle.close().catch(() => {}); await unlink(path).catch(() => {}); };
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new HarnessError("SESSION_STORAGE", "Could not lock the local metadata directory.");
				const pid = await lockOwner(path);
				if (pid !== undefined && !processAlive(pid)) {
					let recovery;
					try { recovery = await open(`${path}.recovery`, "wx", 0o600); }
					catch { throw new HarnessError("SESSION_BUSY", "Metadata lock recovery is busy. Try again shortly."); }
					try {
						const latest = await lockOwner(path);
						if (latest === undefined || processAlive(latest)) throw new HarnessError("SESSION_BUSY", "The metadata store is busy or its lock is incomplete.");
						await unlink(path);
					} finally { await recovery.close().catch(() => {}); await unlink(`${path}.recovery`).catch(() => {}); }
					continue;
				}
				throw new HarnessError("SESSION_BUSY", "The local metadata store is busy or its lock is incomplete. Try again shortly.");
			}
		}
		throw new HarnessError("SESSION_BUSY", "Could not acquire the local metadata lock.");
	}
}

export async function atomicJson(path: string, value: unknown, maximum: number): Promise<void> {
	const json = JSON.stringify(value);
	if (Buffer.byteLength(json) > maximum) throw new HarnessError("ATTACHMENT_LIMIT", "Attachment metadata exceeds the local storage limit.");
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		const handle = await open(temporary, "wx", 0o600);
		try { await handle.writeFile(json, "utf8"); await handle.sync(); } finally { await handle.close(); }
		await rename(temporary, path);
	} finally { await unlink(temporary).catch(() => {}); }
}

export async function boundedJson(path: string, maximum: number, optional = false): Promise<unknown> {
	let handle;
	try {
		handle = await open(path, "r");
		const info = await handle.stat();
		if (!info.isFile() || info.size > maximum) throw new Error();
		const bytes = Buffer.alloc(Math.min(info.size + 1, maximum + 1));
		let count = 0;
		while (count < bytes.length) {
			const chunk = await handle.read(bytes, count, bytes.length - count, count);
			if (!chunk.bytesRead) break;
			count += chunk.bytesRead;
		}
		if (count !== info.size || count > maximum) throw new Error();
		const json = bytes.subarray(0, count).toString("utf8");
		if (!Buffer.from(json).equals(bytes.subarray(0, count))) throw new Error();
		return JSON.parse(json) as unknown;
	} catch (error) {
		if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new HarnessError("ATTACHMENT_CORRUPT", "Could not read valid attachment metadata.");
	} finally { await handle?.close(); }
}

async function lockOwner(path: string): Promise<number | undefined> {
	try {
		const value: unknown = JSON.parse(await readFile(path, "utf8"));
		if (isRecord(value) && Number.isSafeInteger(value.pid) && Number(value.pid) > 0) return Number(value.pid);
	} catch { /* Incomplete locks are never assumed stale. */ }
	return undefined;
}

function processAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function decodeSessionMove(value: unknown): ProjectSessionMove {
	if (!isRecord(value) || typeof value.id !== "string" || !attachmentIdPattern.test(value.id)
		|| typeof value.projectId !== "string" || !projectIdPattern.test(value.projectId)
		|| typeof value.changeId !== "string" || !attachmentIdPattern.test(value.changeId)
		|| typeof value.storageWorkspace !== "string" || !isAbsolute(value.storageWorkspace)
		|| typeof value.fromWorkspace !== "string" || !isAbsolute(value.fromWorkspace)
		|| typeof value.toWorkspace !== "string" || !isAbsolute(value.toWorkspace)
		|| !Number.isSafeInteger(value.expectedRevision) || Number(value.expectedRevision) < 1
		|| !Number.isSafeInteger(value.locationRevision) || Number(value.locationRevision) < 0
		|| typeof value.changedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value.changedAt) || !Number.isFinite(Date.parse(value.changedAt))) {
		throw new HarnessError("ATTACHMENT_CORRUPT", "Invalid project session change.");
	}
	return { id: value.id, projectId: value.projectId, changeId: value.changeId, storageWorkspace: value.storageWorkspace,
		fromWorkspace: value.fromWorkspace, toWorkspace: value.toWorkspace, changedAt: value.changedAt,
		expectedRevision: Number(value.expectedRevision), locationRevision: Number(value.locationRevision) };
}

async function removeFile(path: string): Promise<void> {
	await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
}
