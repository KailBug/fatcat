import { createHash } from "node:crypto";
import { join } from "node:path";
import { atomicJson, boundedJson } from "../metadata/files.js";
import { HarnessError } from "../errors.js";
import type { DocumentLocation, ParsedDocument } from "./types.js";

export interface SourceUnit {
	id: string;
	text: string;
	location: DocumentLocation;
	provenance: "native-text" | "model-transcription" | "model-description";
	model?: string;
	provider?: string;
}

export interface DocumentSnapshot {
	parserVersion: string;
	baseParserVersion: string;
	format: string;
	units: SourceUnit[];
	totalUnits: number;
	warnings: string[];
}

export const documentKeyPattern = /^[a-zA-Z0-9._-]{1,96}(?![\s\S])/;
const maxSnapshotBytes = 8 * 1024 * 1024;
const maxCacheBytes = 32 * 1024 * 1024;
const maxSnapshots = 64;

interface CacheIndex { versions: string[]; transcripts: Record<string, string>; }

/** Every operation runs inside the attachment owner's authorization/metadata gate. */
export interface DocumentCache {
	load(version: string): Promise<DocumentSnapshot | undefined>;
	transcripts(): Promise<DocumentSnapshot[]>;
	save(snapshot: DocumentSnapshot, transcriptPage?: number): Promise<DocumentSnapshot>;
}

export function documentSnapshot(document: ParsedDocument): DocumentSnapshot {
	let expandedMetadata = false;
	const units = document.units.flatMap((unit) => {
		const location = { ...unit.location };
		const details: SourceUnit[] = [];
		for (const field of ["rawValue", "formula", "cachedValue"] as const) {
			const value = location[field];
			if (value === undefined || Buffer.byteLength(value) <= 1024) continue;
			delete location[field];
			const parts = splitSourceText(value);
			expandedMetadata = true;
			parts.forEach((text, index) => details.push({ id: `${unit.id}-${field}-${index + 1}`, text: `${field} (part ${index + 1} of ${parts.length}): ${text}`,
				location, provenance: "native-text" }));
		}
		if (Buffer.byteLength(JSON.stringify(location)) > 4096) throw new HarnessError("DOCUMENT_LIMIT", "One source location or heading exceeds 4096 bytes. Export this content as plain text for bounded reading.");
		const pieces = splitSourceText(unit.text);
		return [...(pieces.length < 2 ? [{ ...unit, location }] : pieces.map((text, index) => ({ ...unit, location, id: `${unit.id}-part-${index + 1}`, text }))), ...details];
	});
	return { ...document, units, totalUnits: units.length, baseParserVersion: document.parserVersion,
		warnings: [...document.warnings, ...(expandedMetadata ? ["Large raw cell values, formulas, or formula caches appear as labeled continuation units at the same cell; these fields are omitted from compact location metadata, not truncated."] : [])] };
}

export function splitSourceText(text: string): string[] {
	const pieces: string[] = [];
	let current = "";
	let size = 0;
	for (const character of text) {
		const bytes = Buffer.byteLength(JSON.stringify(character)) - 2;
		if (size + bytes > 8000) { pieces.push(current); current = ""; size = 0; }
		current += character;
		size += bytes;
	}
	if (current || !pieces.length) pieces.push(current);
	return pieces;
}

export function derivedSnapshot(base: DocumentSnapshot, units: SourceUnit[], warnings: string[]): DocumentSnapshot {
	const body = { baseParserVersion: base.baseParserVersion, format: base.format, units, totalUnits: units.length, warnings };
	return { parserVersion: `derived-${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`, ...body };
}

function validateSnapshot(value: unknown, version: string): DocumentSnapshot {
	if (!documentKeyPattern.test(version) || !value || typeof value !== "object") throw corrupt();
	const data = value as DocumentSnapshot;
	if (data.parserVersion !== version || !documentKeyPattern.test(data.baseParserVersion)
		|| typeof data.format !== "string" || !Array.isArray(data.units) || data.units.length > 20000
		|| data.totalUnits !== data.units.length || !Array.isArray(data.warnings) || data.warnings.some((item) => typeof item !== "string")
		|| data.units.some((unit) => !unit || !documentKeyPattern.test(unit.id) || typeof unit.text !== "string"
			|| !unit.location || typeof unit.location !== "object"
			|| !["native-text", "model-transcription", "model-description"].includes(unit.provenance)
			|| (unit.model !== undefined && typeof unit.model !== "string") || (unit.provider !== undefined && typeof unit.provider !== "string"))
		|| new Set(data.units.map((unit) => unit.id)).size !== data.units.length) throw corrupt();
	if (version.startsWith("derived-") && derivedSnapshot(data, data.units, data.warnings).parserVersion !== version) throw corrupt();
	if (Buffer.byteLength(JSON.stringify(data)) > maxSnapshotBytes) throw new HarnessError("DOCUMENT_LIMIT", "Parsed content exceeds the 8 MiB snapshot limit.");
	return data;
}

