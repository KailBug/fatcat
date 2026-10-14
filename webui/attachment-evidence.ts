import type { Message } from "../src/model.js";

export interface AttachmentReadEvidence {
	origin: "parent" | "subagent";
	name: string;
	reference: string;
	mode: string;
	summary: string;
	citations: { reference: string; label: string }[];
	warnings: string[];
	omittedLocations: number;
}

export interface AttachmentEvidence {
	reads: AttachmentReadEvidence[];
	omittedReads: number;
}

const originalReference = /^attachment:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}@[0-9a-f]{64}$/;

function object(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function count(value: unknown): number {
	return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 12).map((item) => item.slice(0, 1024)) : [];
}

function readEvidence(value: unknown, origin: AttachmentReadEvidence["origin"]): AttachmentReadEvidence | undefined {
	const result = object(value);
	if (!result || typeof result.path !== "string" || !originalReference.test(result.path)
		|| typeof result.name !== "string" || !["file", "search", "document"].includes(String(result.kind))) return undefined;
	const path = result.path;
	const coverage = object(result.coverage);
	const citations: AttachmentReadEvidence["citations"] = [];
	let sourceLocations = 0;
	const addCitation = (value: unknown, label: string) => {
		if (typeof value !== "string" || !value.startsWith(`${path}#`) || value.length > 400) return;
		const fragment = value.slice(path.length);
		if (!/^#(?:L[1-9][0-9]*-L[1-9][0-9]*|parse=[a-zA-Z0-9._-]{1,96}&unit=[a-zA-Z0-9._-]{1,96})$/.test(fragment)) return;
		sourceLocations++;
		if (citations.length < 8) citations.push({ reference: value, label: label.slice(0, 160) });
	};
	let summary: string;
	let mode: string;
	let warnings = strings(result.warnings);
	if (result.kind === "document") {
		mode = typeof coverage?.mode === "string" ? coverage.mode : "document";
		summary = `${count(coverage?.returnedUnits)} of ${count(coverage?.selectedUnits)} selected locations returned; ${count(coverage?.totalUnits)} locations in the document. `
			+ (coverage?.complete === true ? "The selected parsed content was covered by this read." : `${count(coverage?.unreadUnits)} locations were unread or unavailable.`);
		warnings = [...warnings, ...strings(coverage?.uncovered)].slice(0, 12);
		if (Array.isArray(result.units)) for (const value of result.units) {
			const unit = object(value);
			if (!unit) continue;
			const location = object(unit.location);
			const label = location?.sheet && location.cell ? `${String(location.sheet)}!${String(location.cell)}`
				: location?.page ? `Page ${String(location.page)}` : location?.slide ? `Slide ${String(location.slide)}`
				: location?.paragraph ? `Paragraph ${String(location.paragraph)}` : String(unit.id ?? "Source");
			addCitation(unit.citation, `${label} · ${String(unit.provenance ?? "document")}`);
		}
	} else if (result.kind === "search") {
		mode = "literal-search";
		const matches = Array.isArray(result.matches) ? result.matches : [];
		summary = `${Math.max(matches.length, count(result.sourceLocationCount))} of ${count(result.totalMatches)} matching lines returned. Search does not establish full reading or analysis.`;
		for (const value of matches) { const match = object(value); if (match) addCitation(match.citation, `Line ${count(match.line)}`); }
	} else {
		mode = "lines";
		summary = result.startLine === null ? `No text lines returned (${count(result.totalLines)} total).`
			: `Lines ${count(result.startLine)}–${count(result.endLine)} of ${count(result.totalLines)} returned. `
				+ (coverage?.complete === true ? "The full text was returned by this read." : "Other lines were outside this read.");
		addCitation(result.citation, `Lines ${count(result.startLine)}–${count(result.endLine)}`);
	}
	return { origin, name: result.name.slice(0, 256), reference: path, mode, summary, citations, warnings,
		omittedLocations: Math.max(sourceLocations, count(result.sourceLocationCount)) - citations.length };
}

/** Reconstruct evidence from actual read results, without trusting claims in the answer. */
export function attachmentEvidence(messages: readonly Message[]): AttachmentEvidence {
	const reads: AttachmentReadEvidence[] = [];
	const calls = new Map<string, "read" | "delegate_task">();
	let omittedReads = 0;
	const append = (result: unknown, origin: AttachmentReadEvidence["origin"]) => {
		const evidence = readEvidence(result, origin);
		if (!evidence) return;
		if (reads.length < 100) reads.push(evidence);
		else omittedReads++;
	};
	for (const message of messages) {
		if (message.role === "assistant") for (const call of message.tool_calls ?? []) {
			if (call.type === "function" && (call.function.name === "read" || call.function.name === "delegate_task")) calls.set(call.id, call.function.name);
		}
		if (message.role !== "tool" || typeof message.content !== "string") continue;
		const name = calls.get(message.tool_call_id);
		if (!name) continue;
		calls.delete(message.tool_call_id);
		try {
			const value = object(JSON.parse(message.content));
			if (value?.ok !== true) continue;
			if (name === "read") append(value.result, "parent");
			else {
				const result = object(value.result);
				if (!Array.isArray(result?.attachmentReads)) continue;
				for (const read of result.attachmentReads) append(read, "subagent");
				omittedReads += count(result.omittedAttachmentReads);
			}
		} catch { /* Invalid old tool data does not become evidence. */ }
	}
	return { reads, omittedReads };
}
