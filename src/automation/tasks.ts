import { randomUUID } from "node:crypto";
import { HarnessError } from "../errors.js";
import { parseAutomationConfig } from "./config.js";
import type { Trigger } from "./config.js";

export type BoundTask = {
  id: string; prompt: string; trigger: Trigger; maxRuns: number; runs: number;
  createdAt: number; expiresAt: number; enabled: boolean;
  lastStatus?: "running" | "completed" | "failed" | "cancelled";
  lastScheduledAt?: number;
};
export type SessionAutomation = BoundTask & { sessionId: string; sessionTitle: string };

export function newBoundTask(value: unknown, now = Date.now()): BoundTask {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HarnessError("AUTOMATION_CONFIG", "Expected a task object.");
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).some((key) => !["prompt", "trigger", "maxRuns", "maxRuntimeSeconds"].includes(key))) {
    throw new HarnessError("AUTOMATION_CONFIG", "Unknown task field.");
  }
  const id = randomUUID();
  const config = parseAutomationConfig({ version: 1, maxRuntimeSeconds: raw.maxRuntimeSeconds,
    tasks: [{ id, prompt: raw.prompt, trigger: raw.trigger, maxRuns: raw.maxRuns }] });
  const task = config.tasks[0]!;
  if (task.trigger.type === "at" && Date.parse(task.trigger.time) <= now) {
    throw new HarnessError("AUTOMATION_CONFIG", "Choose a future time for a one-shot task.");
  }
  if (task.trigger.type === "at" && Date.parse(task.trigger.time) >= now + config.maxRuntimeSeconds * 1000) {
    throw new HarnessError("AUTOMATION_CONFIG", "The one-shot time must be before task expiry. Increase maxRuntimeSeconds if needed (up to seven days).");
  }
  return { ...task, runs: 0, createdAt: now, expiresAt: now + config.maxRuntimeSeconds * 1000, enabled: true };
}

/** Backward-compatible Session field, validated before it can schedule work. */
export function decodeBoundTasks(value: unknown): BoundTask[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 32) throw new HarnessError("SESSION_INVALID", "Invalid saved automation tasks.");
  const tasks = value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new HarnessError("SESSION_INVALID", "Invalid saved automation task.");
    const config = parseAutomationConfig({ version: 1, tasks: [{ id: raw.id, prompt: raw.prompt, trigger: raw.trigger, maxRuns: raw.maxRuns }] });
    if (!Number.isSafeInteger(raw.runs) || raw.runs < 0 || raw.runs > config.tasks[0]!.maxRuns
      || !Number.isSafeInteger(raw.createdAt) || raw.createdAt < 0 || !Number.isSafeInteger(raw.expiresAt)
      || raw.expiresAt <= raw.createdAt || !Number.isFinite(new Date(raw.expiresAt).getTime()) || raw.expiresAt - raw.createdAt > 604800000 || typeof raw.enabled !== "boolean"
      || (raw.lastStatus !== undefined && !["running", "completed", "failed", "cancelled"].includes(raw.lastStatus))
      || (raw.lastScheduledAt !== undefined && (!Number.isSafeInteger(raw.lastScheduledAt) || raw.lastScheduledAt < 0))) {
      throw new HarnessError("SESSION_INVALID", "Invalid saved automation state.");
    }
    return { ...config.tasks[0]!, runs: raw.runs, createdAt: raw.createdAt, expiresAt: raw.expiresAt, enabled: raw.enabled,
      ...(raw.lastStatus === undefined ? {} : { lastStatus: raw.lastStatus }),
      ...(raw.lastScheduledAt === undefined ? {} : { lastScheduledAt: raw.lastScheduledAt }) } as BoundTask;
  });
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) throw new HarnessError("SESSION_INVALID", "Duplicate automation IDs.");
  return tasks;
}

export function taskIsEnabled(task: BoundTask, now = Date.now()): boolean {
  return task.enabled && task.runs < task.maxRuns && task.expiresAt > now
    && !(task.trigger.type === "at" && task.runs > 0);
}
