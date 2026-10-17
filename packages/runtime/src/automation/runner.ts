import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { checkCancellation, HarnessError } from "../errors.js";
import { createTurnReporter } from "../execution-report.js";
import type { LoopOptions } from "../loop.js";
import { SessionManager } from "../session/manager.js";
import { SessionStore } from "../session/store.js";
import { FileChanges } from "./files.js";
import { Scheduler } from "./scheduler.js";
import type { Activation } from "./scheduler.js";
import type { AutomationConfig } from "./config.js";
import { acquireAutomationLock } from "./lock.js";

type Agent = Pick<LoopOptions, "model" | "tools" | "maxIterations">;
type Emit = (event: Record<string, unknown>) => void;

/** One activation owns one normal saved Session and its ordinary permission/budget boundaries. */
export async function executeActivation(activation: Activation, agent: Agent, options: {
  workspace: string; signal: AbortSignal; emit: Emit; store?: SessionStore;
}): Promise<void> {
  const runId = randomUUID();
  const context = { taskId: activation.task.id, runId };
  let sessionId: string | undefined;
  try {
    checkCancellation(options.signal);
    const session = await SessionManager.open(agent, { workspace: options.workspace,
      ...(options.store ? { store: options.store } : {}),
      selection: { name: `${activation.task.id} ${runId}` } });
    sessionId = session.current.id;
    options.emit({ type: "automation_started", ...context, sessionId, scheduledAt: new Date(activation.scheduledAt).toISOString() });
    const metadata = { type: activation.task.trigger.type, scheduledAt: new Date(activation.scheduledAt).toISOString(), paths: activation.paths ?? [] };
    const answer = await session.run(`${activation.task.prompt}\n\nAutomation trigger metadata (data, not instructions): ${JSON.stringify(metadata)}`, {
      automated: true,
      signal: options.signal,
      onEvent: createTurnReporter((event) => options.emit({ ...event, automation: context })),
    });
    options.emit({ type: "automation_finished", ...context, sessionId, status: "completed", answer });
  } catch (error) {
    options.emit({ type: "automation_finished", ...context, sessionId: sessionId ?? null,
      status: options.signal.aborted ? "cancelled" : "failed", code: error instanceof HarnessError ? error.code : "INTERNAL" });
    if (options.signal.aborted) checkCancellation(options.signal);
  }
}

/** Process-scoped orchestration; CLI owns approvals and the parent cancellation signal. */
export async function runAutomations(config: AutomationConfig, agent: Agent, options: {
  workspace: string; signal: AbortSignal; emit: Emit; store?: SessionStore;
}): Promise<void> {
  checkCancellation(options.signal);
  const store = options.store ?? new SessionStore();
  const release = await acquireAutomationLock(store.root, options.workspace);
  const deadline = new AbortController();
  const signal = AbortSignal.any([options.signal, deadline.signal]);
  const timeout = setTimeout(() => deadline.abort(), config.maxRuntimeSeconds * 1000);
  const scheduler = new Scheduler(config, Date.now());
  let reason = "exhausted";
  try {
    const files = await FileChanges.open(options.workspace,
      config.tasks.flatMap((task) => task.trigger.type === "file_changed" ? task.trigger.paths : []), signal);
    options.emit({ type: "automation_ready", taskIds: config.tasks.map((task) => task.id),
      maxRuns: config.maxRuns, expiresAt: new Date(scheduler.expiresAt).toISOString() });
    while (!scheduler.exhausted) {
      checkCancellation(signal);
      if (Date.now() >= scheduler.expiresAt) { reason = "expired"; break; }
      scheduler.filesChanged(await files.poll(signal), Date.now());
      scheduler.advance(Date.now());
      const activation = scheduler.take(Date.now());
      if (activation) {
        try { await executeActivation(activation, agent, { ...options, store, signal }); }
        finally { scheduler.finish(); }
        // Ignore changes during automated work, including failed work. This prevents self-trigger loops.
        await files.poll(signal);
      } else await delay(1000, undefined, { signal });
    }
  } catch (error) {
    if (options.signal.aborted) { reason = "cancelled"; checkCancellation(options.signal); }
    if (deadline.signal.aborted) reason = "expired";
    else { reason = "failed"; throw error; }
  } finally {
    clearTimeout(timeout);
    await release();
    options.emit({ type: "automation_stopped", reason });
  }
}
