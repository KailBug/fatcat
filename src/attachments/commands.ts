import { quoted, quotedArguments } from "../utils/command.js";
import { HarnessError, checkCancellation } from "../errors.js";
import type { Conversation } from "../session/commands.js";
import { sessionScopeLabel } from "../session/labels.js";
import { SessionManager } from "../session/manager.js";
import { attachmentReference, parseAttachmentReference } from "./record.js";
import type { AttachmentInfo } from "./record.js";

export const attachmentCommandHelp = "/attachments: list current attachments; /attach \"path\": import a file; /attachment remove <reference>: remove its scope association; "
	+ "/attachment delete <reference> --confirm: permanently delete an unreferenced original.";

function attachmentLabel(record: AttachmentInfo): string {
	return `${attachmentReference(record)} | ${quoted(record.name)} | ${record.size} bytes | ${quoted(record.mediaType)}`
		+ (record.deleted ? " | deleted" : record.removed ? " | association removed" : " | saved");
}

export async function runAttachmentCommand(session: Conversation, prompt: string,
	options: { signal?: AbortSignal } = {}): Promise<{ text: string; switched: boolean } | undefined> {
	const match = /^\/(attachments|attach|attachment)(?:\s+([\s\S]*))?$/.exec(prompt);
	if (!match) return;
	const command = match[1]!;
	const argument = match[2]?.trim();
	if (!(session instanceof SessionManager)) throw new HarnessError("USAGE", "Session management requires a managed conversation.");
	const { signal } = options;
	checkCancellation(signal);
	const sessionId = session.current.id;
	const scopeLabel = sessionScopeLabel(session.current);
	if (command === "attachments") {
		if (argument) throw new HarnessError("USAGE", "/attachments does not take an argument.");
		const attachments = await session.listAttachments(sessionId);
		checkCancellation(signal);
		return { text: attachments.length ? `${scopeLabel} attachments:\n${attachments.map(attachmentLabel).join("\n")}`
			: 'No attachments in this scope. Use /attach "path" to import a file.', switched: false };
	}
	if (command === "attach") {
		const paths = quotedArguments(argument ?? "", 'Use /attach "path".');
		if (paths.length !== 1 || !paths[0]) throw new HarnessError("USAGE", 'Use /attach "path".');
		const record = await session.importAttachment(paths[0], signal);
		return { text: `Attachment saved: ${attachmentLabel(record)}. ${scopeLabel}. `
			+ "Ask the agent to read supported text or document formats. Image and PDF-page analysis requires a supported current model; saving does not analyze the file.", switched: false };
	}
	const args = quotedArguments(argument ?? "", "Use /attachment remove <reference> or /attachment delete <reference> --confirm.");
	const [action, reference, confirmation] = args;
	if (!reference || (action !== "remove" && action !== "delete") || args.length > 3
		|| (action === "remove" && args.length !== 2) || (confirmation !== undefined && confirmation !== "--confirm")) {
		throw new HarnessError("USAGE", "Use /attachment remove <reference> or /attachment delete <reference> --confirm.");
	}
	parseAttachmentReference(reference);
	if (action === "remove") {
		await session.removeAttachment(sessionId, reference);
		return { text: `Attachment association removed from ${scopeLabel}: ${reference}. `
			+ "The original and existing history references are retained. Other scopes are unchanged.", switched: false };
	}
	if (confirmation !== "--confirm") {
		const record = (await session.listAttachments(sessionId, true)).find((item) => attachmentReference(item) === reference);
		if (!record) throw new HarnessError("ATTACHMENT_NOT_FOUND", "That attachment is not available in this scope.");
		return { text: `Permanently delete ${attachmentLabel(record)} from ${scopeLabel}? `
			+ "This destroys the original and removes the current scope's association, so every session in this scope loses access. "
			+ "Other active scope associations or retained history/fork references block deletion. "
			+ `Confirm with /attachment delete ${reference} --confirm.`, switched: false };
	}
	await session.deleteAttachment(sessionId, reference);
	return { text: `Attachment permanently deleted: ${reference}. Historical reference identities are not rewritten.`, switched: false };
}
