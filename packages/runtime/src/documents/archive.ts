import { inflateRawSync } from "node:zlib";
import { documentError, documentLimit, documentLimits } from "./limits.js";

interface ZipEntry {
	name: string;
	flags: number;
	method: number;
	crc: number;
	compressedSize: number;
	size: number;
	start: number;
}

const crcTable = Array.from({ length: 256 }, (_, value) => {
	for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
	return value >>> 0;
});

function crc32(bytes: Buffer): number {
	let value = 0xffffffff;
	for (const byte of bytes) value = crcTable[(value ^ byte) & 0xff]! ^ (value >>> 8);
	return (value ^ 0xffffffff) >>> 0;
}

/** Read only declared package parts; never extract filenames to the filesystem. */
export class DocumentArchive {
	private readonly entries = new Map<string, ZipEntry>();
	private expandedBytes = 0;
	private readonly decoded = new Map<string, Buffer>();

	constructor(private readonly bytes: Buffer) {
		let end = -1;
		for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 65557); index--) {
			if (bytes.readUInt32LE(index) === 0x06054b50 && index + 22 + bytes.readUInt16LE(index + 20) === bytes.length) {
				end = index;
				break;
			}
		}
		if (end < 0) documentError("The Office file is not a valid ZIP package. Encrypted Office files are not supported.");
		const count = bytes.readUInt16LE(end + 10);
		const directorySize = bytes.readUInt32LE(end + 12);
		let offset = bytes.readUInt32LE(end + 16);
		if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count
			|| count === 0xffff || offset === 0xffffffff || directorySize === 0xffffffff || offset + directorySize !== end) {
			documentError("Split, ZIP64, or malformed Office packages are not supported.");
		}
		if (count > documentLimits.zipEntries) documentLimit("The Office package exceeds the 2000-part limit.");
		const directoryStart = offset;
		let declaredBytes = 0;
		for (let index = 0; index < count; index++) {
			if (offset + 46 > end || bytes.readUInt32LE(offset) !== 0x02014b50) documentError("Invalid Office package directory.");
			const flags = bytes.readUInt16LE(offset + 8);
			const method = bytes.readUInt16LE(offset + 10);
			const crc = bytes.readUInt32LE(offset + 16);
			const compressedSize = bytes.readUInt32LE(offset + 20);
			const size = bytes.readUInt32LE(offset + 24);
			const nameLength = bytes.readUInt16LE(offset + 28);
			const extraLength = bytes.readUInt16LE(offset + 30);
			const commentLength = bytes.readUInt16LE(offset + 32);
			const localOffset = bytes.readUInt32LE(offset + 42);
			const next = offset + 46 + nameLength + extraLength + commentLength;
			if (next > end || localOffset + 30 > directoryStart || bytes.readUInt32LE(localOffset) !== 0x04034b50) {
				documentError("Invalid Office package entry.");
			}
			if (flags & 1) documentError("Encrypted Office package parts are not supported.");
			if (method !== 0 && method !== 8) documentError("The Office package uses an unsupported compression method.");
			const name = bytes.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
			if (!name || name.includes("\\") || name.startsWith("/") || name.split("/").includes("..") || name.includes("\0")
				|| this.entries.has(name) || Buffer.from(name).length !== nameLength) documentError("Invalid or duplicate Office package part name.");
			const localNameLength = bytes.readUInt16LE(localOffset + 26);
			const localExtraLength = bytes.readUInt16LE(localOffset + 28);
			const start = localOffset + 30 + localNameLength + localExtraLength;
			if (start + compressedSize > directoryStart || bytes.readUInt16LE(localOffset + 8) !== method
				|| bytes.readUInt16LE(localOffset + 6) !== flags
				|| bytes.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString("utf8") !== name) {
				documentError("Inconsistent Office package entry.");
			}
			declaredBytes += size;
			if (declaredBytes > documentLimits.expandedBytes) documentLimit("The Office package exceeds the 32 MiB expanded-size limit.");
			this.entries.set(name, { name, flags, method, crc, compressedSize, size, start });
			offset = next;
		}
		if (offset !== end) documentError("Invalid Office package directory length.");
		if ([...this.entries.keys()].some((name) => /vbaProject\.bin$/i.test(name))) documentError("Macro-enabled Office packages are not supported.");
	}

	has(name: string): boolean {
		return this.entries.has(name);
	}

	names(): string[] {
		return [...this.entries.keys()];
	}

	read(name: string): Buffer {
		const previous = this.decoded.get(name);
		if (previous) return previous;
		const entry = this.entries.get(name);
		if (!entry) documentError(`Required Office part is missing: ${name}.`);
		if (entry.size > documentLimits.xmlBytes) documentLimit("An Office XML part exceeds the 8 MiB limit.");
		let result: Buffer;
		try {
			const compressed = this.bytes.subarray(entry.start, entry.start + entry.compressedSize);
			result = entry.method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: Math.min(entry.size + 1, documentLimits.xmlBytes) });
		} catch {
			return documentError("An Office package part could not be decompressed within its declared limit.");
		}
		if (result.length !== entry.size || crc32(result) !== entry.crc) documentError("An Office package part failed its size or checksum verification.");
		this.expandedBytes += result.length;
		if (this.expandedBytes > documentLimits.expandedBytes) documentLimit("The Office package exceeds the expanded-size limit.");
		this.decoded.set(name, result);
		return result;
	}
}
