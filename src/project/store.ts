import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, realpath, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { HarnessError } from "../errors.js";
import { AttachmentTransactions } from "../attachments/transaction.js";
import { projectIdPattern, projectName } from "./record.js";
import type { ProjectRecord } from "./record.js";
import { publishProjectRecord, readProjectLockOwner, readProjectRecord } from "./files.js";

/** Project metadata is independent of session histories and workspace directories. */
export class ProjectStore {
	readonly root: string;
	private readonly transactions: AttachmentTransactions;

	constructor(options: { root: string }) {
		this.root = join(resolve(options.root), "projects");
		this.transactions = new AttachmentTransactions(resolve(options.root));
	}

	async create(name: string, workspace: string): Promise<ProjectRecord> {
		return this.transactions.withLock(() => this.createUnlocked(name, workspace));
	}

	private async createUnlocked(name: string, workspace: string): Promise<ProjectRecord> {
		const normalizedName = projectName(name);
		let canonical: string;
		try {
			canonical = await realpath(workspace);
			if (!(await stat(canonical)).isDirectory()) throw new Error();
		} catch { throw new HarnessError("PROJECT_WORKSPACE", "The project workspace must be an accessible directory."); }
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		const release = await this.lock();
		try {
			const now = new Date().toISOString();
			const record: ProjectRecord = { version: 1, id: randomUUID(), name: normalizedName,
				workspace: canonical, createdAt: now, updatedAt: now, revision: 1 };
			await publishProjectRecord(this.root, record);
			return structuredClone(record);
		} finally { await release(); }
	}

	async list(): Promise<ProjectRecord[]> {
		return this.transactions.withLock(() => this.listUnlocked(), false);
	}

	private async listUnlocked(): Promise<ProjectRecord[]> {
		let files: string[];
		try { files = await readdir(this.root); }
		catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw new HarnessError("PROJECT_STORAGE", "Could not list the local project directory.");
		}
		if (files.length > 10000) throw new HarnessError("PROJECT_LIMIT", "Too many entries in the project directory.");
		const projects: ProjectRecord[] = [];
		for (const file of files) {
			if (!file.endsWith(".json") || !projectIdPattern.test(file.slice(0, -5))) continue;
			try { projects.push(await this.loadUnlocked(file.slice(0, -5))); }
			catch (error) {
				if (!(error instanceof HarnessError && ["PROJECT_CORRUPT", "PROJECT_NOT_FOUND"].includes(error.code))) throw error;
			}
		}
		return projects.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
	}

	async load(id: string): Promise<ProjectRecord> {
		return this.transactions.withLock(() => this.loadUnlocked(id), false);
	}

	/** Used only by an operation already holding the shared metadata gate. */
	async loadUnlocked(id: string): Promise<ProjectRecord> {
		return readProjectRecord(this.root, id);
	}

	/** Callers acquire this metadata lock before a session bucket lock. */
	async withProject<T>(id: string, expectedRevision: number | undefined, operation: (project: ProjectRecord) => Promise<T>): Promise<T> {
		return this.transactions.withLock(() => this.withProjectUnlocked(id, expectedRevision, operation));
	}

	/** Metadata gate must be held before this project lock and any session bucket lock. */
	async withProjectUnlocked<T>(id: string, expectedRevision: number | undefined, operation: (project: ProjectRecord) => Promise<T>): Promise<T> {
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		const release = await this.lock();
		try {
			const project = await this.loadUnlocked(id);
			if (expectedRevision !== undefined && project.revision !== expectedRevision) {
				throw new HarnessError("PROJECT_CONFLICT", "The project changed. Refresh it before continuing.");
			}
			return await operation(project);
		} finally { await release(); }
	}

	private async lock(): Promise<() => Promise<void>> {
		const path = join(this.root, "store.lock");
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const handle = await open(path, "wx", 0o600);
				try { await handle.writeFile(JSON.stringify({ pid: process.pid })); }
				catch (error) { await handle.close(); await unlink(path).catch(() => {}); throw error; }
				return async () => { await handle.close().catch(() => {}); await unlink(path).catch(() => {}); };
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
					throw new HarnessError("PROJECT_STORAGE", "Could not lock the local project directory.");
				}
				const owner = await readProjectLockOwner(path);
				if (owner !== undefined && !processAlive(owner)) {
					await this.recoverLock(path);
					continue;
				}
				throw new HarnessError("PROJECT_BUSY", "The project store is busy or its lock is incomplete. Try again shortly.");
			}
		}
		throw new HarnessError("PROJECT_BUSY", "The project store could not be locked. Try again shortly.");
	}

	private async recoverLock(path: string): Promise<void> {
		let gate;
		try { gate = await open(`${path}.recovery`, "wx", 0o600); }
		catch { throw new HarnessError("PROJECT_BUSY", "Project lock recovery is busy. Confirm no store operation is running before repairing its lock."); }
		try {
			const owner = await readProjectLockOwner(path);
			if (owner === undefined || processAlive(owner)) {
				throw new HarnessError("PROJECT_BUSY", "The project store is busy or its lock is incomplete. Try again shortly.");
			}
			await unlink(path);
		} finally { await gate.close().catch(() => {}); await unlink(`${path}.recovery`).catch(() => {}); }
	}
}

function processAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
