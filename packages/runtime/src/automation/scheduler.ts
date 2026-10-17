import { parseCron } from "./cron.js";
import type { AutomationConfig, AutomationTask } from "./config.js";

export type Activation = { task: AutomationTask; scheduledAt: number; paths?: string[] };
type State = { task: AutomationTask; runs: number; next: number; lastMinute: number;
  cron?: ReturnType<typeof parseCron>; changes: Set<string>; changedAt: number };

/** Bounded trigger queue. Time and execution are injected; no model or timer lives here. */
export class Scheduler {
  private readonly states: State[];
  private readonly pending = new Map<string, Activation>();
  private active = false;
  private attempts = 0;
  readonly expiresAt: number;

  constructor(private readonly config: AutomationConfig, now: number) {
    this.expiresAt = now + config.maxRuntimeSeconds * 1000;
    this.states = config.tasks.map((task) => {
      const trigger = task.trigger;
      const next = trigger.type === "interval" ? now + trigger.seconds * 1000
        : trigger.type === "at" && Date.parse(trigger.time) > now ? Date.parse(trigger.time) : Infinity;
      return { task, runs: 0, next, lastMinute: Math.floor(now / 60000), changes: new Set(), changedAt: now,
        ...(trigger.type === "cron" ? { cron: parseCron(trigger.expression, trigger.timezone) } : {}) };
    });
  }

  get exhausted(): boolean {
    return this.attempts >= this.config.maxRuns || this.states.every((state) => state.runs >= state.task.maxRuns
      || (state.task.trigger.type === "at" && state.next === Infinity && !this.pending.has(state.task.id)));
  }

  advance(now: number): void {
    if (now >= this.expiresAt || this.exhausted) return;
    for (const state of this.states) {
      if (state.runs >= state.task.maxRuns) continue;
      const trigger = state.task.trigger;
      if (state.cron) {
        const minute = Math.floor(now / 60000);
        // The process lease is at most seven days; coalesce to the latest missed minute.
        for (let candidate = minute; candidate > state.lastMinute; candidate--) {
          if (state.cron.matches(candidate * 60000)) {
            this.enqueue(state, candidate * 60000);
            break;
          }
        }
        state.lastMinute = Math.max(state.lastMinute, minute);
      } else if (trigger.type === "interval" || trigger.type === "at") {
        if (state.next <= now) {
          const due = trigger.type === "interval"
            ? state.next + Math.floor((now - state.next) / (trigger.seconds * 1000)) * trigger.seconds * 1000 : state.next;
          this.enqueue(state, due);
          state.next = trigger.type === "interval" ? due + trigger.seconds * 1000 : Infinity;
        }
      } else if (trigger.type === "file_changed" && state.changes.size && now - state.changedAt >= trigger.debounceMs) {
        this.enqueue(state, state.changedAt, [...state.changes]);
        state.changes.clear();
      }
    }
  }

  filesChanged(paths: readonly string[], now: number): void {
    for (const state of this.states) {
      if (state.task.trigger.type !== "file_changed" || state.runs >= state.task.maxRuns) continue;
      const matches = paths.filter((path) => state.task.trigger.type === "file_changed" && state.task.trigger.paths.includes(path));
      if (matches.length) {
        for (const path of matches) state.changes.add(path);
        state.changedAt = now;
      }
    }
  }

  take(now: number): Activation | undefined {
    if (this.active || now >= this.expiresAt || this.exhausted) return;
    const entry = this.pending.entries().next().value;
    if (!entry) return;
    const [id, activation] = entry;
    this.pending.delete(id);
    this.states.find((state) => state.task.id === id)!.runs++;
    this.attempts++;
    this.active = true;
    return structuredClone(activation);
  }

  finish(): void { this.active = false; }

  private enqueue(state: State, scheduledAt: number, paths?: string[]): void {
    const previous = this.pending.get(state.task.id);
    this.pending.set(state.task.id, { task: state.task, scheduledAt,
      ...(paths ? { paths: [...new Set([...(previous?.paths ?? []), ...paths])] } : {}) });
  }
}
