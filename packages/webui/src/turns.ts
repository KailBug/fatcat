import type { ReportEvent } from "@fatcat/runtime/execution-report";
import type { Message } from "@fatcat/runtime/model-types";
import { attachmentEvidence } from "./attachment-evidence.js";
import type { WebTurn } from "./types.js";

/** Format one event; the controller owns event traversal and display state updates. */
export function activityMessage(event: ReportEvent, child: boolean): string | undefined {
	const source = child ? "Subagent · " : "";
	switch (event.type) {
		case "model_request": {
			const label = event.purpose === "compaction" ? "Summary" : event.purpose === "document" ? "Document" : "Model";
			return `${source}${label} request ${event.iteration}`;
		}
		case "compaction_start":
			return "Request limit reached; compacting older turns";
		case "compaction_end":
			return `Context compacted: ${event.beforeBytes} to ${event.afterBytes} conversation bytes; continuing current request`;
		case "tool_result":
			return `${source}${event.tool} · ${event.ok ? "completed" : "failed"}`;
		case "write_record":
			return `${source}Write ${event.record.path} · ${event.record.status}`;
		case "shell_record":
			return `${source}Command · ${event.record.status}`;
		case "browser_record":
			return `${source}Browser ${event.record.path} · ${event.record.status}`;
		default:
			return undefined;
	}
}

/** Recover user text and final answers; approval state and UI telemetry are process-local. */
export function restoredTurns(history: readonly Message[], sessionId: string): WebTurn[] {
	const turns: WebTurn[] = [];
	let prompt: string | undefined;
	let start = 0;
	for (const [index, message] of history.entries()) {
		if (message.role === "user" && typeof message.content === "string") {
			prompt = message.content;
			start = index;
		}
		if (message.role === "assistant" && !message.toolCalls?.length && typeof message.content === "string" && prompt !== undefined) {
			turns.push({
				id: `${sessionId}:${turns.length}`,
				prompt,
				answer: message.content,
				status: "answered",
				activity: [],
				sources: attachmentEvidence(history.slice(start, index + 1)),
			});
			prompt = undefined;
		}
	}
	return turns;
}
