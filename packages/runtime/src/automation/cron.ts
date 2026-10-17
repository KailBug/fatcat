import { HarnessError } from "../errors.js";

export type CronZone = "local" | "UTC";
type Field = { values: Set<number>; wildcard: boolean };

function invalid(): never {
  throw new HarnessError("AUTOMATION_CONFIG", "Use five numeric cron fields with *, lists, ranges, and steps; names, seconds, L, W and ? are unsupported.");
}

function field(source: string, min: number, max: number, sunday = false): Field {
  const values = new Set<number>();
  for (const item of source.split(",")) {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(item);
    if (!match) invalid();
    const step = match[2] === undefined ? 1 : Number(match[2]);
    if (!Number.isSafeInteger(step) || step < 1 || step > max - min + 1) invalid();
    const base = match[1]!;
    const bounds = base === "*" ? [min, max] : base.split("-").map(Number);
    const start = bounds[0]!;
    const end = bounds[1] ?? (match[2] === undefined ? start : max);
    if (start < min || start > max || end < start || end > max) invalid();
    for (let value = start; value <= end; value += step) values.add(sunday && value === 7 ? 0 : value);
  }
  return { values, wildcard: source.startsWith("*") };
}

/** Numeric Vixie cron, evaluated against absolute minutes to retain DST ordering. */
export function parseCron(expression: string, zone: CronZone = "local") {
  if (expression.length > 256) invalid();
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) invalid();
  const minute = field(parts[0]!, 0, 59);
  const hour = field(parts[1]!, 0, 23);
  const day = field(parts[2]!, 1, 31);
  const month = field(parts[3]!, 1, 12);
  const weekday = field(parts[4]!, 0, 7, true);
  return {
    matches(timestamp: number): boolean {
      const date = new Date(timestamp);
      const utc = zone === "UTC";
      const dom = day.values.has(utc ? date.getUTCDate() : date.getDate());
      const dow = weekday.values.has(utc ? date.getUTCDay() : date.getDay());
      return minute.values.has(utc ? date.getUTCMinutes() : date.getMinutes())
        && hour.values.has(utc ? date.getUTCHours() : date.getHours())
        && month.values.has((utc ? date.getUTCMonth() : date.getMonth()) + 1)
        && (day.wildcard || weekday.wildcard ? dom && dow : dom || dow);
    },
  };
}
