import { quoted } from "../utils/command.js";
import type { SessionSummary } from "@fatcat/runtime/session/record";

export function sessionLabel(summary: SessionSummary): string {
	return `${summary.id}${summary.name ? ` (${quoted(summary.name)})` : ""}`;
}

export function sessionScopeLabel(summary: SessionSummary): string {
	return summary.projectId ? `Project: ${summary.projectName ? `${quoted(summary.projectName)} ` : ""}(${summary.projectId})`
		+ (summary.projectError ? ` | unavailable: ${quoted(summary.projectError)}` : "")
		: "Standalone session";
}

export function formatSessionList(sessions: readonly SessionSummary[], activeId?: string): string {
	if (!sessions.length) return "No saved sessions.";
	return sessions.map((session) => `${session.id === activeId ? "*" : " "} ${sessionLabel(session)} | `
		+ `${session.turnCount} saved turns | ${session.updatedAt} | ${quoted(session.title)} | ${quoted(session.workspace)} | ${sessionScopeLabel(session)}`
		+ `${session.interrupted ? " | interrupted" : ""}${session.automationCount ? ` | [clock] ${session.automationCount} automation(s)` : ""}`).join("\n");
}