function corrupt(): HarnessError { return new HarnessError("DOCUMENT_CACHE", "The saved document parse is invalid. Its source cannot be silently replaced by a different parse."); }

function validateIndex(value: unknown): CacheIndex {
	if (value === undefined) return { versions: [], transcripts: {} };
	if (!value || typeof value !== "object") throw corrupt();
	const index = value as CacheIndex;
	if (!Array.isArray(index.versions) || index.versions.length > maxSnapshots || index.versions.some((key) => typeof key !== "string" || !documentKeyPattern.test(key))
		|| !index.transcripts || typeof index.transcripts !== "object" || Array.isArray(index.transcripts)
		|| Object.entries(index.transcripts).some(([page, key]) => !/^[1-9][0-9]{0,3}$/.test(page) || !index.versions.includes(key))) throw corrupt();
	return index;
}

export function diskDocumentCache(directory: string): DocumentCache {
	const indexPath = join(directory, "index.json");
	const index = async () => validateIndex(await boundedJson(indexPath, 32768, true));
	const load = async (version: string) => {
		if (!documentKeyPattern.test(version)) throw corrupt();
		const value = await boundedJson(join(directory, `${version}.json`), maxSnapshotBytes, true);
		return value === undefined ? undefined : validateSnapshot(value, version);
	};
	return {
		load,
		transcripts: async () => {
			const saved = await index();
			const result: DocumentSnapshot[] = [];
			for (const version of Object.values(saved.transcripts)) {
				const value = await load(version);
				if (!value) throw corrupt();
				result.push(value);
			}
			return result;
		},
		save: async (snapshot, page) => {
			validateSnapshot(snapshot, snapshot.parserVersion);
			const saved = await index();
			const existing = await load(snapshot.parserVersion);
			if (existing && JSON.stringify(existing) !== JSON.stringify(snapshot)) throw corrupt();
			if (existing && saved.versions.includes(snapshot.parserVersion)) {
				if (page !== undefined) saved.transcripts[String(page)] = snapshot.parserVersion;
				await atomicJson(indexPath, saved, 32768);
				return existing;
			}
			if (saved.versions.length >= maxSnapshots) throw new HarnessError("DOCUMENT_LIMIT", "This original has reached its 64 retained parse/recognition versions. Existing citations remain available.");
			let size = Buffer.byteLength(JSON.stringify(snapshot));
			for (const version of saved.versions) size += Buffer.byteLength(JSON.stringify(await load(version)));
			if (size > maxCacheBytes) throw new HarnessError("DOCUMENT_LIMIT", "Derived content for this original exceeds 32 MiB. Existing citations remain available.");
			if (!existing) await atomicJson(join(directory, `${snapshot.parserVersion}.json`), snapshot, maxSnapshotBytes);
			saved.versions.push(snapshot.parserVersion);
			if (page !== undefined) saved.transcripts[String(page)] = snapshot.parserVersion;
			await atomicJson(indexPath, saved, 32768);
			return snapshot;
		},
	};
}

export class MemoryDocumentCache implements DocumentCache {
	private readonly snapshots = new Map<string, DocumentSnapshot>();
	private readonly pages = new Map<number, string>();
	get size(): number { return Buffer.byteLength(JSON.stringify([...this.snapshots.values()])); }
	async load(version: string): Promise<DocumentSnapshot | undefined> { return structuredClone(this.snapshots.get(version)); }
	async transcripts(): Promise<DocumentSnapshot[]> { return structuredClone([...this.pages.values()].map((version) => this.snapshots.get(version)!)); }
	async save(snapshot: DocumentSnapshot, page?: number): Promise<DocumentSnapshot> {
		validateSnapshot(snapshot, snapshot.parserVersion);
		const existing = this.snapshots.get(snapshot.parserVersion);
		if (existing) {
			if (JSON.stringify(existing) !== JSON.stringify(snapshot)) throw corrupt();
			if (page !== undefined) this.pages.set(page, snapshot.parserVersion);
			return structuredClone(existing);
		}
		if (this.snapshots.size >= maxSnapshots || this.size + Buffer.byteLength(JSON.stringify(snapshot)) > maxCacheBytes) {
			throw new HarnessError("DOCUMENT_LIMIT", "Derived content exceeds this original's 64-version or 32 MiB cache limit.");
		}
		this.snapshots.set(snapshot.parserVersion, structuredClone(snapshot));
		if (page !== undefined) this.pages.set(page, snapshot.parserVersion);
		return structuredClone(snapshot);
	}
}
