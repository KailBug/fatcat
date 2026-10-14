import type { AttachmentInfo } from "../../src/attachments/record.js";
import type { AttachmentReadResult } from "../../src/attachments/read.js";
import type { SessionSummary } from "../../src/session/record.js";
import type { WebUiState } from "../controller.js";
import { AttachmentUploads } from "./attachment-upload.js";

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
	const element = document.createElement(tag);
	if (text !== undefined) element.textContent = text;
	if (className) element.className = className;
	return element;
}

function button(text: string, action: () => void): HTMLButtonElement {
	const element = node("button", text);
	element.type = "button";
	element.addEventListener("click", action);
	return element;
}

function reference(info: AttachmentInfo): string { return `attachment:${info.id}@${info.contentVersion}`; }

export function parseSourceReference(value: string): { reference: string; offset: number; limit: number } | undefined {
	const match = /^(attachment:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}@[0-9a-f]{64})(?:#L([1-9][0-9]*)-L([1-9][0-9]*))?$/.exec(value);
	if (!match) return undefined;
	const start = Number(match[2] ?? 1), end = Number(match[3] ?? 100);
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return undefined;
	return { reference: match[1]!, offset: start - 1, limit: Math.min(200, end - start + 1) };
}

export class AttachmentsPanel {
	private readonly dialog = node("dialog", undefined, "session-dialog attachments-dialog");
	private readonly title = node("h2", "Attachments", "session-dialog-heading");
	private readonly scope = node("p", undefined, "session-dialog-description");
	private readonly input = node("input");
	private readonly list = node("div", undefined, "attachment-list");
	private readonly error = node("p", undefined, "session-dialog-error");
	private readonly source = node("dialog", undefined, "session-dialog attachment-source-dialog");
	private readonly sourceTitle = node("h2", "Attachment source", "session-dialog-heading");
	private readonly sourceBody = node("div");
	private readonly confirm = node("dialog", undefined, "session-dialog");
	private readonly uploads: AttachmentUploads;
	private state: WebUiState | undefined;
	private connected = false;
	private listKey = "";
	private requestId = 0;
	private sourceRequestId = 0;
	private confirming = false;

	constructor(private readonly token: () => string, private readonly changed: () => Promise<void>) {
		this.dialog.id = "attachments-dialog";
		this.title.id = "attachments-title";
		this.dialog.setAttribute("aria-labelledby", this.title.id);
		this.input.id = "attachment-files";
		this.input.type = "file";
		this.input.multiple = true;
		this.input.accept = ".txt,.md,.markdown,.csv,.tsv,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.png,.jpg,.jpeg,.gif,.webp,.bmp,.tif,.tiff";
		const label = node("label", "Upload files", "session-dialog-label");
		label.htmlFor = this.input.id;
		this.error.role = "alert";
		this.error.hidden = true;
		this.list.role = "list";
		const close = button("Close attachments", () => this.dialog.close());
		close.className = "session-dialog-cancel";
		const footer = node("div", undefined, "session-dialog-actions");
		footer.append(close);
		const uploads = document.getElementById("attachment-uploads")!;
		const uploadHome = uploads.parentElement!;
		const uploadSibling = uploads.nextSibling;
		const uploadSlot = node("div");
		this.dialog.append(this.title, this.scope, label, this.input,
			node("p", "Up to 16 MiB per file and four uploads at once. You can close this panel and switch chats while uploading.", "attachment-note"),
			node("p", "UTF-8 text and Markdown can be read. PDF, Office documents and images are saved as originals; their analysis is not available yet.", "attachment-note"),
			uploadSlot, this.error, this.list, footer);
		this.dialog.addEventListener("close", () => uploadHome.insertBefore(uploads, uploadSibling));
		this.source.id = "attachment-source";
		this.sourceTitle.id = "attachment-source-title";
		this.source.setAttribute("aria-labelledby", this.sourceTitle.id);
		const sourceClose = button("Close source", () => this.source.close());
		sourceClose.className = "session-dialog-cancel";
		const sourceFooter = node("div", undefined, "session-dialog-actions");
		sourceFooter.append(sourceClose);
		this.source.append(this.sourceTitle, this.sourceBody, sourceFooter);
		this.confirm.id = "attachment-confirm";
		for (const dialog of [this.dialog, this.source, this.confirm]) {
			dialog.addEventListener("cancel", (event) => event.stopPropagation());
			dialog.addEventListener("keydown", (event) => { if (event.key === "Escape") event.stopPropagation(); });
			document.body.append(dialog);
		}
		this.source.addEventListener("close", () => { this.sourceRequestId++; });
		this.confirm.addEventListener("cancel", (event) => { if (this.confirming) event.preventDefault(); });
		this.uploads = new AttachmentUploads(uploads, token,
			(path, body) => this.request(path, body), async () => { await changed(); if (this.dialog.open) await this.load(); });
		this.input.addEventListener("change", () => {
			if (this.input.files?.length && this.state && this.connected) this.uploads.add(this.input.files, this.state.current, this.state.persistent);
			this.input.value = "";
		});
		document.getElementById("show-attachments")!.addEventListener("click", () => {
			if (!this.state || !this.connected || this.dialog.open) return;
			uploadSlot.append(uploads);
			this.dialog.showModal();
			void this.load();
		});
	}

