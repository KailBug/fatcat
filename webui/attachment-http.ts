import type { IncomingMessage, ServerResponse } from "node:http";
import { HarnessError } from "../src/errors.js";
import { maxUploadBytes, uploadTimeoutMs } from "./attachments.js";
import type { WebAttachments } from "./attachments.js";

function json(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(value));
}

function text(value: unknown, field: string, limit = 256): string {
	if (typeof value !== "string" || !value.trim() || value.length > limit || /[\x00-\x1f\x7f]/.test(value)) {
		throw new HarnessError("INPUT", `Expected a valid ${field}.`);
	}
	return value;
}

function fields(body: Record<string, unknown>, allowed: string[]): void {
	if (Object.keys(body).some((key) => !allowed.includes(key))) throw new HarnessError("INPUT", "Unexpected attachment request fields.");
}

/** Attachment bytes never pass through the ordinary JSON message reader. */
export class AttachmentHttp {
	constructor(private readonly attachments: WebAttachments, private readonly shutdown: AbortSignal) {}

	async upload(path: string, request: IncomingMessage, response: ServerResponse): Promise<boolean> {
		const match = /^\/api\/attachments\/upload\/([a-f0-9-]{36})$/.exec(path);
		if (!match || request.method !== "POST") return false;
		response.setHeader("Connection", "close");
		if (request.headers["content-type"] !== "application/octet-stream" || request.headers["content-encoding"]) {
			throw new HarnessError("INPUT", "Upload raw file bytes without content encoding.");
		}
		if (request.headers["content-length"] !== undefined
			&& (!Number.isSafeInteger(Number(request.headers["content-length"])) || Number(request.headers["content-length"]) > maxUploadBytes)) {
			throw new HarnessError("ATTACHMENT_LIMIT", "Choose a file of at most 16 MiB.");
		}
		const token = match[1]!;
		const disconnected = new AbortController();
		const abort = () => disconnected.abort();
		const signal = AbortSignal.any([this.shutdown, disconnected.signal, this.attachments.uploadSignal(token), AbortSignal.timeout(uploadTimeoutMs)]);
		const stopReading = () => request.destroy();
		request.once("aborted", abort);
		response.once("close", abort);
		signal.addEventListener("abort", stopReading, { once: true });
		response.setTimeout(uploadTimeoutMs);
		try {
			signal.throwIfAborted();
			const record = await this.attachments.receive(token, fileChunks(request, signal), signal);
			json(response, 201, record);
		} finally {
			request.off("aborted", abort);
			response.off("close", abort);
			signal.removeEventListener("abort", stopReading);
			if (!response.destroyed) response.setTimeout(15_000);
		}
		return true;
	}

