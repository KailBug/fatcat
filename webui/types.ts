import type { SessionAutomation } from "../src/automation/tasks.js";
import type { ExecutionReport } from "../src/execution-report.js";
import type { PendingApproval } from "../src/permissions/types.js";
import type { PermissionPolicy } from "../src/permissions/policy.js";
import type { ProjectRecord } from "../src/project/record.js";
import type { SessionSummary } from "../src/session/record.js";
import type { AttachmentEvidence } from "./attachment-evidence.js";
import type { ContextUsage } from "./context-usage.js";

export interface WebUiInfo {
	provider: string;
	model: string;
	workspace: string;
	permission: string;
	shellPermission: string;
	webPermission: string;
	maxIterations: number;
	maxRequestBytes: number;
	skills: number;
	warnings: string[];
}

/** Display state only; Session history remains the source of conversation data. */
export interface WebTurn {
	id: string;
	prompt: string;
	answer?: string;
	error?: string;
	status: "running" | "answered" | "stopped";
	activity: string[];
	report?: ExecutionReport;
	automation?: boolean;
	contextOperation?: boolean;
	sources?: AttachmentEvidence;
}

export interface WebUiState {
	revision: number;
	info: WebUiInfo;
	turns: WebTurn[];
	busy: boolean;
	approval: PendingApproval | null;
	status: string;
	current: SessionSummary;
	sessions: SessionSummary[];
	persistent: boolean;
	contextUsage: ContextUsage;
	permissionMode: ReturnType<PermissionPolicy["snapshot"]>;
	automations: SessionAutomation[];
	automationNotice: string;
	runningSessionId: string | null;
	projects: ProjectRecord[];
	attachmentRevision: number;
}
