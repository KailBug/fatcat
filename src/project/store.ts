import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, readdir, realpath, rename, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { HarnessError } from "../errors.js";
import { decodeProjectRecord, invalidProject, projectIdPattern, projectName } from "./record.js";
import type { ProjectRecord } from "./record.js";

const maxProjectBytes = 64 * 1024;

/** Project metadata is independent of session histories and workspace directories. */
export class ProjectStore {
	readonly root: string;

	constructor(options: { root: string }) {
		this.root = join(resolve(options.root), "projects");
	}

	async create(name: string, workspace: string): Promise<ProjectRecord> {
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
			await this.publish(record);
			return structuredClone(record);
		} finally { await release(); }
	}

	async list(): Promise<ProjectRecord[]> {
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
			try { projects.push(await this.load(file.slice(0, -5))); }
			catch (error) {
				if (!(error instanceof HarnessError && ["PROJECT_CORRUPT", "PROJECT_NOT_FOUND"].includes(error.code))) throw error;
			}
		}
		return projects.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
	}

	async load(id: string): Promise<ProjectRecord> {
		if (!projectIdPattern.test(id)) throw new HarnessError("PROJECT_NOT_FOUND", "No matching project exists. Use /projects.");
		let handle;
		try {
			handle = await open(join(this.root, `${id}.json`), "r");
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

	/** Callers acquire this metadata lock before a session bucket lock. */
	async withProject<T>(id: string, expectedRevision: number | undefined, operation: (project: ProjectRecord) => Promise<T>): Promise<T> {
		await mkdir(this.root, { recursive: true, mode: 0o700 });
		const release = await this.lock();
		try {
			const project = await this.load(id);
			if (expectedRevision !== undefined && project.revision !== expectedRevision) {
				throw new HarnessError("PROJECT_CONFLICT", "The project changed. Refresh it before continuing.");
			}
			return await operation(project);
		} finally { await release(); }
	}

	private async publish(record: ProjectRecord): Promise<void> {
		const json = JSON.stringify(record);
		if (Buffer.byteLength(json) > maxProjectBytes) throw new HarnessError("PROJECT_LIMIT", "Project metadata exceeds the storage limit.");
		const temporary = join(this.root, `${record.id}.${randomUUID()}.tmp`);
		try {
			const handle = await open(temporary, "wx", 0o600);
			try { await handle.writeFile(json, "utf8"); await handle.sync(); } finally { await handle.close(); }
			await rename(temporary, join(this.root, `${record.id}.json`));
		} catch { throw new HarnessError("PROJECT_STORAGE", "Could not save project data. Check the project directory and available disk space."); }
		finally { await unlink(temporary).catch(() => {}); }
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
				const owner = await this.lockOwner(path);
				if (owner !== undefined && !processAlive(owner)) {
					await this.recoverLock(path);
					continue;
				}
				throw new HarnessError("PROJECT_BUSY", "The project store is busy or its lock is incomplete. Try again shortly.");
			}
		}
		throw new HarnessError("PROJECT_BUSY", "The project store could not be locked. Try again shortly.");
	}

	private async lockOwner(path: string): Promise<number | undefined> {
		try {
			const owner: unknown = JSON.parse(await readFile(path, "utf8"));
			if (typeof owner === "object" && owner !== null && "pid" in owner
				&& Number.isSafeInteger(owner.pid) && Number(owner.pid) > 0) return Number(owner.pid);
		} catch { /* Incomplete locks are never assumed stale. */ }
		return undefined;
	}

	private async recoverLock(path: string): Promise<void> {
		let gate;
		try { gate = await open(`${path}.recovery`, "wx", 0o600); }
		catch { throw new HarnessError("PROJECT_BUSY", "Project lock recovery is busy. Confirm no store operation is running before repairing its lock."); }
		try {
			const owner = await this.lockOwner(path);
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
