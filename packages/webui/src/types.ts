import type { SessionAutomation } from "@fatcat/runtime/automation/tasks";
import type { ExecutionReport } from "@fatcat/runtime/execution-report";
import type { PendingApproval } from "@fatcat/runtime/permissions/types";
import type { PermissionPolicy } from "@fatcat/runtime/permissions/policy";
import type { ProjectRecord } from "@fatcat/runtime/project/record";
import type { SessionSummary } from "@fatcat/runtime/session/record";
import type { AttachmentEvidence } from "./attachment-evidence.js";
import type { ContextUsageSnapshot } from "@fatcat/runtime/context/usage";
import type { ModelChoice } from "@fatcat/runtime/model-connections";

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
	contextUsage: ContextUsageSnapshot | null;
	modelChoices: ModelChoice[];
	permissionMode: ReturnType<PermissionPolicy["snapshot"]>;
	automations: SessionAutomation[];
	automationNotice: string;
	runningSessionId: string | null;
	projects: ProjectRecord[];
	attachmentRevision: number;
}
