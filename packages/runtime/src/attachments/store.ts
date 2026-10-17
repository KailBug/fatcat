import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { HarnessError, checkCancellation } from "../errors.js";
import { projectIdOf } from "../session/record.js";
import type { SessionRecord } from "../session/record.js";
import type { ProjectRecord } from "../project/record.js";
import type { ProjectSessionMove } from "../project/management.js";
import { MemoryStore } from "../memory/store.js";
import { MetadataTransactions } from "../metadata/transaction.js";
import { atomicJson, boundedJson } from "../metadata/files.js";
import type { MetadataSessionAccess } from "../metadata/transaction.js";
import type { MetadataCommit } from "../metadata/journal.js";
import { diskDocumentCache } from "../documents/cache.js";
import type { DocumentCache } from "../documents/cache.js";
import { attachmentIdPattern, attachmentMediaType, attachmentName, decodeStagedAttachment, extractAttachmentReferences,
	parseAttachmentReference, sameAttachmentTarget, scopeKey, scopeOfTarget, validateAttachmentTarget } from "./record.js";
import type { AttachmentBinding, AttachmentCatalog, AttachmentInfo, AttachmentRecord, AttachmentRef,
	AttachmentScope, AttachmentSharingState, AttachmentTarget, AttachmentUploadMetadata, StagedAttachment } from "./record.js";
import { attachmentBlobPath, readAttachmentBytes, readStagingOwner, stagedAttachmentPart, stagedAttachmentPath, writeAttachmentPart } from "./files.js";
import { publishAttachmentCatalog, readAttachmentCatalog } from "./catalog.js";

export interface AttachmentSessionAccess extends MetadataSessionAccess {
	load(id: string): Promise<SessionRecord>;
	prepareDraft(record: SessionRecord): Promise<SessionRecord>;
}

export class AttachmentStore {
	readonly root: string;
	private readonly transactions: MetadataTransactions;
	private readonly directory: string;

	constructor(options: { root: string; sessions: AttachmentSessionAccess }) {
		this.root = options.root;
		this.directory = join(options.root, "attachments");
		this.sessions = options.sessions;
		this.transactions = new MetadataTransactions(options.root, options.sessions);
	}

	private readonly sessions: AttachmentSessionAccess;

	/** SessionStore uses the same gate; callbacks inside it must use its unlocked helpers. */
	withMetadata<T>(operation: () => Promise<T>, create = true): Promise<T> {
		return this.transactions.withLock(operation, create);
	}

	/** The caller must hold the shared metadata gate. */
	async isSessionDeletedUnlocked(id: string): Promise<boolean> {
		return (await readAttachmentCatalog(this.directory)).deletedSessions.includes(id);
	}

