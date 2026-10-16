import type { MemoryAttachments } from "../attachments/memory.js";
import type { AttachmentReadResult } from "../attachments/read.js";
import { parseAttachmentReference } from "../attachments/record.js";
import type { AttachmentInfo, AttachmentTarget, StagedAttachment } from "../attachments/record.js";
import type { AttachmentStore } from "../attachments/store.js";
import type { AttachmentAccess } from "../attachments/tools.js";
import type { DocumentCache } from "../documents/cache.js";
import { readDocumentContent } from "../documents/read.js";
import { HarnessError, checkCancellation } from "../errors.js";
import { executionIdentity } from "./execution.js";
import type { SessionExecutionIdentity } from "./execution.js";
import { projectIdOf } from "./record.js";
import type { SessionRecord } from "./record.js";

type AttachmentRepository = AttachmentStore | MemoryAttachments;

export interface AttachmentUploadTarget extends AttachmentTarget {
	name: string;
	size: number;
	uploadId: string;
	draft?: SessionRecord;
}

/** Streaming and cleanup stay outside the manager's serialized publication callback. */
export async function uploadAttachment(repository: AttachmentRepository, target: AttachmentUploadTarget,
	body: AsyncIterable<Uint8Array>, publish: (staged: StagedAttachment) => Promise<AttachmentInfo>,
	signal?: AbortSignal): Promise<AttachmentInfo> {
	let staged: StagedAttachment | undefined;
	try {
		staged = await repository.stageUpload(target, { uploadId: target.uploadId, name: target.name }, body, signal);
		checkCancellation(signal);
		if (staged.size !== target.size) throw new HarnessError("ATTACHMENT_SIZE", "The upload size did not match the selected file.");
		return await publish(staged);
	} finally {
		if (staged) await repository.discardUpload(target.uploadId, staged.stageToken);
	}
}

export async function listAttachments(repository: AttachmentRepository, record: SessionRecord, includeRemoved = false): Promise<AttachmentInfo[]> {
	if (record.projectError) throw new HarnessError("PROJECT_UNAVAILABLE", record.projectError);
	if (record.revision === 0 && !projectIdOf(record)) return [];
	return repository.list(executionIdentity(record), { includeRemoved, ...(record.revision === 0 ? { draft: record } : {}) });
}

/** Every cache operation rechecks access; parsing and vision run outside the metadata gate. */
export async function readAttachment(repository: AttachmentRepository, identity: SessionExecutionIdentity, reference: string,
	options: Parameters<AttachmentAccess["read"]>[1], pin: boolean, draft?: SessionRecord): Promise<AttachmentReadResult> {
	const ref = parseAttachmentReference(reference);
	const source = await repository.read(identity, ref, { pin, ...(options.signal ? { signal: options.signal } : {}), ...(draft ? { draft } : {}) });
	const access = <T>(operation: (cache: DocumentCache) => Promise<T>) => {
		checkCancellation(options.signal);
		return repository.withDocumentCache(identity, ref, operation, draft);
	};
	const cache: DocumentCache = { load: (version) => access((value) => value.load(version)),
		transcripts: () => access((value) => value.transcripts()), save: (snapshot, page) => access((value) => value.save(snapshot, page)) };
	return readDocumentContent(source.attachment, source.bytes, options, cache, options.signal, options.vision, options.turn);
}

/** Capture the execution identity, without consulting the host's later session selection. */
export function sessionAttachmentAccess(repository: AttachmentRepository, identity: SessionExecutionIdentity): AttachmentAccess {
	return {
		list: async (signal) => {
			checkCancellation(signal);
			return repository.list(identity);
		},
		read: async (reference, options) => readAttachment(repository, identity, reference, options, true),
	};
}

export async function downloadAttachment(repository: AttachmentRepository, record: SessionRecord, reference: string,
	signal?: AbortSignal): Promise<{ record: AttachmentInfo; bytes: Uint8Array }> {
	const source = await repository.read(executionIdentity(record), parseAttachmentReference(reference), {
		...(signal ? { signal } : {}), ...(record.revision === 0 ? { draft: record } : {}) });
	return { record: source.attachment, bytes: source.bytes };
}

export async function changeAttachment(repository: AttachmentRepository, record: SessionRecord, reference: string,
	action: "remove" | "delete", expected?: { locationRevision: number; scopeRevision: number }): Promise<void> {
	if (expected && expected.locationRevision !== (record.locationRevision ?? 0)) {
		throw new HarnessError("ATTACHMENT_CONFLICT", "The sharing scope changed. Review this file operation again.");
	}
	await repository[action](executionIdentity(record), parseAttachmentReference(reference), expected?.scopeRevision);
}
