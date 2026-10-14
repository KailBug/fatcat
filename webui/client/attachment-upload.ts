import type { SessionSummary } from "../../src/session/record.js";
import type { UploadTicket } from "../attachments.js";

export type AttachmentRequest = <T>(path: string, body: unknown) => Promise<T>;

interface Upload {
	file: File;
	session: SessionSummary;
	id: string;
	abort: AbortController;
	ticket?: UploadTicket;
	status: HTMLElement;
	actions: HTMLElement;
	row: HTMLElement;
	running: boolean;
	persistent: boolean;
}

/** Each entry keeps the original target even when the shared selected session changes. */
export class AttachmentUploads {
	private readonly uploads = new Set<Upload>();

	constructor(private readonly container: HTMLElement, private readonly token: () => string,
		private readonly request: AttachmentRequest, private readonly changed: () => Promise<void>) {}

	add(files: FileList, session: SessionSummary, persistent: boolean): void {
		for (const file of files) {
			const row = document.createElement("div");
			row.className = "attachment-upload";
			const status = document.createElement("span");
			status.role = "status";
			const actions = document.createElement("div");
			row.append(status, actions);
			this.container.append(row);
			const upload: Upload = { file, session: structuredClone(session), id: crypto.randomUUID(),
				abort: new AbortController(), status, actions, row, running: false, persistent };
			this.uploads.add(upload);
			if (file.size > 16 * 1024 * 1024) this.failed(upload, "File exceeds 16 MiB.");
			else void this.start(upload);
		}
	}

	private describe(upload: Upload, status: string): void {
		const target = upload.session.projectName ? `project ${upload.session.projectName}` : upload.session.name ?? upload.session.title;
		upload.status.textContent = `${upload.file.name} → ${target}: ${status}`;
	}

	private action(upload: Upload, label: string, handler: () => void): void {
		const button = document.createElement("button");
		button.type = "button";
		button.textContent = label;
		button.addEventListener("click", handler);
		upload.actions.append(button);
	}

	private dismiss(upload: Upload): void {
		this.uploads.delete(upload);
		upload.row.remove();
	}

	private failed(upload: Upload, reason: string): void {
		this.describe(upload, reason);
		upload.actions.replaceChildren();
		if (upload.file.size <= 16 * 1024 * 1024) this.action(upload, "Retry", () => { void this.start(upload); });
		this.action(upload, "Dismiss", () => this.dismiss(upload));
	}

	private async start(upload: Upload): Promise<void> {
		if (upload.running) return;
		if ([...this.uploads].filter((entry) => entry.running).length >= 4) {
			this.failed(upload, "Four files are uploading. Retry when one finishes.");
			return;
		}
		upload.running = true;
		upload.abort = new AbortController();
		delete upload.ticket;
		this.describe(upload, "Preparing upload…");
		upload.actions.replaceChildren();
		this.action(upload, "Cancel upload", () => {
			upload.abort.abort();
			if (upload.ticket) void this.request("cancel", { token: upload.ticket.token }).catch(() => undefined);
		});
		try {
			upload.ticket = await this.request<UploadTicket>("begin", { sessionId: upload.session.id,
				name: upload.file.name, size: upload.file.size, uploadId: upload.id,
				locationRevision: upload.session.locationRevision ?? 0, projectId: upload.session.projectId ?? null });
			if (upload.abort.signal.aborted) {
				await this.request("cancel", { token: upload.ticket.token });
				throw new Error("Upload cancelled.");
			}
			await this.transfer(upload);
			this.describe(upload, upload.persistent ? "Saved" : "Stored in memory until the server stops");
			upload.actions.replaceChildren();
			this.action(upload, "Dismiss", () => this.dismiss(upload));
			await this.changed();
		} catch (error) {
			this.failed(upload, upload.abort.signal.aborted ? "Upload cancelled. Check the file list for any completed upload."
				: error instanceof Error ? error.message : "Upload failed. Retry to check whether it was saved.");
		} finally { upload.running = false; }
	}

	private transfer(upload: Upload): Promise<void> {
		return new Promise((resolve, reject) => {
			const xhr = new XMLHttpRequest();
			const abort = () => xhr.abort();
			xhr.open("POST", `/api/attachments/upload/${upload.ticket!.token}`);
			xhr.setRequestHeader("Authorization", `Bearer ${this.token()}`);
			xhr.setRequestHeader("Content-Type", "application/octet-stream");
			xhr.timeout = 120_000;
			xhr.upload.onprogress = (event) => this.describe(upload,
				event.lengthComputable && event.loaded === event.total ? "Sent · waiting for save (active tasks may delay this)…"
					: event.lengthComputable ? `Uploading ${Math.floor(event.loaded / event.total * 100)}%` : "Uploading…");
			xhr.onload = () => {
				if (xhr.status >= 200 && xhr.status < 300) resolve();
				else {
					let message = "Upload failed. Retry to check whether it was saved.";
					try { message = (JSON.parse(xhr.responseText) as { error: string }).error || message; } catch { /* Keep the bounded public error. */ }
					reject(new Error(message));
				}
			};
			xhr.onerror = () => reject(new Error("Upload connection lost. Retry to check whether it was saved."));
			xhr.ontimeout = () => reject(new Error("Upload exceeded two minutes. Retry to check whether it was saved."));
			xhr.onabort = () => reject(new Error("Upload cancelled."));
			xhr.onloadend = () => upload.abort.signal.removeEventListener("abort", abort);
			upload.abort.signal.addEventListener("abort", abort, { once: true });
			xhr.send(upload.file);
		});
	}
}