	async stageUpload(target: AttachmentTarget, metadata: AttachmentUploadMetadata,
		body: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<StagedAttachment> {
		const captured = validateAttachmentTarget(target);
		const name = attachmentName(metadata.name);
		const mediaType = attachmentMediaType(name);
		if (!attachmentIdPattern.test(metadata.uploadId)) throw new HarnessError("ATTACHMENT_UPLOAD", "Invalid upload identity.");
		checkCancellation(signal);
		const directory = join(this.directory, "staging");
		await mkdir(directory, { recursive: true, mode: 0o700 });
		const stageToken = randomUUID();
		await this.withMetadata(async () => {
			const owner = await readStagingOwner(this.directory, metadata.uploadId);
			if (owner) {
				if (processAlive(owner.pid)) throw new HarnessError("ATTACHMENT_UPLOAD_CONFLICT", "This upload is already in progress. Wait for it to complete or cancel it before retrying.");
				await this.discardStaging(metadata.uploadId, owner.stageToken);
			}
			await atomicJson(stagedAttachmentPath(this.directory, metadata.uploadId, ".lock"), { pid: process.pid, stageToken }, 4096);
		});
		const path = stagedAttachmentPart(this.directory, metadata.uploadId, stageToken);
		try {
			const { size, sha256 } = await writeAttachmentPart(path, body, signal);
			const staged: StagedAttachment = { uploadId: metadata.uploadId, stageToken, target: captured, id: randomUUID(),
				contentVersion: sha256, sha256, name, mediaType, size, createdAt: new Date().toISOString() };
			await this.withMetadata(async () => {
				if ((await readStagingOwner(this.directory, metadata.uploadId))?.stageToken !== stageToken) {
					throw new HarnessError("ATTACHMENT_UPLOAD_CONFLICT", "The upload was cancelled before publication.");
				}
				await atomicJson(stagedAttachmentPath(this.directory, metadata.uploadId, ".json"), staged, 16384);
			});
			checkCancellation(signal);
			return staged;
		} catch (error) {
			await this.discardUpload(metadata.uploadId, stageToken);
			throw error;
		}
	}

	async completeUpload(uploadId: string, draft?: SessionRecord, stageToken?: string): Promise<{ attachment: AttachmentInfo; session: SessionRecord }> {
		if (draft && draft.revision !== 0) throw new HarnessError("ATTACHMENT_UPLOAD", "Only an unsaved draft can be included with an upload.");
		return this.withMetadata(async () => {
			const catalog = await readAttachmentCatalog(this.directory);
			const stagedValue = await boundedJson(stagedAttachmentPath(this.directory, uploadId, ".json"), 16384, true);
			const staged = stagedValue === undefined ? undefined : decodeStagedAttachment(stagedValue);
			if (staged && (staged.stageToken !== stageToken || (await readStagingOwner(this.directory, uploadId))?.stageToken !== stageToken)) {
				throw new HarnessError("ATTACHMENT_UPLOAD_CONFLICT", "Only the request that staged this upload can publish it.");
			}
			const existing = catalog.assets.find((asset) => asset.uploadId === uploadId);
			if (existing) {
				if (staged && (staged.uploadId !== uploadId || !sameAttachmentTarget(staged.target, existing.target)
					|| staged.name !== existing.name || staged.mediaType !== existing.mediaType || staged.size !== existing.size
					|| staged.sha256 !== existing.sha256)) {
					await this.discardStaging(uploadId, staged.stageToken);
					throw new HarnessError("ATTACHMENT_UPLOAD_CONFLICT", "This upload identity already belongs to different content or another session. Start a new upload.");
				}
				const session = await this.currentSession(existing.target);
				const binding = this.binding(catalog, existing.target, { attachmentId: existing.id, contentVersion: existing.contentVersion }, true);
				if (staged) await this.discardStaging(uploadId, staged.stageToken);
				return { attachment: this.info(catalog, existing, binding), session };
			}
			if (!staged) throw new HarnessError("ATTACHMENT_UPLOAD", "This upload is not staged. Upload the file again.");
			if (staged.uploadId !== uploadId || catalog.deletedSessions.includes(staged.target.sessionId)) {
				await this.discardStaging(uploadId, staged.stageToken);
				throw new HarnessError("ATTACHMENT_TARGET_CHANGED", "The upload target was deleted. Select a new session and upload again.");
			}
			let session: SessionRecord;
			let newSession = false;
			try { session = await this.currentSession(staged.target); }
			catch (error) {
				if (!(error instanceof HarnessError && error.code === "SESSION_NOT_FOUND") || !draft || draft.revision !== 0
					|| !sameAttachmentTarget(staged.target, targetOf(draft))) {
					await this.discardStaging(uploadId, staged.stageToken);
					throw error;
				}
				session = await this.sessions.prepareDraft(draft);
				newSession = true;
			}
			const ref = { attachmentId: staged.id, contentVersion: staged.contentVersion };
			const blob = attachmentBlobPath(this.directory, ref);
			await mkdir(join(this.directory, "blobs", staged.id), { recursive: true, mode: 0o700 });
			try { await stat(blob); }
			catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				await readAttachmentBytes(stagedAttachmentPart(this.directory, uploadId, staged.stageToken), staged);
				await rename(stagedAttachmentPart(this.directory, uploadId, staged.stageToken), blob);
			}
			await readAttachmentBytes(blob, staged);
			const asset: AttachmentRecord = { ...staged, uploaderSessionId: staged.target.sessionId };
			const binding: AttachmentBinding = { ...ref, scope: scopeOfTarget(staged.target) };
			catalog.assets.push(asset);
			catalog.bindings.push(binding);
			this.changed(catalog, binding.scope);
			await this.transactions.commit({ catalog, ...(newSession ? { writes: [session] } : {}) });
			await this.discardStaging(uploadId, staged.stageToken);
			return { attachment: this.info(catalog, asset, binding), session };
		});
	}

