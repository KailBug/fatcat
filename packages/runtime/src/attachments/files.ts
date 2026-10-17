import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { HarnessError, checkCancellation } from "../errors.js";
import { attachmentIdPattern, maxAttachmentBytes } from "./record.js";
import type { AttachmentRecord } from "./record.js";
import { boundedJson } from "./metadata-files.js";

export function stagedAttachmentPath(directory: string, id: string, extension: ".json" | ".lock"): string {
	if (!attachmentIdPattern.test(id)) throw new HarnessError("ATTACHMENT_UPLOAD", "Invalid upload identity.");
	return join(directory, "staging", `${id}${extension}`);
}

export function stagedAttachmentPart(directory: string, id: string, stageToken: string): string {
	if (!attachmentIdPattern.test(id) || !attachmentIdPattern.test(stageToken)) throw new HarnessError("ATTACHMENT_UPLOAD", "Invalid upload ownership.");
	return join(directory, "staging", `${id}.${stageToken}.part`);
}

/** Read ownership data only; the store decides whether an upload may claim, publish or discard it. */
export async function readStagingOwner(directory: string, id: string): Promise<{ pid: number; stageToken: string } | undefined> {
	const owner = await boundedJson(stagedAttachmentPath(directory, id, ".lock"), 4096, true);
	if (owner === undefined) return undefined;
	if (typeof owner !== "object" || owner === null || !("pid" in owner) || !("stageToken" in owner)
		|| !Number.isSafeInteger(owner.pid) || Number(owner.pid) < 1 || typeof owner.stageToken !== "string"
		|| !attachmentIdPattern.test(owner.stageToken)) {
		throw new HarnessError("ATTACHMENT_UPLOAD_CONFLICT", "The upload ownership record is invalid. Confirm no upload is running before repairing staging metadata.");
	}
	return { pid: Number(owner.pid), stageToken: owner.stageToken };
}

/** Receive bytes outside the metadata gate; the store retains publication and token-scoped cleanup. */
export async function writeAttachmentPart(path: string, body: AsyncIterable<Uint8Array>,
	signal?: AbortSignal): Promise<{ size: number; sha256: string }> {
	let handle;
	try {
		handle = await open(path, "wx", 0o600);
		let size = 0;
		const hash = createHash("sha256");
		for await (const chunk of body) {
			checkCancellation(signal);
			if (!(chunk instanceof Uint8Array)) throw new HarnessError("ATTACHMENT_UPLOAD", "Expected attachment bytes.");
			size += chunk.byteLength;
			if (size > maxAttachmentBytes) throw new HarnessError("ATTACHMENT_LIMIT", "Each attachment must fit within 16 MiB.");
			hash.update(chunk);
			await handle.writeFile(chunk);
		}
		checkCancellation(signal);
		await handle.sync();
		await handle.close();
		handle = undefined;
		return { size, sha256: hash.digest("hex") };
	} catch (error) {
		await handle?.close().catch(() => {});
		throw error;
	}
}

/** Verify physical content only; the caller must validate access before exposing bytes. */
export async function readAttachmentBytes(path: string, asset: Pick<AttachmentRecord, "size" | "sha256">): Promise<Uint8Array> {
	let handle;
	try {
		handle = await open(path, "r");
		const info = await handle.stat();
		if (!info.isFile() || info.size !== asset.size || info.size > maxAttachmentBytes) throw new Error();
		const bytes = Buffer.alloc(asset.size + 1);
		let count = 0;
		while (count < bytes.length) {
			const next = await handle.read(bytes, count, bytes.length - count, count);
			if (!next.bytesRead) break;
			count += next.bytesRead;
		}
		if (count !== asset.size) throw new Error();
		const result = bytes.subarray(0, count);
		if (createHash("sha256").update(result).digest("hex") !== asset.sha256) throw new Error();
		return result;
	} catch { throw new HarnessError("ATTACHMENT_CONTENT", "The original attachment is missing or no longer matches its recorded version."); }
	finally { await handle?.close(); }
}
