import { randomUUID } from "node:crypto";
import { HarnessError } from "@fatcat/runtime/errors";
import type { AttachmentInfo } from "@fatcat/runtime/attachments/record";
import type { SessionManager } from "@fatcat/runtime/session/manager";

export const maxUploadBytes = 16 * 1024 * 1024;
export const uploadTimeoutMs = 120_000;
export const maxUploads = 4;

type UploadTarget = Awaited<ReturnType<SessionManager["beginAttachmentUpload"]>>;
interface PendingUpload {
	target: UploadTarget;
	abort: AbortController;
	timer: ReturnType<typeof setTimeout>;
	receiving: boolean;
}

export interface UploadTicket {
	token: string;
	sessionId: string;
	name: string;
	size: number;
	expiresAt: string;
}

/** Stream reception owns no selected-session state or controller busy lock. */
export class WebAttachments {
	private readonly uploads = new Map<string, PendingUpload>();
	private preparing = 0;
	private prepared: Promise<void> = Promise.resolve();
	private closed = false;

	constructor(private readonly manager: SessionManager, private readonly changed: () => Promise<void>) {}

	async begin(sessionId: string, name: string, size: number, uploadId: string | undefined,
		expected: { locationRevision: number; projectId: string | null }): Promise<UploadTicket> {
		if (this.closed) throw new HarnessError("CLOSED", "The local server is shutting down.");
		if (!Number.isSafeInteger(size) || size < 0 || size > maxUploadBytes) {
			throw new HarnessError("ATTACHMENT_LIMIT", "Choose a file of at most 16 MiB.");
		}
		if (this.uploads.size + this.preparing >= maxUploads) {
			throw new HarnessError("ATTACHMENT_BUSY", "Wait for an upload to finish or cancel it. At most four uploads can run together.");
		}
		this.preparing++;
		const previous = this.prepared;
		let release!: () => void;
		this.prepared = new Promise((resolve) => { release = resolve; });
		try {
			await previous;
			if (this.closed) throw new HarnessError("CLOSED", "The local server is shutting down.");
			if (uploadId && [...this.uploads.values()].some((pending) => pending.target.uploadId === uploadId)) {
				throw new HarnessError("ATTACHMENT_BUSY", "This file is still uploading or cancelling. Wait before retrying.");
			}
			const target = await this.manager.beginAttachmentUpload(sessionId, name, size, uploadId);
			if (target.locationRevision !== expected.locationRevision || (target.projectId ?? null) !== expected.projectId) {
				throw new HarnessError("ATTACHMENT_CONFLICT", "The upload destination changed. Select the file again in the intended chat or project.");
			}
			if (this.closed) throw new HarnessError("CLOSED", "The local server is shutting down.");
			const token = randomUUID();
			const abort = new AbortController();
			const timer = setTimeout(() => this.cancel(token), uploadTimeoutMs);
			timer.unref();
			this.uploads.set(token, { target, abort, timer, receiving: false });
			return { token, sessionId: target.sessionId, name: target.name, size: target.size,
				expiresAt: new Date(Date.now() + uploadTimeoutMs).toISOString() };
		} finally { this.preparing--; release(); }
	}

	async receive(token: string, source: AsyncIterable<Uint8Array>, signal: AbortSignal): Promise<AttachmentInfo> {
		const pending = this.uploads.get(token);
		if (!pending || pending.abort.signal.aborted) throw new HarnessError("ATTACHMENT_UPLOAD", "The upload expired or was cancelled. Select the file again.");
		if (pending.receiving) throw new HarnessError("ATTACHMENT_BUSY", "This upload is already receiving a file.");
		pending.receiving = true;
		try {
			const result = await this.manager.uploadAttachment(pending.target, source, AbortSignal.any([signal, pending.abort.signal]));
			await this.changed();
			return result;
		} finally {
			clearTimeout(pending.timer);
			this.uploads.delete(token);
		}
	}

	uploadSignal(token: string): AbortSignal {
		const pending = this.uploads.get(token);
		if (!pending) throw new HarnessError("ATTACHMENT_UPLOAD", "The upload expired or was cancelled. Select the file again.");
		return pending.abort.signal;
	}

	cancel(token: string): void {
		const pending = this.uploads.get(token);
		if (!pending) return;
		pending.abort.abort();
		clearTimeout(pending.timer);
		if (!pending.receiving) this.uploads.delete(token);
	}

	list(sessionId: string, includeRemoved = false): Promise<AttachmentInfo[]> {
		return this.manager.listAttachments(sessionId, includeRemoved);
	}

	read(reference: string, options: Parameters<SessionManager["readAttachment"]>[1]) {
		return this.manager.readAttachment(reference, options);
	}

	download(sessionId: string, reference: string, signal: AbortSignal) {
		return this.manager.downloadAttachment(sessionId, reference, signal);
	}

	async remove(sessionId: string, reference: string, expected: { locationRevision: number; scopeRevision: number }): Promise<void> {
		await this.manager.removeAttachment(sessionId, reference, expected);
		await this.changed();
	}

	async delete(sessionId: string, reference: string, expected: { locationRevision: number; scopeRevision: number }): Promise<void> {
		await this.manager.deleteAttachment(sessionId, reference, expected);
		await this.changed();
	}

	close(): void {
		this.closed = true;
		for (const token of this.uploads.keys()) this.cancel(token);
	}
}