	async discardUpload(uploadId: string, stageToken?: string): Promise<void> {
		if (stageToken === undefined) return;
		await this.withMetadata(() => this.discardStaging(uploadId, stageToken));
	}

	async list(target: AttachmentTarget, options: { includeRemoved?: boolean; draft?: SessionRecord } = {}): Promise<AttachmentInfo[]> {
		return this.withMetadata(async () => {
			await this.currentSession(target, options.draft);
			const catalog = await readAttachmentCatalog(this.directory);
			const key = scopeKey(scopeOfTarget(target));
			return catalog.bindings.filter((binding) => scopeKey(binding.scope) === key)
				.map((binding) => this.info(catalog, this.asset(catalog, binding), binding))
				.filter((info) => options.includeRemoved || (!info.removed && !info.deleted))
				.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
		}, false);
	}

	async read(target: AttachmentTarget, ref: AttachmentRef, options: { pin?: boolean; signal?: AbortSignal | undefined; draft?: SessionRecord } = {}): Promise<{ attachment: AttachmentInfo; bytes: Uint8Array }> {
		return this.withMetadata(async () => {
			checkCancellation(options.signal);
			await this.currentSession(target, options.pin ? undefined : options.draft);
			const catalog = await readAttachmentCatalog(this.directory);
			const binding = this.binding(catalog, target, ref);
			const asset = this.asset(catalog, ref);
			const bytes = await readAttachmentBytes(attachmentBlobPath(this.directory, ref), asset);
			checkCancellation(options.signal);
			if (options.pin && !catalog.pins.some((pin) => pin.sessionId === target.sessionId && pin.attachmentId === ref.attachmentId)) {
				catalog.pins.push({ ...ref, sessionId: target.sessionId });
				catalog.revision++;
				await publishAttachmentCatalog(this.directory, catalog);
			}
			checkCancellation(options.signal);
			return { attachment: this.info(catalog, asset, binding), bytes };
		}, false);
	}

	async sharingState(target: AttachmentTarget): Promise<AttachmentSharingState> {
		return this.withMetadata(async () => {
			await this.currentSession(target);
			return this.sharing(await readAttachmentCatalog(this.directory), scopeOfTarget(target));
		}, false);
	}

	/** Derived content never grants access independently of the original. No parsing or network work runs under this gate. */
	async withDocumentCache<T>(target: AttachmentTarget, ref: AttachmentRef, operation: (cache: DocumentCache) => Promise<T>, draft?: SessionRecord): Promise<T> {
		return this.withMetadata(async () => {
			await this.currentSession(target, draft);
			const catalog = await readAttachmentCatalog(this.directory);
			this.binding(catalog, target, ref);
			if (this.asset(catalog, ref).deletedAt) throw new HarnessError("ATTACHMENT_UNAVAILABLE", "This original was permanently deleted.");
			return operation(diskDocumentCache(join(this.directory, "derived", ref.attachmentId, ref.contentVersion)));
		}, false);
	}

	async remove(target: AttachmentTarget, ref: AttachmentRef, expectedScopeRevision?: number): Promise<void> {
		await this.withMetadata(async () => {
			await this.currentSession(target);
			const catalog = await readAttachmentCatalog(this.directory);
			const binding = this.binding(catalog, target, ref, true);
			this.expectedScope(catalog, binding.scope, expectedScopeRevision);
			if (binding.removedAt) return;
			binding.removedAt = new Date().toISOString();
			this.changed(catalog, binding.scope);
			await publishAttachmentCatalog(this.directory, catalog);
		});
	}

	async delete(target: AttachmentTarget, ref: AttachmentRef, expectedScopeRevision?: number): Promise<void> {
		await this.withMetadata(async () => {
			await this.currentSession(target);
			const catalog = await readAttachmentCatalog(this.directory);
			const binding = this.binding(catalog, target, ref, true);
			this.expectedScope(catalog, binding.scope, expectedScopeRevision);
			const asset = this.asset(catalog, ref);
			if (asset.deletedAt) return;
			const associations = catalog.bindings.filter((item) => item.attachmentId === ref.attachmentId && item !== binding && !item.removedAt).length;
			const pins = catalog.pins.filter((pin) => pin.attachmentId === ref.attachmentId).length;
			if (associations || pins) {
				throw new HarnessError("ATTACHMENT_REFERENCED", `Permanent deletion is blocked by ${associations} other active associations and ${pins} retained session references. Remove only this association instead.`);
			}
			const now = new Date().toISOString();
			binding.removedAt = now;
			asset.deletedAt = now;
			this.changed(catalog, binding.scope);
			await this.transactions.commit({ catalog, purge: [ref] });
		});
	}

