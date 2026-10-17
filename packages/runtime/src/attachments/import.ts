import { open } from "node:fs/promises";
import { basename } from "node:path";
import { HarnessError, checkCancellation } from "../errors.js";
import type { Workspace } from "../permissions/workspace.js";
import { maxAttachmentBytes } from "./record.js";

/** Import bytes through the same current path policy as ordinary workspace reads. */
export async function readAttachmentSource(workspace: Workspace, path: string, signal?: AbortSignal) {
	const lease = workspace.permissionPolicy?.beginOperation();
	try {
		const target = await workspace.resolvePath(path, signal);
		const file = await open(target.absolute, "r");
		try {
			const before = await file.stat();
			if (!before.isFile() || (!target.unrestricted && before.nlink !== 1)
				|| before.dev !== target.stat.dev || before.ino !== target.stat.ino) {
				throw new HarnessError("PATH_NOT_ALLOWED", "The import source changed during path validation.");
			}
			const limit = maxAttachmentBytes;
			if (before.size > limit) throw new HarnessError("ATTACHMENT_LIMIT", "Attachments must not exceed 16 MiB.");
			const buffer = Buffer.alloc(Math.min(before.size + 1, limit + 1));
			let size = 0;
			while (size < buffer.length) {
				checkCancellation(signal);
				const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
				if (!bytesRead) break;
				size += bytesRead;
			}
			const after = await file.stat();
			checkCancellation(signal);
			if (size !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs
				|| before.ctimeMs !== after.ctimeMs) {
				throw new HarnessError("ATTACHMENT_CONFLICT", "The import source changed while it was being read. Try importing it again.");
			}
			return { name: basename(target.absolute), bytes: buffer.subarray(0, size) };
		} finally {
			await file.close();
		}
	} finally {
		lease?.release();
	}
}
