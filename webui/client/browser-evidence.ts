import type { BrowserRecord } from "../../src/browser/protocol.js";

/** Evidence is fetched with the parent capability; no token is placed in links or images. */
export class BrowserEvidenceView {
  private readonly dialog = document.createElement("dialog");
  private readonly content = document.createElement("div");
  private readonly heading = document.createElement("h2");
  private pending: AbortController | undefined;
  private imageUrl: string | undefined;

  constructor(private readonly token: () => string) {
    this.dialog.className = "browser-evidence-dialog";
    this.heading.id = "browser-evidence-heading";
    this.dialog.setAttribute("aria-labelledby", this.heading.id);
    const header = document.createElement("div"); header.className = "dialog-heading";
    const close = document.createElement("button"); close.textContent = "Close";
    close.setAttribute("aria-label", "Close browser evidence");
    close.addEventListener("click", () => this.dialog.close());
    header.append(this.heading, close);
    this.dialog.append(header, this.content);
    document.body.append(this.dialog);
    this.dialog.addEventListener("close", () => this.clear());
  }

  buttons(check: BrowserRecord & { laterWriteAttempt?: boolean }): HTMLElement {
    const card = document.createElement("div"); card.className = "browser-check";
    const summary = document.createElement("p");
    summary.textContent = `Browser check · ${check.path} · ${check.status} · ${check.completedSteps} steps · ${check.errorCount} diagnostics · ${check.blockedCount} blocked`;
    card.append(summary);
    if (check.laterWriteAttempt) {
      const note = document.createElement("p"); note.textContent = "Files were changed or a change was attempted after this capture. Run a fresh browser check.";
      card.append(note);
    }
    for (const kind of ["report", "screenshot"] as const) {
      if (!(kind === "report" ? check.reportPath : check.screenshotPath)) continue;
      const button = document.createElement("button"); button.type = "button"; button.className = "preview-file-button";
      button.textContent = kind === "report" ? "View browser report" : "View screenshot";
      button.addEventListener("click", () => { void this.show(check, kind); }); card.append(button);
    }
    return card;
  }

  private clear(): void {
    this.pending?.abort(); this.pending = undefined;
    if (this.imageUrl) URL.revokeObjectURL(this.imageUrl);
    this.imageUrl = undefined; this.content.replaceChildren();
  }

  private async show(check: BrowserRecord, kind: "report" | "screenshot"): Promise<void> {
    this.clear();
    this.heading.textContent = `${kind === "report" ? "Browser report" : "Screenshot"} · ${check.path}`;
    this.content.textContent = "Loading evidence…";
    if (!this.dialog.open) this.dialog.showModal();
    const pending = new AbortController(); this.pending = pending;
    try {
      const response = await fetch(`/api/browser-evidence/${check.id}/${kind}`, {
        headers: { Authorization: `Bearer ${this.token()}` }, signal: AbortSignal.any([pending.signal, AbortSignal.timeout(10_000)]),
      });
      if (!response.ok) throw new Error("Browser evidence is unavailable. Check the files in fatcat-browser-evidence.");
      const blob = await response.blob();
      if (this.pending !== pending || !this.dialog.open) return;
      if (kind === "screenshot") {
        this.imageUrl = URL.createObjectURL(blob);
        const image = document.createElement("img"); image.src = this.imageUrl; image.alt = `Browser capture of ${check.path} at ${check.capturedAt}`;
        this.content.replaceChildren(image);
      } else {
        const pre = document.createElement("pre"); pre.textContent = await blob.text();
        if (this.pending === pending && this.dialog.open) this.content.replaceChildren(pre);
      }
    } catch (error) {
      if (this.pending === pending && !pending.signal.aborted) this.content.textContent = error instanceof Error ? error.message : "Could not load browser evidence.";
    }
  }
}
