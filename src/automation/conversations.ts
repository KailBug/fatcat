import type { SessionManager } from "../session/manager.js";
import { HarnessError } from "../errors.js";
import { Scheduler } from "./scheduler.js";
import { FileChanges } from "./files.js";
import { acquireAutomationLock } from "./lock.js";
import { taskIsEnabled } from "./tasks.js";
import type { SessionAutomation } from "./tasks.js";
import type { Activation } from "./scheduler.js";

type Entry = { signature: string; scheduler: Scheduler; files: FileChanges };

/** Shared live-session trigger source; each interface retains turn rendering and approval ownership. */
export class ConversationAutomations {
  private readonly entries = new Map<string, Entry>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private active: Promise<void> | undefined;
  private closed = false;
  private release: (() => Promise<void>) | undefined;
  private readonly abort = new AbortController();
  private notifiedError = "";
  private lastRun: string | undefined;

  constructor(private readonly session: SessionManager, private readonly host: {
    idle: () => boolean;
    run: (task: SessionAutomation, activation: Activation) => Promise<void>;
    changed: () => void | Promise<void>;
    error: (message: string) => void;
  }) {}

  start(): void {
    if (this.timer || this.closed) return;
    this.timer = setInterval(() => { void this.tick(); }, 1000);
    this.timer.unref();
  }

  async tick(): Promise<void> {
    if (this.active || this.closed || !this.host.idle() || this.session.isBusy) return;
    this.active = this.poll().catch((error: unknown) => {
      const message = error instanceof HarnessError ? error.message : "Automation polling failed. Check session storage and watched files.";
      if (!this.closed && message !== this.notifiedError) { this.notifiedError = message; this.host.error(message); }
    }).finally(() => { this.active = undefined; });
    await this.active;
  }

  private async poll(): Promise<void> {
    const tasks = (await this.session.listAutomations()).filter((task) => taskIsEnabled(task) && task.lastStatus !== "running");
    const live = new Set(tasks.map((task) => task.id));
    for (const id of this.entries.keys()) if (!live.has(id)) this.entries.delete(id);
    if (!tasks.length) return;
    if (tasks.length > 128) throw new HarnessError("AUTOMATION_LIMIT", "Pause tasks to keep at most 128 enabled tasks in this workspace.");
    if (new Set(tasks.flatMap((task) => task.trigger.type === "file_changed" ? task.trigger.paths : [])).size > 64) {
      throw new HarnessError("AUTOMATION_LIMIT", "Pause file tasks to monitor at most 64 different files in this workspace.");
    }
    if (!this.release) this.release = await acquireAutomationLock(this.session.automationStoreRoot, this.session.automationWorkspace);
    for (const task of tasks) {
      if (this.closed || !this.host.idle() || this.session.isBusy) return;
      try {
        const signature = JSON.stringify([task.trigger, task.enabled, task.createdAt, task.expiresAt, task.maxRuns]);
        let entry = this.entries.get(task.id);
        if (!entry || entry.signature !== signature) {
          const now = Date.now();
          // Align interval phases across activation/reload without replaying offline occurrences.
          const anchor = task.trigger.type === "interval"
            ? now - ((now - task.createdAt) % (task.trigger.seconds * 1000)) : now;
          entry = { signature, scheduler: new Scheduler({ version: 1, maxRuns: 1000,
            maxRuntimeSeconds: Math.max(1, Math.ceil((task.expiresAt - anchor) / 1000)), tasks: [{ ...task, maxRuns: 1000 }] }, anchor),
            files: await FileChanges.open(this.session.automationWorkspace,
              task.trigger.type === "file_changed" ? task.trigger.paths : [], this.abort.signal) };
          this.entries.set(task.id, entry);
        }
        entry.scheduler.filesChanged(await entry.files.poll(this.abort.signal), Date.now());
        entry.scheduler.advance(Date.now());
      } catch (error) {
        if (this.closed || !this.host.idle() || this.session.isBusy) return;
        await this.session.manageSessionAutomation(task.sessionId, { action: "pause", id: task.id });
        this.entries.delete(task.id);
        await this.host.changed();
        this.host.error(`Automation ${task.id} was paused: ${error instanceof HarnessError ? error.message : "The watched files could not be read."}`);
      }
    }
    const pivot = Math.max(0, tasks.findIndex((task) => task.id === this.lastRun) + 1);
    for (const task of [...tasks.slice(pivot), ...tasks.slice(0, pivot)]) {
      if (this.closed || !this.host.idle() || this.session.isBusy) return;
      const entry = this.entries.get(task.id);
      if (!entry) continue;
      const activation = entry.scheduler.take(Date.now());
      if (!activation) continue;
      this.lastRun = task.id;
      try { await this.host.run(task, activation); }
      finally { entry.scheduler.finish(); }
      // Suppress automated writes across all watched sessions, including failed turns.
      for (const other of this.entries.values()) await other.files.poll(this.abort.signal);
      await this.host.changed();
      break;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.abort.abort();
    clearInterval(this.timer);
    await this.active;
    await this.release?.();
    this.release = undefined;
    this.entries.clear();
  }
}
