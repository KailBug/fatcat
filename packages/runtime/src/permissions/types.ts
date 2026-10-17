import type { BrowserRequest } from "../browser/protocol.js";

export type WorkspacePermission = "ask" | "read-only" | "workspace-write";
export type ShellPermission = "ask" | "deny" | "allow";
export type PermissionMode = "default" | "acceptEdits" | "plan" | "freeToGo";
export type PermissionSelection = PermissionMode | "custom";
export type PermissionState = {
  mode: PermissionSelection;
  permission: WorkspacePermission;
  shellPermission: ShellPermission;
  fileAccess: "workspace" | "unrestricted";
  networkAccess: "public" | "unrestricted";
  availableModes: PermissionMode[];
};
export type PermissionLimits = { readOnly?: boolean; shellDenied?: boolean; webDenied?: boolean };
export type LegacyPermissions = { permission: WorkspacePermission; shellPermission: ShellPermission };

export type WriteApprovalRequest = {
  path: string;
  operation: "create" | "edit";
  oldText?: string;
  newText: string;
  bytes: number;
};
export type ApproveWrite = (request: WriteApprovalRequest, signal?: AbortSignal) => Promise<boolean>;
export type ShellRequest = { command: string; cwd: string; timeoutMs: number; approvalReason?: string };
export type ApproveShell = (request: ShellRequest, signal?: AbortSignal) => Promise<boolean>;
export type ShellOptions = { permission?: ShellPermission; approve?: ApproveShell };
export type ApproveBrowser = (request: BrowserRequest, signal?: AbortSignal) => Promise<boolean>;
export type ApprovalRequests = { write: WriteApprovalRequest; shell: ShellRequest; browser: BrowserRequest };
export type PendingApproval<Requests extends object = ApprovalRequests> = {
  [Kind in keyof Requests & string]: { id: string; kind: Kind; request: Requests[Kind] }
}[keyof Requests & string];
