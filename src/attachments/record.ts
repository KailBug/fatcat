import { extname } from "node:path";
import { HarnessError } from "../errors.js";

export const maxAttachmentBytes = 16 * 1024 * 1024;
export const attachmentIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const contentVersionPattern = /^[a-f0-9]{64}$/;

export interface AttachmentTarget {
	sessionId: string;
	locationRevision: number;
	projectId?: string;
}

export type AttachmentScope = { kind: "session"; sessionId: string } | { kind: "project"; projectId: string };

export interface AttachmentRef {
	attachmentId: string;
	contentVersion: string;
}

export interface AttachmentInfo {
	id: string;
	contentVersion: string;
	sha256: string;
	name: string;
	mediaType: string;
	size: number;
	createdAt: string;
	uploaderSessionId: string;
	scopeRevision: number;
	removed: boolean;
	deleted: boolean;
}

export interface AttachmentUploadMetadata {
	uploadId: string;
	name: string;
	mediaType?: string;
}

export interface StagedAttachment {
	uploadId: string;
	stageToken: string;
	target: AttachmentTarget;
	id: string;
	contentVersion: string;
	sha256: string;
	name: string;
	mediaType: string;
	size: number;
	createdAt: string;
}

export interface AttachmentSharingState {
	revision: number;
	count: number;
	fingerprint: string;
}

export interface AttachmentRecord extends StagedAttachment {
	uploaderSessionId: string;
	deletedAt?: string;
}

export interface AttachmentBinding extends AttachmentRef {
	scope: AttachmentScope;
	removedAt?: string;
}

export interface AttachmentPin extends AttachmentRef {
	sessionId: string;
}

export interface AttachmentCatalog {
	version: 1;
	revision: number;
	assets: AttachmentRecord[];
	bindings: AttachmentBinding[];
	pins: AttachmentPin[];
	scopeRevisions: Record<string, number>;
	deletedSessions: string[];
}

export function scopeOfTarget(target: AttachmentTarget): AttachmentScope {
	return target.projectId ? { kind: "project", projectId: target.projectId }
		: { kind: "session", sessionId: target.sessionId };
}

export function scopeKey(scope: AttachmentScope): string {
	return scope.kind === "project" ? `project:${scope.projectId}` : `session:${scope.sessionId}`;
}

export function attachmentReference(value: AttachmentInfo | AttachmentRef): string {
	return `attachment:${"id" in value ? value.id : value.attachmentId}@${value.contentVersion}`;
}

export function parseAttachmentReference(value: string): AttachmentRef {
	const match = /^attachment:([^@]+)@([^@]+)$/.exec(value);
	if (!match || !attachmentIdPattern.test(match[1]!) || !contentVersionPattern.test(match[2]!)) {
		throw new HarnessError("ATTACHMENT_REFERENCE", "Use the exact versioned attachment reference from the file list.");
	}
	return { attachmentId: match[1]!, contentVersion: match[2]! };
}

export function extractAttachmentReferences(text: string): AttachmentRef[] {
	const references = new Map<string, AttachmentRef>();
	for (const match of text.matchAll(/attachment:([0-9a-f-]{36})@([a-f0-9]{64})(?![a-f0-9])/g)) {
		if (attachmentIdPattern.test(match[1]!)) references.set(match[0], { attachmentId: match[1]!, contentVersion: match[2]! });
	}
	return [...references.values()];
}

export function attachmentName(value: string): string {
	const name = value.trim();
	if (!name || name.length > 240 || /[\x00-\x1f\x7f/\\]/.test(name) || name === "." || name === "..") {
		throw new HarnessError("ATTACHMENT_NAME", "Use a file name of at most 240 characters without paths or control characters.");
	}
	return name;
}

export function attachmentMediaType(name: string): string {
	const formats: Record<string, string> = {
		".txt": "text/plain", ".md": "text/markdown", ".markdown": "text/markdown",
		".csv": "text/csv", ".tsv": "text/tab-separated-values", ".pdf": "application/pdf",
		".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
		".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		".ppt": "application/vnd.ms-powerpoint", ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
		".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
		".webp": "image/webp", ".bmp": "image/bmp", ".tif": "image/tiff", ".tiff": "image/tiff",
	};
	const mediaType = formats[extname(name).toLowerCase()];
	if (!mediaType) throw new HarnessError("ATTACHMENT_FORMAT", "Supported attachments are text, Markdown, PDF, Office documents, and common raster images.");
	return mediaType;
}

export function emptyAttachmentCatalog(): AttachmentCatalog {
	return { version: 1, revision: 0, assets: [], bindings: [], pins: [], scopeRevisions: {}, deletedSessions: [] };
}

export function sameAttachmentTarget(left: AttachmentTarget, right: AttachmentTarget): boolean {
	return left.sessionId === right.sessionId && left.locationRevision === right.locationRevision && left.projectId === right.projectId;
}

export function validateAttachmentTarget(value: unknown): AttachmentTarget {
	if (!isRecord(value) || typeof value.sessionId !== "string" || !attachmentIdPattern.test(value.sessionId)
		|| !Number.isSafeInteger(value.locationRevision) || Number(value.locationRevision) < 0
		|| (value.projectId !== undefined && (typeof value.projectId !== "string" || !attachmentIdPattern.test(value.projectId)))) return invalidAttachment();
	return { sessionId: value.sessionId, locationRevision: Number(value.locationRevision),
		...(value.projectId === undefined ? {} : { projectId: String(value.projectId) }) };
}

