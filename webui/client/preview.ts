type PreviewSnapshot = { path: string; url: string; bytes: number };

function element<T extends HTMLElement>(id: string): T { return document.getElementById(id) as T; }

/** UI-only preview: no messages, model requests, approval decisions or tool events. */
export class FilePreview {
  private readonly panel = element("file-preview");
  private readonly input = element<HTMLInputElement>("preview-path");
  private readonly openButton = element<HTMLButtonElement>("preview-open");
  private readonly refreshButton = element<HTMLButtonElement>("preview-refresh");
  private readonly entry = element<HTMLButtonElement>("show-preview");
  private readonly viewport = element("preview-viewport");
  private readonly status = element("preview-status");
  private pending: AbortController | undefined;
  private path = "";
  private connected = false;
  private returnFocus: HTMLElement | undefined;

  constructor(private readonly token: () => string) {
    this.entry.addEventListener("click", () => this.panel.hidden ? this.open() : this.close());
    element("preview-close").addEventListener("click", () => this.close());
    element<HTMLFormElement>("preview-form").addEventListener("submit", (event) => {
      event.preventDefault(); void this.load(this.input.value.trim());
    });
    this.refreshButton.addEventListener("click", () => { void this.load(this.path); });
    this.input.addEventListener("input", () => this.controls());
    this.panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); this.close(); }
    });
  }

  update(connected: boolean): void { this.connected = connected; this.controls(); }

  reset(): void {
    this.close();
    this.path = "";
    this.input.value = "";
    this.controls();
  }

  open(path?: string): void {
    if (this.panel.hidden) this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : this.entry;
    this.panel.hidden = false;
    this.entry.setAttribute("aria-expanded", "true");
    if (path) this.input.value = path;
    this.input.focus();
    this.controls();
    if (path) void this.load(path);
    else if (this.path && !this.viewport.childElementCount) void this.load(this.path);
  }

  private close(): void {
    this.pending?.abort(); this.pending = undefined;
    this.viewport.replaceChildren();
    this.status.textContent = "";
    this.panel.setAttribute("aria-busy", "false");
    this.panel.hidden = true;
    this.entry.setAttribute("aria-expanded", "false");
    if (this.returnFocus?.isConnected) this.returnFocus.focus(); else this.entry.focus();
  }

  private controls(): void {
    this.entry.disabled = !this.connected && Boolean(this.panel.hidden);
    this.openButton.disabled = !this.connected || Boolean(this.pending) || !this.input.value.trim();
    this.refreshButton.disabled = !this.connected || Boolean(this.pending) || !this.path;
  }

  private async load(path: string): Promise<void> {
    if (!this.connected || !path) return;
    this.pending?.abort();
    const pending = new AbortController(); this.pending = pending;
    this.path = path;
    this.viewport.replaceChildren();
    this.status.textContent = "Reading file…";
    this.status.classList.remove("error");
    this.panel.setAttribute("aria-busy", "true");
    this.controls();
    try {
      const response = await fetch("/api/preview", { method: "POST",
        headers: { Authorization: `Bearer ${this.token()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ path }), signal: AbortSignal.any([pending.signal, AbortSignal.timeout(10_000)]) });
      if (!response.ok) throw new Error((await response.json() as { error: string }).error);
      const snapshot = await response.json() as PreviewSnapshot;
      if (this.pending !== pending || this.panel.hidden) return;
      if (!/^\/preview\/[a-f0-9]{64}$/.test(snapshot.url)) throw new Error("The server returned an invalid preview URL.");
      const frame = document.createElement("iframe");
      frame.title = `Preview of ${snapshot.path}`;
      frame.setAttribute("sandbox", "allow-scripts");
      frame.referrerPolicy = "no-referrer";
      frame.src = snapshot.url;
      this.viewport.replaceChildren(frame);
      this.path = snapshot.path;
      this.input.value = snapshot.path;
      this.status.textContent = `${snapshot.path} · ${snapshot.bytes.toLocaleString("en-US")} bytes · Snapshot read at ${new Date().toLocaleTimeString("en-US")}`;
    } catch (error) {
      if (this.pending !== pending || pending.signal.aborted) return;
      this.status.textContent = error instanceof Error ? error.message : "Preview could not be opened. Try again.";
      this.status.classList.add("error");
    } finally {
      if (this.pending === pending) {
        this.pending = undefined;
        this.panel.setAttribute("aria-busy", "false");
        this.controls();
      }
    }
  }
}