	/** Called only while SessionStore owns the metadata and session locks. */
	async publishSession(record: SessionRecord, previous?: SessionRecord, forkSource?: SessionRecord,
		expectedAttachmentRevision?: number, expectedMemoryFingerprint?: string): Promise<void> {
		const catalog = await readAttachmentCatalog(this.directory);
		if (catalog.deletedSessions.includes(record.id)) throw new HarnessError("SESSION_NOT_FOUND", "The session was deleted and cannot be recreated by an old operation.");
		let changed = false;
		let memoryMove: MetadataCommit["memoryMove"];
		if (previous && !projectIdOf(previous) && projectIdOf(record)) {
			memoryMove = { sessionId: record.id, projectId: projectIdOf(record)! };
			await new MemoryStore(this.root).previewSessionMove(memoryMove.sessionId, memoryMove.projectId, expectedMemoryFingerprint);
			const privateScope: AttachmentScope = { kind: "session", sessionId: record.id };
			const sharedScope: AttachmentScope = { kind: "project", projectId: projectIdOf(record)! };
			const owned = catalog.bindings.filter((binding) => scopeKey(binding.scope) === scopeKey(privateScope));
			if ((owned.length || expectedAttachmentRevision !== undefined)
				&& expectedAttachmentRevision !== (catalog.scopeRevisions[scopeKey(privateScope)] ?? 0)) {
				throw new HarnessError("ATTACHMENT_CONFLICT", "The private attachment list changed. Review a new sharing preview before moving this session.");
			}
			for (const binding of owned) {
				const existing = catalog.bindings.find((item) => scopeKey(item.scope) === scopeKey(sharedScope) && item.attachmentId === binding.attachmentId);
				if (!existing) binding.scope = sharedScope;
				else {
					if (!binding.removedAt) delete existing.removedAt;
					catalog.bindings = catalog.bindings.filter((item) => item !== binding);
				}
			}
			if (owned.length) { this.changed(catalog, privateScope); this.changed(catalog, sharedScope); changed = true; }
		}
		if (forkSource) {
			if (!projectIdOf(forkSource)) {
				const source = scopeKey({ kind: "session", sessionId: forkSource.id });
				const copies = catalog.bindings.filter((binding) => scopeKey(binding.scope) === source && !binding.removedAt)
					.map((binding): AttachmentBinding => ({ ...binding, scope: { kind: "session", sessionId: record.id } }));
				if (copies.length) { catalog.bindings.push(...copies); this.changed(catalog, { kind: "session", sessionId: record.id }); changed = true; }
			}
			const pins = catalog.pins.filter((pin) => pin.sessionId === forkSource.id).map((pin) => ({ ...pin, sessionId: record.id }));
			if (pins.length) { catalog.pins.push(...pins); catalog.revision++; changed = true; }
		}
		const currentScope = scopeKey(scopeOfTarget(targetOf(record)));
		for (const ref of extractAttachmentReferences(JSON.stringify([record.history, record.attempt]))) {
			const binding = catalog.bindings.find((item) => scopeKey(item.scope) === currentScope
				&& item.attachmentId === ref.attachmentId && item.contentVersion === ref.contentVersion);
			if (!binding || this.asset(catalog, ref).deletedAt
				|| catalog.pins.some((pin) => pin.sessionId === record.id && pin.attachmentId === ref.attachmentId)) continue;
			catalog.pins.push({ ...ref, sessionId: record.id });
			catalog.revision++;
			changed = true;
		}
		if (changed || memoryMove) await this.transactions.commit({ catalog, writes: [record], ...(memoryMove ? { memoryMove } : {}) });
		else await this.sessions.publish(record);
	}

