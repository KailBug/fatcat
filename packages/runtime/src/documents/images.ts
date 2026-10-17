import { createCanvas, loadImage } from "@napi-rs/canvas";
import { documentError, documentLimit, documentLimits } from "./limits.js";
import type { DocumentImage } from "./types.js";

function imageDimensions(bytes: Buffer, format: "png" | "jpeg"): { width: number; height: number } {
	if (format === "png") {
		if (bytes.length < 33 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || bytes.toString("ascii", 12, 16) !== "IHDR") {
			documentError("The PNG image header is invalid.");
		}
		return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
	}
	if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8) documentError("The JPEG image header is invalid.");
	let offset = 2;
	while (offset + 4 <= bytes.length) {
		if (bytes[offset] !== 0xff) documentError("The JPEG image marker is invalid.");
		while (bytes[offset] === 0xff) offset++;
		const marker = bytes[offset++]!;
		if (marker === 0xd9 || marker === 0xda) break;
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
		if (offset + 2 > bytes.length) break;
		const length = bytes.readUInt16BE(offset);
		if (length < 2 || offset + length > bytes.length) documentError("The JPEG image segment is truncated.");
		if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
			if (length < 8) documentError("The JPEG dimensions are truncated.");
			return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
		}
		offset += length;
	}
	return documentError("The JPEG image has no supported frame header.");
}

export async function readImage(bytes: Buffer, format: "png" | "jpeg"): Promise<DocumentImage> {
	const dimensions = imageDimensions(bytes, format);
	if (!dimensions.width || !dimensions.height) documentError("The image has empty dimensions.");
	if (dimensions.width * dimensions.height > documentLimits.imagePixels) documentLimit("The image exceeds the 16-million-pixel decoding limit.");
	try {
		const image = await loadImage(bytes);
		if (image.width * image.height > documentLimits.imagePixels) documentLimit("The decoded image exceeds its pixel limit.");
		const scale = Math.min(1, documentLimits.renderSide / Math.max(image.width, image.height), Math.sqrt(documentLimits.renderPixels / (image.width * image.height)));
		const width = Math.max(1, Math.round(image.width * scale));
		const height = Math.max(1, Math.round(image.height * scale));
		const canvas = createCanvas(width, height);
		const context = canvas.getContext("2d");
		context.fillStyle = "white";
		context.fillRect(0, 0, width, height);
		context.drawImage(image, 0, 0, width, height);
		const data = format === "png" ? canvas.toBuffer("image/png") : canvas.toBuffer("image/jpeg", 90);
		if (data.length > documentLimits.renderBytes) documentLimit("The rendered image exceeds the 8 MiB image budget.");
		return { data, mimeType: format === "png" ? "image/png" : "image/jpeg", page: 1, width, height };
	} catch (error) {
		if (error instanceof Error && error.name === "HarnessError") throw error;
		return documentError("The image could not be decoded. It may be corrupt or use unsupported image features.");
	}
}
