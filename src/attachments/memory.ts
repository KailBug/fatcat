import { createHash, randomUUID } from "node:crypto";
import { HarnessError, checkCancellation } from "../errors.js";
import type { SessionRecord } from "../session/record.js";
import { executionIdentity } from "../session/execution.js";
import { attachmentIdPattern, attachmentName, attachmentMediaType, extractAttachmentReferences, maxAttachmentBytes, sameAttachmentTarget } from "./record.js";
import type { AttachmentInfo, AttachmentRef, AttachmentTarget, AttachmentUploadMetadata, StagedAttachment } from "./record.js";
import { MemoryDocumentCache } from "../documents/cache.js";
import type { DocumentCache } from "../documents/cache.js";

interface MemoryAsset {
	staged: StagedAttachment;
	bytes?: Uint8Array;
	bindings: Map<string, boolean>;
	pins: Set<string>;
	documents?: MemoryDocumentCache;
}

/** Non-persistent sessions keep originals in memory; no temporary history or files reach disk. */
export class MemoryAttachments {
	private readonly assets = new Map<string, MemoryAsset>();
	private readonly stages = new Map<string, { staged: StagedAttachment; bytes: Uint8Array }>();
	private readonly receiving = new Map<string, number>();
	private readonly revisions = new Map<string, number>();
	private readonly deletedSessions = new Set<string>();

	constructor(private readonly sessions: {
		getSession: (id: string) => Promise<SessionRecord | undefined>;
		saveDraft: (record: SessionRecord) => Promise<SessionRecord>;
	}) {}