	/** Deleting a session never deletes a project association or another session's pins. */
	async deleteSession(record: SessionRecord, replacement?: SessionRecord): Promise<void> {
		const catalog = await readAttachmentCatalog(this.directory);
		const scope: AttachmentScope = { kind: "session", sessionId: record.id };
		catalog.bindings = catalog.bindings.filter((binding) => scopeKey(binding.scope) !== scopeKey(scope));
		catalog.pins = catalog.pins.filter((pin) => pin.sessionId !== record.id);
		if (!catalog.deletedSessions.includes(record.id)) catalog.deletedSessions.push(record.id);
		this.changed(catalog, scope);
		await this.transactions.commit({ catalog, ...(replacement ? { writes: [replacement] } : {}),
			deletes: [{ id: record.id, storageWorkspace: record.storageWorkspace ?? record.workspace }] });
	}

	/** Project management calls these methods while holding the shared metadata gate. */
	async projectImpact(projectId: string, sessionIds: string[]): Promise<{ attachmentCount: number; retainedAttachmentCount: number; attachmentFingerprint: string }> {
		const selection = this.projectAssets(await readAttachmentCatalog(this.directory), projectId, new Set(sessionIds));
		return { attachmentCount: selection.assets.length, retainedAttachmentCount: selection.retained.size,
			attachmentFingerprint: selection.fingerprint };
	}

	async publishProject(project: ProjectRecord, sessionMoves: ProjectSessionMove[] = []): Promise<void> {
		await this.transactions.commit({ catalog: await readAttachmentCatalog(this.directory), projectWrite: project, sessionMoves });
	}

	async deleteProject(projectId: string, members: Array<{ id: string; storageWorkspace: string }>): Promise<void> {
		const catalog = await readAttachmentCatalog(this.directory);
		const ids = new Set(members.map((member) => member.id));
		const selection = this.projectAssets(catalog, projectId, ids);
		catalog.bindings = catalog.bindings.filter((binding) => !this.projectBinding(binding, projectId, ids));
		catalog.pins = catalog.pins.filter((pin) => !ids.has(pin.sessionId));
		const deleted = new Set(catalog.deletedSessions);
		for (const id of ids) { deleted.add(id); this.changed(catalog, { kind: "session", sessionId: id }); }
		catalog.deletedSessions = [...deleted];
		this.changed(catalog, { kind: "project", projectId });
		const now = new Date().toISOString();
		const purge: AttachmentRef[] = [];
		for (const asset of selection.assets) {
			if (selection.retained.has(asset.id)) continue;
			asset.deletedAt = now;
			purge.push({ attachmentId: asset.id, contentVersion: asset.contentVersion });
		}
		await this.transactions.commit({ catalog, deletes: members, projectDelete: projectId, purge });
	}

	private projectBinding(binding: AttachmentBinding, projectId: string, members: Set<string>): boolean {
		return binding.scope.kind === "project" ? binding.scope.projectId === projectId : members.has(binding.scope.sessionId);
	}

	private projectAssets(catalog: AttachmentCatalog, projectId: string, members: Set<string>) {
		const owned = catalog.bindings.filter((binding) => this.projectBinding(binding, projectId, members));
		const ids = new Set(owned.map((binding) => binding.attachmentId));
		const assets = catalog.assets.filter((asset) => ids.has(asset.id) && !asset.deletedAt);
		const liveIds = new Set(assets.map((asset) => asset.id));
		const bindings = catalog.bindings.filter((binding) => ids.has(binding.attachmentId));
		const pins = catalog.pins.filter((pin) => ids.has(pin.attachmentId));
		const retained = new Set<string>();
		for (const binding of bindings) {
			if (!binding.removedAt && !this.projectBinding(binding, projectId, members)) retained.add(binding.attachmentId);
		}
		for (const pin of pins) if (!members.has(pin.sessionId)) retained.add(pin.attachmentId);
		for (const id of retained) if (!liveIds.has(id)) retained.delete(id);
		const fingerprint = createHash("sha256").update(JSON.stringify({ assets: assets.map((asset) => [asset.id, asset.contentVersion]).sort(),
			bindings: bindings.map((binding) => [scopeKey(binding.scope), binding.attachmentId, binding.contentVersion, binding.removedAt ?? ""]).sort(),
			pins: pins.map((pin) => [pin.sessionId, pin.attachmentId, pin.contentVersion]).sort() })).digest("hex");
		return { assets, retained, fingerprint };
	}

