import { HarnessError } from "../errors.js";

export type BrowserStep = { action: "click" | "fill" | "press" | "select"; selector: string; value?: string }
  | { action: "wait"; milliseconds: number };
export type BrowserRequest = { path: string; steps: BrowserStep[]; selectors: string[];
  viewport: { width: number; height: number }; screenshot: boolean };
export type BrowserRecord = { id: string; path: string; status: "completed" | "failed" | "cancelled";
  capturedAt: string; errorCount: number; blockedCount: number; completedSteps: number;
  reportPath: string | null; screenshotPath: string | null };

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function invalid(): never { throw new HarnessError("INVALID_ARGUMENTS", "Use a workspace HTML/SVG path, up to 12 bounded steps and 12 CSS selectors, an optional viewport (320–1600 by 240–1200), and screenshot boolean."); }
function string(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value);
}
function integer(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max;
}
export function parseBrowserRequest(value: unknown): BrowserRequest {
  if (!record(value) || Object.keys(value).some((key) => !["path", "steps", "selectors", "viewport", "screenshot"].includes(key))
    || !string(value.path, 1024) || !/\.(html?|svg)$/i.test(value.path)) invalid();
  const steps = value.steps ?? [];
  const selectors = value.selectors ?? [];
  if (!Array.isArray(steps) || steps.length > 12 || !Array.isArray(selectors) || selectors.length > 12
    || selectors.some((selector) => !string(selector, 256))) invalid();
  let wait = 0;
  for (const step of steps) {
    if (!record(step)) invalid();
    if (step.action === "wait") {
      if (Object.keys(step).some((key) => !["action", "milliseconds"].includes(key)) || !integer(step.milliseconds, 0, 2000)) invalid();
      wait += step.milliseconds;
    } else {
      if (!["click", "fill", "press", "select"].includes(String(step.action)) || !string(step.selector, 256)
        || Object.keys(step).some((key) => !["action", "selector", "value"].includes(key))) invalid();
      if (step.action === "click" ? step.value !== undefined : typeof step.value !== "string" || step.value.length > 1000) invalid();
      if (step.action === "press" && !["Enter", "Tab", "Escape", "Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"].includes(String(step.value))) invalid();
    }
  }
  if (wait > 5000) invalid();
  const viewport = value.viewport ?? { width: 1000, height: 700 };
  if (!record(viewport) || Object.keys(viewport).some((key) => !["width", "height"].includes(key))
    || !integer(viewport.width, 320, 1600) || !integer(viewport.height, 240, 1200)
    || (value.screenshot !== undefined && typeof value.screenshot !== "boolean")) invalid();
  return { path: value.path, steps: structuredClone(steps) as BrowserStep[], selectors: [...selectors] as string[],
    viewport: { width: viewport.width, height: viewport.height }, screenshot: value.screenshot !== false };
}
