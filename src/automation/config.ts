import { HarnessError } from "../errors.js";
import { readTextFile } from "../permissions/text-file.js";
import { createWorkspace } from "../permissions/workspace.js";
import { parseCron } from "./cron.js";
import type { CronZone } from "./cron.js";

export type Trigger =
  | { type: "cron"; expression: string; timezone: CronZone }
  | { type: "interval"; seconds: number }
  | { type: "at"; time: string }
  | { type: "file_changed"; paths: string[]; debounceMs: number };
export type AutomationTask = { id: string; prompt: string; trigger: Trigger; maxRuns: number };
export type AutomationConfig = { version: 1; maxRuns: number; maxRuntimeSeconds: number; tasks: AutomationTask[] };

function invalid(message: string): never { throw new HarnessError("AUTOMATION_CONFIG", message); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("Automation configuration entries must be objects.");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) invalid("Unknown automation configuration field.");
}
function integer(value: unknown, fallback: number, min: number, max: number): number {
  const result = value === undefined ? fallback : value;
  if (typeof result !== "number" || !Number.isSafeInteger(result) || result < min || result > max) {
    invalid(`Automation limits must be integers from ${min} to ${max}.`);
  }
  return result;
}
function string(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) invalid(`Expected non-empty text of at most ${max} characters.`);
  return value;
}
function parseTrigger(value: unknown): Trigger {
  const raw = object(value);
  switch (raw.type) {
    case "cron": {
      keys(raw, ["type", "expression", "timezone"]);
      const expression = string(raw.expression, 256);
      const timezone = raw.timezone ?? "local";
      if (timezone !== "local" && timezone !== "UTC") invalid("Cron timezone must be local or UTC.");
      parseCron(expression, timezone);
      return { type: "cron", expression, timezone };
    }
    case "interval":
      keys(raw, ["type", "seconds"]);
      if (raw.seconds === undefined) invalid("Interval triggers require seconds.");
      return { type: "interval", seconds: integer(raw.seconds, 60, 60, 604800) };
    case "at": {
      keys(raw, ["type", "time"]);
      const time = string(raw.time, 40);
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})$/.test(time) || !Number.isFinite(Date.parse(time))) {
        invalid("One-shot time requires an ISO timestamp with seconds and an explicit UTC offset.");
      }
      const wallTime = time.slice(0, 19);
      const wallDate = new Date(`${wallTime}Z`);
      if (!Number.isFinite(wallDate.getTime()) || wallDate.toISOString().slice(0, 19) !== wallTime) {
        invalid("One-shot time must be a real calendar date and time.");
      }
      return { type: "at", time };
    }
    case "file_changed": {
      keys(raw, ["type", "paths", "debounceMs"]);
      if (!Array.isArray(raw.paths) || raw.paths.length < 1 || raw.paths.length > 32) invalid("File triggers require 1 to 32 explicit text file paths.");
      const paths = raw.paths.map((path) => string(path, 512).replaceAll("\\", "/"));
      if (new Set(paths).size !== paths.length) invalid("File trigger paths must be unique.");
      return { type: "file_changed", paths, debounceMs: integer(raw.debounceMs, 1000, 1000, 60000) };
    }
    default: return invalid("Trigger type must be cron, interval, at, or file_changed.");
  }
}

export function parseAutomationConfig(value: unknown): AutomationConfig {
  const raw = object(value);
  keys(raw, ["version", "maxRuns", "maxRuntimeSeconds", "tasks"]);
  if (raw.version !== 1 || !Array.isArray(raw.tasks) || !raw.tasks.length || raw.tasks.length > 32) {
    invalid("Automation version must be 1 with 1 to 32 tasks.");
  }
  const tasks = raw.tasks.map((value): AutomationTask => {
    const task = object(value);
    keys(task, ["id", "prompt", "trigger", "maxRuns"]);
    const id = string(task.id, 64);
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(id)) invalid("Task IDs must use letters, digits, underscores or hyphens.");
    return { id, prompt: string(task.prompt, 16000), trigger: parseTrigger(task.trigger), maxRuns: integer(task.maxRuns, 20, 1, 1000) };
  });
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) invalid("Automation task IDs must be unique.");
  if (new Set(tasks.flatMap((task) => task.trigger.type === "file_changed" ? task.trigger.paths : [])).size > 64) {
    invalid("At most 64 distinct files can be monitored.");
  }
  return { version: 1, maxRuns: integer(raw.maxRuns, 20, 1, 1000),
    maxRuntimeSeconds: integer(raw.maxRuntimeSeconds, 86400, 1, 604800), tasks };
}

/** Explicit configuration only, always constrained to the selected workspace. */
export async function loadAutomationConfig(workspace: string, path: string, signal?: AbortSignal) {
  const access = await createWorkspace(workspace);
  const target = await access.resolvePath(path, signal);
  const { content } = await readTextFile(target, signal, new Set([".json"]));
  let raw: unknown;
  try { raw = JSON.parse(content); } catch { return invalid("Automation configuration must be valid JSON."); }
  return { config: parseAutomationConfig(raw), path: target.relative };
}
