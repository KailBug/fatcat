import { randomBytes } from "node:crypto";
import type { Browser, BrowserContext, Page } from "playwright";
import { HarnessError, checkCancellation } from "../errors.js";
import type { Workspace } from "../permissions/workspace.js";
import { readBrowserFile } from "../permissions/browser.js";
import { evidenceDirectory } from "./evidence.js";
import type { BrowserRequest } from "./protocol.js";

type Diagnostic = { kind: string; message: string };
export type BrowserRun = {
  status: "completed" | "failed"; completedSteps: number; diagnostics: Diagnostic[]; diagnosticsTruncated: boolean;
  sources: { path: string; sha256: string; bytes: number }[]; snapshot: unknown; png?: Buffer;
};
export type BrowserRunner = (request: BrowserRequest, workspace: Workspace, signal: AbortSignal) => Promise<BrowserRun>;

/** Each call owns a fresh browser and context; page requests are fulfilled from workspace bytes only. */
export const runBrowser: BrowserRunner = async (request, workspace, signal) => {
  const { chromium } = await import("playwright");
  let browser: Browser | undefined;
  let closing: Promise<void> | undefined;
  const close = () => { if (browser) closing ??= browser.close(); return closing; };
  const abort = () => { void close()?.catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  const diagnostics: Diagnostic[] = [];
  let diagnosticsTruncated = false;
  const diagnostic = (kind: string, message: string) => {
    if (diagnostics.length < 20) diagnostics.push({ kind, message: message.slice(0, 400) });
    else diagnosticsTruncated = true;
  };
  const sources: BrowserRun["sources"] = [];
  const cache = new Map<string, Awaited<ReturnType<typeof readBrowserFile>>>();
  const origin = `http://${randomBytes(12).toString("hex")}.fatcat.invalid`;
  const csp = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; media-src 'self' data:; connect-src 'self'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'self'; form-action 'none'";
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  let completedSteps = 0;
  let bytes = 0;
  let requests = 0;
  let snapshot: unknown = null;
  let png: Buffer | undefined;
  let status: BrowserRun["status"] = "completed";
  try {
    checkCancellation(signal);
    try {
      browser = await chromium.launch({ headless: true, timeout: 8000, chromiumSandbox: true,
        ...(process.platform === "win32" ? { channel: "msedge" } : {}),
        args: ["--force-webrtc-ip-handling-policy=disable_non_proxied_udp"],
        env: Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined
          && /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|TMPDIR|HOME|USERPROFILE|LOCALAPPDATA|APPDATA|PROGRAMFILES|PROGRAMFILES\(X86\)|PROGRAMDATA|COMSPEC|LANG|LC_ALL)$/i.test(key))) as Record<string, string> });
    } catch {
      checkCancellation(signal);
      throw new HarnessError("BROWSER_UNAVAILABLE", "Could not launch the isolated browser. Windows requires installed Microsoft Edge; other platforms require pnpm exec playwright install chromium. No browser is downloaded automatically.");
    }
    checkCancellation(signal);
    context = await browser.newContext({ viewport: request.viewport, serviceWorkers: "block", acceptDownloads: false,
      permissions: [], reducedMotion: "no-preference" });
    context.setDefaultTimeout(2000);
    await context.routeWebSocket("**/*", (socket) => {
      diagnostic("blocked", "WebSocket connections are disabled."); socket.close();
    });
    await context.route("**/*", async (route) => {
      try {
        checkCancellation(signal);
        if (++requests > 100) throw new HarnessError("BROWSER_LIMIT", "The 100-request browser budget was exceeded.");
        const url = new URL(route.request().url());
        if (url.origin !== origin || !["GET", "HEAD"].includes(route.request().method())) {
          throw new HarnessError("BROWSER_NETWORK", "External URLs and non-read requests are blocked.");
        }
        const path = decodeURIComponent(url.pathname.slice(1));
        if (path.replaceAll("\\", "/").split("/")[0]?.toLowerCase() === evidenceDirectory) {
          throw new HarnessError("BROWSER_FILE", "Browser evidence is not served to workspace pages.");
        }
        let asset = cache.get(path);
        if (!asset) {
          asset = await readBrowserFile(workspace, path, signal);
          if (asset.path.split("/")[0]?.toLowerCase() === evidenceDirectory) throw new HarnessError("BROWSER_FILE", "Browser evidence is not served to workspace pages.");
          bytes += asset.bytes.length;
          if (bytes > 8 * 1024 * 1024 || sources.length >= 64) throw new HarnessError("BROWSER_LIMIT", "The browser asset budget was exceeded.");
          cache.set(path, asset);
          sources.push({ path: asset.path, sha256: asset.sha256, bytes: asset.bytes.length });
        }
        await route.fulfill({ status: 200, body: route.request().method() === "HEAD" ? Buffer.alloc(0) : asset.bytes,
          contentType: asset.type.startsWith("text/") || ["image/svg+xml", "application/json"].includes(asset.type) ? `${asset.type}; charset=utf-8` : asset.type,
          headers: { "Content-Security-Policy": csp, "X-Content-Type-Options": "nosniff",
            "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
      } catch (error) {
        diagnostic("blocked", error instanceof HarnessError ? error.message : "A workspace asset could not be read.");
        await route.abort("blockedbyclient").catch(() => {});
      }
    });
    // WebRTC is not HTTP; disable page access in addition to Chromium's UDP policy.
    await context.addInitScript(() => {
      for (const name of ["RTCPeerConnection", "webkitRTCPeerConnection", "WebTransport"]) {
        Object.defineProperty(globalThis, name, { value: undefined, writable: false, configurable: false });
      }
    });
    page = await context.newPage();
    context.on("page", (extra) => { diagnostic("blocked", "Popups are disabled."); void extra.close().catch(() => {}); });
    page.on("pageerror", (error) => diagnostic("pageerror", error.message));
    page.on("console", (message) => {
      if (["error", "warning"].includes(message.type())) diagnostic(`console.${message.type()}`, message.text());
    });
    page.on("requestfailed", (failed) => diagnostic("requestfailed", `${failed.method()} ${failed.url().slice(0, 200)}: ${failed.failure()?.errorText ?? "failed"}`));
    page.on("dialog", (dialog) => { diagnostic("dialog", "A page dialog was dismissed."); void dialog.dismiss().catch(() => {}); });
    page.on("download", (download) => { diagnostic("blocked", "Downloads are disabled."); void download.cancel().catch(() => {}); });
    try {
      const path = request.path.replaceAll("\\", "/").split("/").map(encodeURIComponent).join("/");
      await page.goto(`${origin}/${path}`, { waitUntil: "load", timeout: 5000 });
      for (const step of request.steps) {
        checkCancellation(signal);
        if (!page.url().startsWith(origin + "/")) throw new Error("Page left the workspace origin.");
        if (step.action === "wait") await page.waitForTimeout(step.milliseconds);
        else {
          const target = page.locator(`css=${step.selector}`);
          if (step.action === "click") await target.click();
          else if (step.action === "fill") await target.fill(step.value!);
          else if (step.action === "press") await target.press(step.value!);
          else await target.selectOption(step.value!);
        }
        completedSteps++;
      }
    } catch (error) {
      checkCancellation(signal);
      status = "failed";
      diagnostic("action", `Stopped after ${completedSteps} completed steps. ${error instanceof Error ? error.message : "Browser action failed."}`);
    }
    checkCancellation(signal);
    if (page.url().startsWith(origin + "/")) {
      try {
        snapshot = await page.evaluate((selectors) => {
          const items: Record<string, unknown>[] = [];
          let truncated = false;
          const queries = selectors.length ? selectors : ["h1,h2,button,a,input,select,textarea,svg"];
          for (const selector of queries) {
            let count = 0;
            try {
              const elements = document.querySelectorAll(selector);
              count = elements.length;
              if (!count) items.push({ selector, count: 0 });
              for (const element of elements) {
                if (items.length >= 30) { truncated = true; break; }
                const bounds = element.getBoundingClientRect();
                const style = getComputedStyle(element);
                const input = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement;
                let svg = null;
                if (element instanceof SVGGraphicsElement) {
                  const box = element.getBBox(); const matrix = element.getScreenCTM();
                  svg = { box: { x: box.x, y: box.y, width: box.width, height: box.height },
                    matrix: matrix ? { a: matrix.a, b: matrix.b, c: matrix.c, d: matrix.d, e: matrix.e, f: matrix.f } : null };
                }
                items.push({ selector, count, tag: element.tagName.toLowerCase(), id: element.id.slice(0, 160),
                  text: (element.textContent ?? "").slice(0, 200),
                  value: input ? (element instanceof HTMLInputElement && element.type === "password" ? "[redacted]" : element.value.slice(0, 200)) : null,
                  visible: style.display !== "none" && style.visibility !== "hidden" && bounds.width > 0 && bounds.height > 0,
                  rect: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }, svg });
              }
            } catch { items.push({ selector, error: "Invalid CSS selector or unavailable geometry." }); }
            if (items.length >= 30) { truncated = true; break; }
          }
          const text = (document.body?.innerText ?? document.documentElement.textContent ?? "");
          return { title: document.title.slice(0, 200), text: text.slice(0, 4000), textTruncated: text.length > 4000,
            elements: items, elementsTruncated: truncated, viewport: { width: innerWidth, height: innerHeight },
            document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight } };
        }, request.selectors);
        if (request.screenshot) png = await page.screenshot({ type: "png", timeout: 4000, animations: "allow" });
      } catch (error) {
        checkCancellation(signal);
        status = "failed"; diagnostic("capture", error instanceof Error ? error.message : "Could not capture the page.");
      }
    } else { status = "failed"; diagnostic("blocked", "The page left the workspace origin; capture was not performed."); }
    checkCancellation(signal);
    return { status, completedSteps, diagnostics, diagnosticsTruncated, sources, snapshot, ...(png ? { png } : {}) };
  } finally {
    signal.removeEventListener("abort", abort);
    await close();
  }
};