	update(state: WebUiState, connected: boolean): void {
		const switched = this.state?.current.id !== state.current.id || this.state?.current.locationRevision !== state.current.locationRevision;
		this.state = state;
		this.connected = connected;
		(document.getElementById("show-attachments") as HTMLButtonElement).disabled = !connected;
		this.input.disabled = !connected || Boolean(state.current.projectError);
		this.scope.textContent = state.current.projectId ? `Shared with all chats in ${state.current.projectName ?? "this project"}.`
			: `Private to ${state.current.name ?? state.current.title}.`;
		if (!state.persistent) this.scope.textContent += " Memory only: files are lost when the server stops (64 MiB total).";
		if (switched && this.source.open) this.source.close();
		const key = `${state.current.id}:${state.current.locationRevision ?? 0}:${state.attachmentRevision}`;
		if (this.dialog.open && key !== this.listKey) void this.load();
	}

	private async request<T>(path: string, body: unknown): Promise<T> {
		const response = await fetch(`/api/attachments/${path}`, { method: "POST", headers: {
			Authorization: `Bearer ${this.token()}`, "Content-Type": "application/json",
		}, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
		if (!response.ok) throw new Error((await response.json() as { error: string }).error);
		return await response.json() as T;
	}

	private async load(): Promise<void> {
		if (!this.state) return;
		const session = structuredClone(this.state.current);
		const id = ++this.requestId;
		this.listKey = `${session.id}:${session.locationRevision ?? 0}:${this.state.attachmentRevision}`;
		this.error.hidden = true;
		this.list.replaceChildren(node("p", "Loading files…", "attachment-note"));
		try {
			const files = await this.request<AttachmentInfo[]>("list", { sessionId: session.id, includeRemoved: true });
			if (id !== this.requestId) return;
			this.list.replaceChildren();
			if (!files.length) this.list.append(node("p", "No files in this scope yet.", "attachment-note"));
			for (const file of files) this.list.append(this.fileRow(file, session));
		} catch (error) {
			if (id !== this.requestId) return;
			this.list.replaceChildren();
			this.fail(error);
		}
	}

	private fileRow(file: AttachmentInfo, session: SessionSummary): HTMLElement {
		const row = node("section", undefined, "attachment-row");
		row.role = "listitem";
		row.dataset.attachmentId = file.id;
		const readable = /\.(?:txt|md|markdown)$/i.test(file.name);
		const status = file.deleted ? "Permanently deleted" : file.removed ? "Removed from this scope"
			: readable ? "Stored · UTF-8 text can be read" : "Stored · analysis unavailable";
		row.append(node("h3", file.name), node("p", `${(file.size / 1024).toLocaleString("en-US", { maximumFractionDigits: 1 })} KiB · ${status}`, "attachment-note"),
			node("p", `Version ${file.contentVersion.slice(0, 12)} · Uploaded ${new Date(file.createdAt).toLocaleString()}`, "attachment-note"));
		const actions = node("div", undefined, "attachment-actions");
		if (!file.removed && !file.deleted) {
			if (readable) actions.append(button("View text", () => { void this.openReference(reference(file), session.id, file.name); }));
			actions.append(button("Download original", () => { void this.download(file, session.id); }),
				button(session.projectId ? "Remove from project" : "Remove from chat", () => this.confirmChange("remove", file, session)));
		}
		if (!file.deleted) actions.append(button("Permanently delete", () => this.confirmChange("delete", file, session)));
		row.append(actions);
		return row;
	}

	private fail(error: unknown): void {
		this.error.textContent = error instanceof Error ? error.message : "The attachment operation failed.";
		this.error.hidden = false;
	}

	private async download(file: AttachmentInfo, sessionId: string): Promise<void> {
		try {
			const response = await fetch("/api/attachments/download", { method: "POST", headers: {
				Authorization: `Bearer ${this.token()}`, "Content-Type": "application/json",
			}, body: JSON.stringify({ sessionId, reference: reference(file) }), signal: AbortSignal.timeout(30_000) });
			if (!response.ok) throw new Error((await response.json() as { error: string }).error);
			const url = URL.createObjectURL(await response.blob());
			const link = node("a");
			link.href = url;
			link.download = file.name;
			link.click();
			setTimeout(() => URL.revokeObjectURL(url), 10_000);
		} catch (error) { this.fail(error); }
	}

	private confirmChange(action: "remove" | "delete", file: AttachmentInfo, session: SessionSummary): void {
		if (this.confirm.open) return;
		const title = node("h2", action === "remove" ? "Remove attachment association?" : "Permanently delete original?", "session-dialog-heading");
		title.id = "attachment-confirm-title";
		this.confirm.setAttribute("aria-labelledby", title.id);
		const scope = session.projectId ? `every chat in project ${session.projectName ?? session.projectId}` : `chat ${session.name ?? session.title}`;
		const description = node("p", action === "remove"
			? `Remove "${file.name}" from ${scope}? The original is retained, but this scope can no longer read or download it. Existing history keeps its text and versioned references; other active associations remain available.`
			: `Permanently delete "${file.name}" and its association with ${scope}? This cannot be undone. Deletion is refused while other associations or saved history still need this original.`, "session-dialog-description");
		const error = node("p", undefined, "session-dialog-error");
		error.role = "alert";
		error.hidden = true;
		const cancel = button("Cancel", () => this.confirm.close());
		cancel.className = "session-dialog-cancel";
		const submit = button(action === "remove" ? "Confirm removal" : "Delete permanently", () => {
			this.confirming = true;
			submit.disabled = true;
			cancel.disabled = true;
			void this.request(action, { sessionId: session.id, reference: reference(file), confirmed: true,
				locationRevision: session.locationRevision ?? 0, scopeRevision: file.scopeRevision }).then(async () => {
				this.confirm.close();
				await this.changed();
				await this.load();
			}).catch((reason: unknown) => {
				error.textContent = reason instanceof Error ? reason.message : "The file change failed.";
				error.hidden = false;
			}).finally(() => { this.confirming = false; submit.disabled = false; cancel.disabled = false; });
		});
		submit.className = "session-dialog-submit danger";
		const actions = node("div", undefined, "session-dialog-actions");
		actions.append(cancel, submit);
		this.confirm.replaceChildren(title, description, error, actions);
		this.confirm.showModal();
	}

	async openReference(value: string, sessionId: string, name = "Attachment source"): Promise<void> {
		const source = parseSourceReference(value);
		if (!source) return;
		this.sourceTitle.textContent = name;
		if (!this.source.open) this.source.showModal();
		await this.loadSource(source.reference, sessionId, source.offset, source.limit);
	}

	private async loadSource(reference: string, sessionId: string, offset: number, limit: number): Promise<void> {
		const id = ++this.sourceRequestId;
		this.sourceBody.replaceChildren(node("p", "Loading source…", "attachment-note"));
		try {
			const result = await this.request<AttachmentReadResult>("read", { sessionId, reference, offset, limit });
			if (id !== this.sourceRequestId || !this.source.open || result.kind !== "file") return;
			this.sourceTitle.textContent = result.name;
			const locator = node("p", result.totalLines === 0 ? "Empty UTF-8 document."
				: result.startLine === null ? `No lines at this location. The document has ${result.totalLines} lines.`
				: `Showing lines ${result.startLine ?? "—"}–${result.endLine ?? "—"} of ${result.totalLines}.`, "attachment-coverage");
			const coverage = node("p", result.coverage.complete ? "This preview covers the full text."
				: "Only the displayed lines are covered by this preview. Other lines have not been shown.", "attachment-note");
			const content = node("pre", undefined, "attachment-source-text");
			const lines = result.content.replace(/\r\n|\r/g, "\n").split("\n");
			if (lines.at(-1) === "") lines.pop();
			content.textContent = lines.map((line, index) => `${(result.startLine ?? 1) + index} │ ${line}`).join("\n");
			this.sourceBody.replaceChildren(node("p", result.citation, "attachment-reference"), locator, coverage, content);
			const paging = node("div", undefined, "attachment-actions");
			if (offset > 0) paging.append(button("Start of file", () => { void this.loadSource(reference, sessionId, 0, 100); }));
			if (result.nextOffset !== null) paging.append(button("Next lines", () => { void this.loadSource(reference, sessionId, result.nextOffset!, 100); }));
			this.sourceBody.append(paging);
		} catch (error) {
			if (id !== this.sourceRequestId || !this.source.open) return;
			const message = node("p", error instanceof Error ? error.message : "The source could not be read.", "session-dialog-error");
			message.role = "alert";
			this.sourceBody.replaceChildren(message);
		}
	}
}