	private async currentSession(target: AttachmentTarget, draft?: SessionRecord): Promise<SessionRecord> {
		const requested = validateAttachmentTarget(target);
		let session: SessionRecord;
		try { session = await this.sessions.load(requested.sessionId); }
		catch (error) {
			if (!(error instanceof HarnessError && error.code === "SESSION_NOT_FOUND") || !draft || draft.revision !== 0
				|| !sameAttachmentTarget(requested, targetOf(draft))) throw error;
			const catalog = await readAttachmentCatalog(this.directory);
			if (catalog.deletedSessions.includes(requested.sessionId)) throw error;
			session = await this.sessions.prepareDraft(draft);
		}
		if (session.projectError) throw new HarnessError("PROJECT_UNAVAILABLE", session.projectError);
		if (!sameAttachmentTarget(requested, targetOf(session))) {
			throw new HarnessError("ATTACHMENT_TARGET_CHANGED", "The session's attachment scope changed. Refresh it before continuing.");
		}
		return session;
	}

	private sharing(catalog: AttachmentCatalog, scope: AttachmentScope): AttachmentSharingState {
		const key = scopeKey(scope);
		const bindings = catalog.bindings.filter((binding) => scopeKey(binding.scope) === key)
			.sort((a, b) => a.attachmentId.localeCompare(b.attachmentId));
		return { revision: catalog.scopeRevisions[key] ?? 0,
			count: bindings.filter((binding) => !binding.removedAt && !this.asset(catalog, binding).deletedAt).length,
			fingerprint: createHash("sha256").update(JSON.stringify(bindings)).digest("hex") };
	}

	private expectedScope(catalog: AttachmentCatalog, scope: AttachmentScope, expected?: number): void {
		if (expected !== undefined && expected !== (catalog.scopeRevisions[scopeKey(scope)] ?? 0)) {
			throw new HarnessError("ATTACHMENT_CONFLICT", "The attachment list changed. Refresh it before continuing.");
		}
	}

	private changed(catalog: AttachmentCatalog, scope: AttachmentScope): void {
		const key = scopeKey(scope);
		catalog.scopeRevisions[key] = (catalog.scopeRevisions[key] ?? 0) + 1;
		catalog.revision++;
	}

	private asset(catalog: AttachmentCatalog, ref: AttachmentRef): AttachmentRecord {
		parseAttachmentReference(`attachment:${ref.attachmentId}@${ref.contentVersion}`);
		const asset = catalog.assets.find((item) => item.id === ref.attachmentId && item.contentVersion === ref.contentVersion);
		if (!asset) throw new HarnessError("ATTACHMENT_ACCESS", "This attachment version is unavailable in the executing session.");
		return asset;
	}

	private binding(catalog: AttachmentCatalog, target: AttachmentTarget, ref: AttachmentRef, includeRemoved = false): AttachmentBinding {
		const asset = this.asset(catalog, ref);
		const key = scopeKey(scopeOfTarget(target));
		const binding = catalog.bindings.find((item) => scopeKey(item.scope) === key && item.attachmentId === ref.attachmentId && item.contentVersion === ref.contentVersion);
		if (!binding || (!includeRemoved && (binding.removedAt || asset.deletedAt))) {
			throw new HarnessError("ATTACHMENT_ACCESS", "This attachment version is unavailable in the executing session.");
		}
		return binding;
	}

	private info(catalog: AttachmentCatalog, asset: AttachmentRecord, binding: AttachmentBinding): AttachmentInfo {
		return { id: asset.id, contentVersion: asset.contentVersion, sha256: asset.sha256, name: asset.name,
			mediaType: asset.mediaType, size: asset.size, createdAt: asset.createdAt, uploaderSessionId: asset.uploaderSessionId,
			scopeRevision: catalog.scopeRevisions[scopeKey(binding.scope)] ?? 0, removed: binding.removedAt !== undefined,
			deleted: asset.deletedAt !== undefined };
	}

	private async discardStaging(id: string, stageToken: string): Promise<void> {
		await unlink(stagedAttachmentPart(this.directory, id, stageToken)).catch(() => {});
		if ((await readStagingOwner(this.directory, id))?.stageToken !== stageToken) return;
		await unlink(stagedAttachmentPath(this.directory, id, ".json")).catch(() => {});
		await unlink(stagedAttachmentPath(this.directory, id, ".lock")).catch(() => {});
	}
}

function targetOf(record: SessionRecord): AttachmentTarget {
	const projectId = projectIdOf(record);
	return { sessionId: record.id, locationRevision: record.locationRevision ?? 0, ...(projectId ? { projectId } : {}) };
}

function processAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}
