import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { HarnessError } from "../errors.js";

export async function atomicJson(path: string, value: unknown, maximum: number): Promise<void> {
	const json = JSON.stringify(value);
	if (Buffer.byteLength(json) > maximum) throw new HarnessError("ATTACHMENT_LIMIT", "Attachment metadata exceeds the local storage limit.");
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		const handle = await open(temporary, "wx", 0o600);
		try { await handle.writeFile(json, "utf8"); await handle.sync(); } finally { await handle.close(); }
		await rename(temporary, path);
	} finally { await unlink(temporary).catch(() => {}); }
}

export async function boundedJson(path: string, maximum: number, optional = false): Promise<unknown> {
	let handle;
	try {
		handle = await open(path, "r");
		const info = await handle.stat();
		if (!info.isFile() || info.size > maximum) throw new Error();
		const bytes = Buffer.alloc(Math.min(info.size + 1, maximum + 1));
		let count = 0;
		while (count < bytes.length) {
			const chunk = await handle.read(bytes, count, bytes.length - count, count);
			if (!chunk.bytesRead) break;
			count += chunk.bytesRead;
		}
		if (count !== info.size || count > maximum) throw new Error();
		const json = bytes.subarray(0, count).toString("utf8");
		if (!Buffer.from(json).equals(bytes.subarray(0, count))) throw new Error();
		return JSON.parse(json) as unknown;
	} catch (error) {
		if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw new HarnessError("ATTACHMENT_CORRUPT", "Could not read valid attachment metadata.");
	} finally { await handle?.close(); }
}