	async stageUpload(target: AttachmentTarget, metadata: AttachmentUploadMetadata, body: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<StagedAttachment> {
		if (!attachmentIdPattern.test(metadata.uploadId) || this.stages.size + this.receiving.size >= 4
			|| this.receiving.has(metadata.uploadId) || this.stages.has(metadata.uploadId)) {
			throw new HarnessError("ATTACHMENT_LIMIT", "Use a valid upload ID and at most four concurrent uploads.");
		}
		this.receiving.set(metadata.uploadId, 0);
		try {
			await this.validate(target);
			const name = attachmentName(metadata.name);
			const mediaType = attachmentMediaType(name);
			let bytes = new Uint8Array(0);
			let size = 0;
			for await (const chunk of body) {
				checkCancellation(signal);
				if (!(chunk instanceof Uint8Array)) throw new HarnessError("ATTACHMENT_UPLOAD", "Expected attachment bytes.");
				if (chunk.byteLength === 0) continue;
				const nextSize = size + chunk.byteLength;
				if (nextSize > maxAttachmentBytes) throw new HarnessError("ATTACHMENT_LIMIT", "Attachments must not exceed 16 MiB.");
				if (nextSize > bytes.byteLength) {
					const capacity = Math.min(maxAttachmentBytes, Math.max(nextSize, bytes.byteLength * 2, 65536));
					this.checkBudget(metadata.uploadId, capacity);
					const next = new Uint8Array(capacity);
					next.set(bytes.subarray(0, size));
					bytes = next;
					this.receiving.set(metadata.uploadId, capacity);
				}
				bytes.set(chunk, size);
				size = nextSize;
			}
			checkCancellation(signal);
			if (bytes.byteLength !== size) bytes = bytes.slice(0, size);
			const sha256 = createHash("sha256").update(bytes).digest("hex");
			const previous = this.assets.get(metadata.uploadId)?.staged;
			if (previous && (!sameAttachmentTarget(previous.target, target) || previous.name !== name || previous.sha256 !== sha256)) {
				throw new HarnessError("ATTACHMENT_CONFLICT", "This upload ID already describes another file or target.");
			}
			const staged = { ...(previous ?? { uploadId: metadata.uploadId, target: structuredClone(target), id: randomUUID(),
				contentVersion: sha256, sha256, name, mediaType, size, createdAt: new Date().toISOString() }), stageToken: randomUUID() };
			this.stages.set(metadata.uploadId, { staged, bytes });
			return structuredClone(staged);
		} finally {
			this.receiving.delete(metadata.uploadId);
		}
	}

	async completeUpload(uploadId: string, draft?: SessionRecord, stageToken?: string): Promise<{ attachment: AttachmentInfo; session: SessionRecord }> {
		const pending = this.stages.get(uploadId);
		if (!pending) throw new HarnessError("ATTACHMENT_NOT_FOUND", "The upload is no longer available.");
		if (stageToken && stageToken !== pending.staged.stageToken) throw new HarnessError("ATTACHMENT_CONFLICT", "The upload was replaced by another transfer.");
		let session = await this.validate(pending.staged.target, draft);
		let asset = this.assets.get(uploadId);
		if (!asset) {
			if (this.assets.size >= 1000 || [...this.assets.values()].reduce((sum, item) => sum + (item.bytes?.byteLength ?? 0), 0)
				+ pending.bytes.byteLength > 64 * 1024 * 1024) {
				throw new HarnessError("ATTACHMENT_LIMIT", "Temporary attachments are limited to 1000 originals and 64 MiB per process.");
			}
			if (session.revision === 0) session = await this.sessions.saveDraft(session);
			asset = { ...pending, bindings: new Map([[session.id, true]]), pins: new Set() };
			this.assets.set(uploadId, asset);
			this.bump(session.id);
		}
		if (!asset.bytes || !asset.bindings.get(session.id)) throw new HarnessError("ATTACHMENT_CONFLICT", "This upload has already been removed.");
		return { attachment: this.info(asset, session.id), session };
	}

	async discardUpload(uploadId: string, stageToken?: string): Promise<void> {
		if (stageToken && this.stages.get(uploadId)?.staged.stageToken === stageToken) this.stages.delete(uploadId);
	}

	async list(target: AttachmentTarget, options: { includeRemoved?: boolean; draft?: SessionRecord } = {}): Promise<AttachmentInfo[]> {
		await this.validate(target, options.draft);
		return [...this.assets.values()].filter((asset) => asset.bindings.has(target.sessionId)
			&& (options.includeRemoved || asset.bindings.get(target.sessionId) && asset.bytes !== undefined))
			.map((asset) => this.info(asset, target.sessionId));
	}

	async read(target: AttachmentTarget, ref: AttachmentRef, options: { pin?: boolean; signal?: AbortSignal; draft?: SessionRecord } = {}) {
		checkCancellation(options.signal);
		await this.validate(target);
		const asset = this.find(target, ref);
		if (!asset.bindings.get(target.sessionId) || !asset.bytes) {
			throw new HarnessError("ATTACHMENT_UNAVAILABLE", "This original is removed or deleted and cannot be read in this session.");
		}
		if (options.pin) asset.pins.add(target.sessionId);
		return { attachment: this.info(asset, target.sessionId), bytes: Uint8Array.from(asset.bytes) };
	}

	async remove(target: AttachmentTarget, ref: AttachmentRef, expectedRevision?: number): Promise<void> {
		await this.validate(target);
		this.checkRevision(target, expectedRevision);
		const asset = this.find(target, ref);
		if (asset.bindings.get(target.sessionId)) {
			asset.bindings.set(target.sessionId, false);
			this.bump(target.sessionId);
		}
	}

	async withDocumentCache<T>(target: AttachmentTarget, ref: AttachmentRef, operation: (cache: DocumentCache) => Promise<T>): Promise<T> {
		await this.validate(target);
		const asset = this.find(target, ref);
		if (!asset.bindings.get(target.sessionId) || !asset.bytes) throw new HarnessError("ATTACHMENT_UNAVAILABLE", "This original is no longer available in this session.");
		asset.documents ??= new MemoryDocumentCache();
		const cache = asset.documents;
		return operation({ load: (version) => cache.load(version), transcripts: () => cache.transcripts(), save: async (snapshot, page) => {
			const size = [...this.assets.values()].reduce((sum, value) => sum + (value.documents?.size ?? 0), 0);
			if (!(await cache.load(snapshot.parserVersion)) && size + Buffer.byteLength(JSON.stringify(snapshot)) > 64 * 1024 * 1024) throw new HarnessError("DOCUMENT_LIMIT", "In-memory derived content exceeds 64 MiB.");
			return cache.save(snapshot, page);
		} });
	}

	async delete(target: AttachmentTarget, ref: AttachmentRef, expectedRevision?: number): Promise<void> {
		await this.validate(target);
		this.checkRevision(target, expectedRevision);
		const asset = this.find(target, ref);
		if ([...asset.bindings].some(([id, active]) => id !== target.sessionId && active) || asset.pins.size) {
			throw new HarnessError("ATTACHMENT_REFERENCED", "Other active associations or retained session history still reference this original. Remove the current association instead.");
		}
		delete asset.bytes;
		delete asset.documents;
		asset.bindings.set(target.sessionId, false);
		this.bump(target.sessionId);
	}

	forkSession(source: string, target: string): void {
		for (const asset of this.assets.values()) {
			if (asset.bindings.get(source)) asset.bindings.set(target, true);
			if (asset.pins.has(source)) asset.pins.add(target);
		}
		this.bump(target);
	}

	retainReferences(record: SessionRecord): void {
		const references = extractAttachmentReferences(JSON.stringify([record.history, record.attempt]));
		for (const ref of references) {
			for (const asset of this.assets.values()) {
				if (asset.staged.id === ref.attachmentId && asset.staged.contentVersion === ref.contentVersion
					&& asset.bytes && asset.bindings.has(record.id)) asset.pins.add(record.id);
			}
		}
	}

	deleteSession(id: string): void {
		this.deletedSessions.add(id);
		for (const [key, asset] of this.assets) {
			asset.bindings.delete(id);
			asset.pins.delete(id);
			if (!asset.bindings.size && !asset.pins.size) this.assets.delete(key);
		}
	}

	private async validate(target: AttachmentTarget, draft?: SessionRecord): Promise<SessionRecord> {
		const record = await this.sessions.getSession(target.sessionId) ?? draft;
		if (!record || this.deletedSessions.has(target.sessionId) || record.projectError || target.projectId
			|| !sameAttachmentTarget(executionIdentity(record), target)) {
			throw new HarnessError("ATTACHMENT_SCOPE", "The attachment target is no longer available in its original scope.");
		}
		return record;
	}

	private find(target: AttachmentTarget, ref: AttachmentRef): MemoryAsset {
		const asset = [...this.assets.values()].find((item) => item.staged.id === ref.attachmentId && item.staged.contentVersion === ref.contentVersion);
		if (!asset || !asset.bindings.has(target.sessionId)) throw new HarnessError("ATTACHMENT_SCOPE", "This attachment is not available in this session.");
		return asset;
	}

	private info(asset: MemoryAsset, sessionId: string): AttachmentInfo {
		const { id, contentVersion, sha256, name, mediaType, size, createdAt, target } = asset.staged;
		return { id, contentVersion, sha256, name, mediaType, size, createdAt, uploaderSessionId: target.sessionId,
			scopeRevision: this.revisions.get(sessionId) ?? 0, removed: !asset.bindings.get(sessionId), deleted: !asset.bytes };
	}

	private bump(id: string): void { this.revisions.set(id, (this.revisions.get(id) ?? 0) + 1); }
	private checkBudget(uploadId: string, capacity: number): void {
		const buffered = [...this.receiving].reduce((sum, [id, value]) => sum + (id === uploadId ? capacity : value), 0)
			+ [...this.stages.values()].reduce((sum, value) => sum + value.bytes.byteLength, 0)
			+ [...this.assets.values()].reduce((sum, value) => sum + (value.bytes?.byteLength ?? 0), 0);
		if (buffered > 64 * 1024 * 1024) throw new HarnessError("ATTACHMENT_LIMIT", "Temporary attachment bytes, including pending uploads, must fit within 64 MiB.");
	}
	private checkRevision(target: AttachmentTarget, revision?: number): void {
		if (revision !== undefined && revision !== (this.revisions.get(target.sessionId) ?? 0)) {
			throw new HarnessError("ATTACHMENT_CONFLICT", "The attachment list changed. Review the operation again.");
		}
	}
}
