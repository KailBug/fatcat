import { randomUUID } from "node:crypto";
import { HarnessError } from "../errors.js";
import type { ApprovalRequests, PendingApproval } from "./types.js";

export type { PendingApproval } from "./types.js";

/** One pending operation, answered once; approvals never survive cancellation or a new request. */
export class ApprovalCoordinator<Requests extends object = ApprovalRequests> {
  private pending: { approval: PendingApproval<Requests>; finish: (allowed: boolean) => void } | undefined;

  constructor(private readonly onChange?: () => void) {}

  snapshot(): PendingApproval<Requests> | null { return this.pending ? structuredClone(this.pending.approval) : null; }

  request<Kind extends keyof Requests & string>(kind: Kind, request: Requests[Kind], signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    if (this.pending) throw new HarnessError("APPROVAL_BUSY", "Another operation is awaiting approval.");
    const approval = structuredClone({ id: randomUUID(), kind, request }) as PendingApproval<Requests>;
    return new Promise((resolve) => {
      const cancel = () => finish(false);
      const finish = (allowed: boolean) => {
        signal?.removeEventListener("abort", cancel);
        this.pending = undefined;
        resolve(allowed);
        this.onChange?.();
      };
      this.pending = { approval, finish };
      signal?.addEventListener("abort", cancel, { once: true });
      this.onChange?.();
    });
  }

  approve(id: string, allowed: boolean): void {
    if (this.pending?.approval.id !== id) throw new HarnessError("STALE_APPROVAL", "This approval is no longer pending.");
    this.pending.finish(allowed);
  }

  deny(): void { this.pending?.finish(false); }
}

