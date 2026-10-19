import { mkdir, open, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { HarnessError } from "../errors.js";
import { decodeSessionRecord, encodeSessionRecord, projectIdOf, workspaceKey } from "../session/record.js";
import type { SessionRecord } from "../session/record.js";
import { movedProjectSession } from "../project/management.js";
import type { ProjectSessionMove } from "../project/management.js";
import { MemoryStore } from "../memory/store.js";
import { maxCatalogBytes, publishAttachmentCatalog } from "../attachments/catalog.js";
import { purgeAttachmentFiles } from "../attachments/files.js";
import { decodeMetadataCommit, encodeMetadataCommit } from "./journal.js";
import type { MetadataCommit } from "./journal.js";
import { atomicJson, boundedJson } from "./files.js";

export interface MetadataSessionAccess {
	publish(record: SessionRecord): Promise<void>;
	remove(id: string, storageWorkspace: string): Promise<void>;
}

const maxJournalBytes = 96 * 1024 * 1024;
const metadataQueues = new Map<string, Promise<void>>();

/** One short metadata gate covers Session identity, Project metadata, attachment and memory associations, and recovery. */
export class MetadataTransactions {
	private readonly attachmentDirectory: string;
	private readonly journal: string;

	constructor(private readonly root: string, private readonly sessions?: MetadataSessionAccess) {
		this.attachmentDirectory = join(root, "attachments");
		// Keep the existing journal location and disk protocol when moving its code.
		this.journal = join(this.attachmentDirectory, "pending.json");
	}

	async withLock<T>(operation: () => Promise<T>, create = true, preview = false): Promise<T> {
		const key = process.platform === "win32" ? this.root.toLowerCase() : this.root;
		const previous = metadataQueues.get(key) ?? Promise.resolve();
		let releaseQueue!: () => void;
		const current = new Promise<void>((resolve) => { releaseQueue = resolve; });
		metadataQueues.set(key, current);
		await previous;
		try { return await this.withProcessLock(operation, create, preview); }
		finally {
			releaseQueue();
			if (metadataQueues.get(key) === current) metadataQueues.delete(key);
		}
	}

	private async withProcessLock<T>(operation: () => Promise<T>, create: boolean, preview: boolean): Promise<T> {
		if (!create || preview) {
			try { await stat(this.root); }
			catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return operation(); throw error; }
		}
		try { if (!preview) await mkdir(this.root, { recursive: true, mode: 0o700 }); }
		catch { throw new HarnessError("SESSION_STORAGE", "Could not open the local session metadata directory."); }
		const release = await this.lock(preview);
		try {
			if (preview) {
				if (await boundedJson(this.journal, maxJournalBytes, true) !== undefined) {
					throw new HarnessError("CONTEXT_PREVIEW", "Metadata recovery is pending; preview cannot apply it.");
				}
			} else await this.recover();
			return await operation();
		} finally { await release(); }
	}

	/** The journal is the durable decision. Readers recover it before observing either owner. */
	async commit(change: MetadataCommit): Promise<void> {
		const journal = encodeMetadataCommit(change);
		const validated = decodeMetadataCommit(journal);
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

	private async recover(): Promise<void> {
		const raw = await boundedJson(this.journal, maxJournalBytes, true);
		if (raw === undefined) return;
		try {
			await this.apply(decodeMetadataCommit(raw));
			await unlink(this.journal);
		} catch { throw new HarnessError("ATTACHMENT_RECOVERY_PENDING", "Local metadata recovery could not finish. Restore storage access before continuing."); }
	}

	private async apply(change: MetadataCommit): Promise<void> {
		if (change.memoryMove) {
			await new MemoryStore(this.root).moveSessionToProject(change.memoryMove.sessionId, change.memoryMove.projectId);
		}
		for (const record of change.writes ?? []) await this.publishSession(record);
		if (change.projectWrite) await atomicJson(join(this.root, "projects", `${change.projectWrite.id}.json`), change.projectWrite, 64 * 1024);
		for (const move of change.sessionMoves ?? []) await this.moveSession(move);
		await publishAttachmentCatalog(this.attachmentDirectory, change.catalog);
		for (const record of change.deletes ?? []) {
			if (this.sessions) await this.sessions.remove(record.id, record.storageWorkspace);
			else await removeFile(join(this.root, workspaceKey(record.storageWorkspace), `${record.id}.json`));
		}
		if (change.projectDelete) await removeFile(join(this.root, "projects", `${change.projectDelete}.json`));
		for (const ref of change.purge ?? []) {
			await purgeAttachmentFiles(this.attachmentDirectory, ref);
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

	private async lock(preview = false): Promise<() => Promise<void>> {
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
				if (!preview && pid !== undefined && !processAlive(pid)) {
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

async function removeFile(path: string): Promise<void> {
	await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
}