	async handle(path: string, body: Record<string, unknown>, response: ServerResponse): Promise<boolean> {
		if (!path.startsWith("/api/attachments/")) return false;
		if (path === "/api/attachments/begin") {
			fields(body, ["sessionId", "name", "size", "uploadId", "locationRevision", "projectId"]);
			if (typeof body.size !== "number") throw new HarnessError("INPUT", "Expected the file size in bytes.");
			if (!Number.isSafeInteger(body.locationRevision) || Number(body.locationRevision) < 0
				|| (body.projectId !== null && typeof body.projectId !== "string")) throw new HarnessError("INPUT", "Select a file from the intended chat before uploading.");
			json(response, 201, await this.attachments.begin(text(body.sessionId, "session ID"), text(body.name, "file name"), body.size,
				body.uploadId === undefined ? undefined : text(body.uploadId, "upload ID"), {
					locationRevision: Number(body.locationRevision), projectId: body.projectId === null ? null : text(body.projectId, "project ID"),
				}));
		} else if (path === "/api/attachments/cancel") {
			fields(body, ["token"]);
			this.attachments.cancel(text(body.token, "upload token"));
			json(response, 202, { accepted: true });
		} else if (path === "/api/attachments/list") {
			fields(body, ["sessionId", "includeRemoved"]);
			if (body.includeRemoved !== undefined && typeof body.includeRemoved !== "boolean") throw new HarnessError("INPUT", "Expected a boolean removed-files filter.");
			json(response, 200, await this.attachments.list(text(body.sessionId, "session ID"), body.includeRemoved === true));
		} else if (path === "/api/attachments/read") {
			fields(body, ["sessionId", "reference", "offset", "limit", "query", "parserVersion", "unit", "pages", "sheet", "section"]);
			for (const field of ["offset", "limit"] as const) {
				if (body[field] !== undefined && (!Number.isSafeInteger(body[field]) || Number(body[field]) < (field === "offset" ? 0 : 1))) {
					throw new HarnessError("INPUT", `Expected a valid ${field}.`);
				}
			}
			for (const field of ["parserVersion", "unit"] as const) {
				if (body[field] !== undefined && (typeof body[field] !== "string" || !/^[a-zA-Z0-9._-]{1,96}$/.test(body[field]) || /\s/.test(body[field]))) {
					throw new HarnessError("INPUT", `Expected a valid ${field}.`);
				}
			}
			if (body.pages !== undefined && (!Array.isArray(body.pages) || !body.pages.length || body.pages.length > 100
				|| body.pages.some((page) => !Number.isSafeInteger(page) || Number(page) < 1))) {
				throw new HarnessError("INPUT", "Expected up to 100 positive page numbers.");
			}
			json(response, 200, await withRequestSignal(response, this.shutdown, (signal) => this.attachments.read(text(body.reference, "attachment reference"), {
				sessionId: text(body.sessionId, "session ID"), signal,
				...(body.offset === undefined ? {} : { offset: Number(body.offset) }),
				...(body.limit === undefined ? {} : { limit: Number(body.limit) }),
				...(body.query === undefined ? {} : { query: text(body.query, "search text", 512) }),
				...(body.parserVersion === undefined ? {} : { parserVersion: String(body.parserVersion) }),
				...(body.unit === undefined ? {} : { unit: String(body.unit) }),
				...(body.pages === undefined ? {} : { pages: body.pages as number[] }),
				...(body.sheet === undefined ? {} : { sheet: text(body.sheet, "worksheet", 128) }),
				...(body.section === undefined ? {} : { section: text(body.section, "section", 256) }),
			})));
		} else if (path === "/api/attachments/download") {
			fields(body, ["sessionId", "reference"]);
			const { record, bytes } = await withRequestSignal(response, this.shutdown, (signal) =>
				this.attachments.download(text(body.sessionId, "session ID"), text(body.reference, "attachment reference"), signal));
			const encodedName = encodeURIComponent(record.name).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
			response.writeHead(200, { "Content-Type": "application/octet-stream", "Content-Length": bytes.byteLength,
				"Content-Disposition": `attachment; filename="attachment"; filename*=UTF-8''${encodedName}`,
				"X-Content-Version": record.contentVersion });
			response.end(bytes);
		} else if (path === "/api/attachments/remove" || path === "/api/attachments/delete") {
			fields(body, ["sessionId", "reference", "confirmed", "locationRevision", "scopeRevision"]);
			if (body.confirmed !== true) throw new HarnessError("INPUT", "Confirm the attachment change before continuing.");
			for (const field of ["locationRevision", "scopeRevision"] as const) {
				if (!Number.isSafeInteger(body[field]) || Number(body[field]) < 0) throw new HarnessError("INPUT", "Reopen the attachment confirmation before continuing.");
			}
			const sessionId = text(body.sessionId, "session ID");
			const reference = text(body.reference, "attachment reference");
			const expected = { locationRevision: Number(body.locationRevision), scopeRevision: Number(body.scopeRevision) };
			if (path.endsWith("/remove")) await this.attachments.remove(sessionId, reference, expected);
			else await this.attachments.delete(sessionId, reference, expected);
			json(response, 202, { accepted: true });
		} else return false;
		return true;
	}
}

async function withRequestSignal<T>(response: ServerResponse, shutdown: AbortSignal, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const disconnected = new AbortController();
	const abort = () => disconnected.abort();
	response.once("close", abort);
	try { return await operation(AbortSignal.any([shutdown, disconnected.signal, AbortSignal.timeout(30_000)])); }
	finally { response.off("close", abort); }
}

async function* fileChunks(request: IncomingMessage, signal: AbortSignal): AsyncGenerator<Uint8Array> {
	let received = 0;
	for await (const chunk of request.iterator({ destroyOnReturn: false })) {
		signal.throwIfAborted();
		received += chunk.length;
		if (received > maxUploadBytes) throw new HarnessError("ATTACHMENT_LIMIT", "The upload exceeded 16 MiB.");
		yield chunk;
	}
	signal.throwIfAborted();
}