export function decodeStagedAttachment(value: unknown): StagedAttachment {
	if (!isRecord(value) || typeof value.uploadId !== "string" || !attachmentIdPattern.test(value.uploadId)
		|| typeof value.stageToken !== "string" || !attachmentIdPattern.test(value.stageToken)
		|| typeof value.id !== "string" || !attachmentIdPattern.test(value.id)
		|| typeof value.contentVersion !== "string" || !contentVersionPattern.test(value.contentVersion)
		|| value.sha256 !== value.contentVersion || typeof value.name !== "string" || typeof value.mediaType !== "string"
		|| !Number.isSafeInteger(value.size) || Number(value.size) < 0 || Number(value.size) > maxAttachmentBytes
		|| typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) return invalidAttachment();
	try {
		if (attachmentName(value.name) !== value.name || attachmentMediaType(value.name) !== value.mediaType) return invalidAttachment();
	} catch { return invalidAttachment(); }
	return { uploadId: value.uploadId, stageToken: value.stageToken, target: validateAttachmentTarget(value.target), id: value.id,
		contentVersion: value.contentVersion, sha256: String(value.sha256), name: value.name, mediaType: value.mediaType,
		size: Number(value.size), createdAt: value.createdAt };
}

export function decodeAttachmentCatalog(value: unknown): AttachmentCatalog {
	if (!isRecord(value) || value.version !== 1 || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0
		|| !Array.isArray(value.assets) || value.assets.length > 10000 || !Array.isArray(value.bindings) || value.bindings.length > 30000
		|| !Array.isArray(value.pins) || value.pins.length > 50000 || !isRecord(value.scopeRevisions)) return invalidAttachment();
	const assets = value.assets.map((entry): AttachmentRecord => {
		const staged = decodeStagedAttachment(entry);
		if (!isRecord(entry) || entry.uploaderSessionId !== staged.target.sessionId
			|| (entry.deletedAt !== undefined && (typeof entry.deletedAt !== "string" || !Number.isFinite(Date.parse(entry.deletedAt))))) return invalidAttachment();
		return { ...staged, uploaderSessionId: String(entry.uploaderSessionId),
			...(entry.deletedAt === undefined ? {} : { deletedAt: String(entry.deletedAt) }) };
	});
	if (new Set(assets.map((asset) => asset.id)).size !== assets.length
		|| new Set(assets.map((asset) => asset.uploadId)).size !== assets.length) return invalidAttachment();
	const byId = new Map(assets.map((asset) => [asset.id, asset]));
	const reference = (entry: unknown): AttachmentRef => {
		if (!isRecord(entry) || typeof entry.attachmentId !== "string"
			|| byId.get(entry.attachmentId)?.contentVersion !== entry.contentVersion) return invalidAttachment();
		return { attachmentId: entry.attachmentId, contentVersion: String(entry.contentVersion) };
	};
	const bindings = value.bindings.map((entry): AttachmentBinding => {
		const ref = reference(entry);
		if (!isRecord(entry) || !isRecord(entry.scope)
			|| (entry.removedAt !== undefined && (typeof entry.removedAt !== "string" || !Number.isFinite(Date.parse(entry.removedAt))))) return invalidAttachment();
		const scope = entry.scope;
		let parsed: AttachmentScope;
		if (scope.kind === "project" && typeof scope.projectId === "string" && attachmentIdPattern.test(scope.projectId)) parsed = { kind: "project", projectId: scope.projectId };
		else if (scope.kind === "session" && typeof scope.sessionId === "string" && attachmentIdPattern.test(scope.sessionId)) parsed = { kind: "session", sessionId: scope.sessionId };
		else return invalidAttachment();
		return { ...ref, scope: parsed, ...(entry.removedAt === undefined ? {} : { removedAt: String(entry.removedAt) }) };
	});
	const pins = value.pins.map((entry): AttachmentPin => {
		const ref = reference(entry);
		if (!isRecord(entry) || typeof entry.sessionId !== "string" || !attachmentIdPattern.test(entry.sessionId)) return invalidAttachment();
		return { ...ref, sessionId: entry.sessionId };
	});
	if (new Set(bindings.map((binding) => `${scopeKey(binding.scope)}:${binding.attachmentId}`)).size !== bindings.length
		|| new Set(pins.map((pin) => `${pin.sessionId}:${pin.attachmentId}`)).size !== pins.length) return invalidAttachment();
	const scopeRevisions: Record<string, number> = {};
	for (const [key, revision] of Object.entries(value.scopeRevisions)) {
		const [kind, id] = key.split(":");
		if (!["session", "project"].includes(kind ?? "") || !attachmentIdPattern.test(id ?? "") || key !== `${kind}:${id}`
			|| !Number.isSafeInteger(revision) || Number(revision) < 0) return invalidAttachment();
		scopeRevisions[key] = Number(revision);
	}
	const deletedSessions = value.deletedSessions ?? [];
	if (!Array.isArray(deletedSessions) || deletedSessions.length > 50000
		|| deletedSessions.some((id) => typeof id !== "string" || !attachmentIdPattern.test(id))
		|| new Set(deletedSessions).size !== deletedSessions.length) return invalidAttachment();
	return { version: 1, revision: Number(value.revision), assets, bindings, pins, scopeRevisions, deletedSessions: deletedSessions as string[] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function invalidAttachment(): never {
	throw new HarnessError("ATTACHMENT_CORRUPT", "Attachment metadata is invalid or unsupported. Restore the local attachment store before continuing.");
}
