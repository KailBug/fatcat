import { HarnessError } from "../errors.js";
import type { LegacyPermissions, PermissionLimits, PermissionMode, PermissionSelection, PermissionState,
  ShellPermission, WorkspacePermission } from "./types.js";

export type { PermissionMode, PermissionSelection, PermissionState } from "./types.js";

const modes: Record<PermissionMode, LegacyPermissions> = {
  default: { permission: "ask", shellPermission: "ask" },
  acceptEdits: { permission: "workspace-write", shellPermission: "ask" },
  plan: { permission: "read-only", shellPermission: "deny" },
  freeToGo: { permission: "workspace-write", shellPermission: "allow" },
};
const modeNames: PermissionMode[] = ["default", "acceptEdits", "plan", "freeToGo"];

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === "string" && modeNames.includes(value as PermissionMode);
}

function modePermissions(mode: PermissionMode): LegacyPermissions {
  if (!isPermissionMode(mode)) throw new HarnessError("CONFIG", "Permission mode must be default, acceptEdits, plan, or freeToGo.");
  return { ...modes[mode] };
}

function validate({ permission, shellPermission }: LegacyPermissions): void {
  if (!["ask", "read-only", "workspace-write"].includes(permission)) {
    throw new HarnessError("CONFIG", "Workspace permission must be ask, read-only, or workspace-write.");
  }
  if (!["ask", "deny", "allow"].includes(shellPermission)) {
    throw new HarnessError("CONFIG", "Shell permission must be ask, deny, or allow.");
  }
  if (permission === "read-only" && shellPermission !== "deny") {
    throw new HarnessError("CONFIG", "Read-only access cannot authorize shell execution.");
  }
}

/** One live policy belongs to the shared tool set; saved sessions never restore it. */
export class PermissionPolicy {
  private permissions: LegacyPermissions;
  private mode: PermissionSelection;
  private readonly limits: PermissionLimits;
  private operations = 0;

  constructor(initial: PermissionMode | LegacyPermissions, limits: PermissionLimits = {}) {
    this.limits = { ...limits };
    this.permissions = typeof initial === "string" ? modePermissions(initial) : { ...initial };
    validate(this.permissions);
    // Legacy allow flags keep their original workspace/public scopes; broad access is explicit.
    this.mode = typeof initial === "string" ? initial : modeNames.find((name) => name !== "freeToGo" && modes[name].permission === this.permissions.permission
      && modes[name].shellPermission === this.permissions.shellPermission) ?? "custom";
    this.requireWithinLimits(this.permissions, this.mode);
  }

  snapshot(): PermissionState {
    return { mode: this.mode, ...this.permissions, fileAccess: this.mode === "freeToGo" ? "unrestricted" : "workspace",
      networkAccess: this.mode === "freeToGo" ? "unrestricted" : "public",
      availableModes: this.availableModes() };
  }

  availableModes(): PermissionMode[] { return modeNames.filter((name) => this.withinLimits(modes[name], name)); }

  select(mode: PermissionMode): void {
    const next = modePermissions(mode);
    if (this.operations) throw new HarnessError("SESSION_BUSY", "Finish the active tool operation before changing permissions.");
    this.requireWithinLimits(next, mode);
    this.permissions = next;
    this.mode = mode;
  }

  /** Keep authorization stable through path checks, approval and side effects. */
  beginOperation(): PermissionState & { release: () => void } {
    const state = this.snapshot();
    this.operations++;
    let released = false;
    return { ...state, release: () => {
      if (!released) { released = true; this.operations--; }
    } };
  }

  private withinLimits(value: LegacyPermissions, mode: PermissionSelection): boolean {
    return (!this.limits.readOnly || value.permission === "read-only" && value.shellPermission === "deny")
      && (!this.limits.shellDenied || value.shellPermission === "deny")
      && (!this.limits.webDenied || mode !== "freeToGo");
  }

  private requireWithinLimits(value: LegacyPermissions, mode: PermissionSelection): void {
    if (!this.withinLimits(value, mode)) {
      throw new HarnessError("PERMISSION_DENIED", "This permission mode exceeds the explicit launch restrictions.");
    }
  }
}

export function writeDecision(permission: WorkspacePermission, hasApproval: boolean): "allow" | "ask" | "deny" {
  return permission === "workspace-write" ? "allow" : permission === "ask" && hasApproval ? "ask" : "deny";
}

export function shellDecision(permission: ShellPermission, hasApproval: boolean): "allow" | "ask" | "deny" {
  return permission === "allow" ? "allow" : permission === "ask" && hasApproval ? "ask" : "deny";
}
