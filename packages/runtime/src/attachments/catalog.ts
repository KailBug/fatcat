import { join } from "node:path";
import { atomicJson, boundedJson } from "../metadata/files.js";
import { decodeAttachmentCatalog, emptyAttachmentCatalog } from "./record.js";
import type { AttachmentCatalog } from "./record.js";

export const maxCatalogBytes = 16 * 1024 * 1024;

/** Callers hold the metadata gate; catalog IO does not own locks or association policy. */
export async function readAttachmentCatalog(directory: string): Promise<AttachmentCatalog> {
	const value = await boundedJson(join(directory, "catalog.json"), maxCatalogBytes, true);
	return value === undefined ? emptyAttachmentCatalog() : decodeAttachmentCatalog(value);
}

export async function publishAttachmentCatalog(directory: string, catalog: AttachmentCatalog): Promise<void> {
	await atomicJson(join(directory, "catalog.json"), decodeAttachmentCatalog(catalog), maxCatalogBytes);
}
