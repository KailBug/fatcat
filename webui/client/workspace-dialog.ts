import type { SessionSummary } from "../../src/session/record.js";
import type { WorkspaceDirectory } from "../workspaces.js";

function button(text: string, action: () => void): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = text;
  element.addEventListener("click", action);
  return element;
}

/** Select a host directory for a captured session, including an unsaved new chat. */
export class WorkspaceDialog {
  private readonly dialog = document.createElement("dialog");
  private readonly input = document.createElement("input");
  private readonly entries = document.createElement("div");
  private readonly shortcuts = document.createElement("div");
  private readonly status = document.createElement("p");
  private readonly select: HTMLButtonElement;
  private selected: SessionSummary | undefined;
  private pending: AbortController | undefined;
  private saving = false;
  private trigger: HTMLElement | undefined;

  constructor(private readonly token: () => string,
    private readonly submit: (session: SessionSummary, path: string) => Promise<boolean>,
    private readonly canManage: () => boolean) {
    this.dialog.id = "workspace-dialog";
    this.dialog.className = "session-dialog workspace-dialog";
    const heading = document.createElement("h2");
    heading.id = "workspace-dialog-title";
    heading.textContent = "Choose workspace";
    this.dialog.setAttribute("aria-labelledby", heading.id);
    const form = document.createElement("form");
    form.className = "session-dialog-form";
    const label = document.createElement("label");
    label.textContent = "Directory path";
    this.input.id = "workspace-directory-path";
    label.htmlFor = this.input.id;
    this.input.className = "session-dialog-input";
    this.input.autocomplete = "off";
    this.input.spellcheck = false;
    this.input.maxLength = 4096;
    const browse = document.createElement("button");
    browse.type = "submit";
    browse.textContent = "Open directory";
    form.addEventListener("submit", (event) => { event.preventDefault(); void this.browse(this.input.value); });
    this.entries.className = "workspace-entries";
    this.entries.setAttribute("aria-label", "Directory contents");
    this.shortcuts.className = "workspace-shortcuts";
    this.status.role = "status";
    const actions = document.createElement("div");
    actions.className = "session-dialog-actions";
    const cancel = button("Cancel", () => { if (!this.saving) this.dialog.close(); });
    this.select = button("Use this workspace", () => { void this.save(); });
    this.select.className = "session-dialog-submit";
    actions.append(cancel, this.select);
    form.append(heading, label, this.input, browse, this.shortcuts, this.entries, this.status, actions);
    this.dialog.append(form);
    document.body.append(this.dialog);
    this.dialog.addEventListener("cancel", (event) => { event.stopPropagation(); if (this.saving) event.preventDefault(); });
    this.dialog.addEventListener("keydown", (event) => { if (event.key === "Escape") event.stopPropagation(); });
    this.dialog.addEventListener("close", () => {
      this.pending?.abort();
      this.pending = undefined;
      this.selected = undefined;
      if (this.trigger?.isConnected) this.trigger.focus();
    });
  }

  open(session: SessionSummary): void {
    if (!this.canManage() || this.dialog.open) return;
    this.selected = structuredClone(session);
    this.trigger = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    this.input.value = session.workspace;
    this.dialog.showModal();
    this.input.focus();
    void this.browse(session.workspace);
  }

  update(): void {
    this.select.disabled = this.saving || Boolean(this.pending) || !this.canManage();
    this.input.disabled = this.saving;
  }

  private async browse(path: string): Promise<void> {
    if (this.saving) return;
    this.pending?.abort();
    const pending = new AbortController();
    this.pending = pending;
    this.status.textContent = "Loading directory…";
    this.update();
    try {
      const response = await fetch("/api/workspaces", { method: "POST",
        headers: { Authorization: `Bearer ${this.token()}`, "Content-Type": "application/json" },
        body: JSON.stringify({ path }), signal: AbortSignal.any([pending.signal, AbortSignal.timeout(10_000)]) });
      if (!response.ok) throw new Error((await response.json() as { error: string }).error);
      const directory = await response.json() as WorkspaceDirectory;
      if (this.pending !== pending || !this.dialog.open) return;
      this.input.value = directory.path;
      this.shortcuts.replaceChildren(button("Parent", () => { void this.browse(directory.parent); }),
        button("Home", () => { void this.browse(directory.home); }),
        ...directory.roots.map((root) => button(root, () => { void this.browse(root); })));
      this.entries.replaceChildren(...directory.entries.map((entry) => {
        const item = button(`${entry.directory ? "Folder: " : "File: "}${entry.name}`, () => { void this.browse(entry.path); });
        item.disabled = !entry.directory;
        item.title = entry.path;
        return item;
      }));
      this.status.textContent = directory.truncated ? "Showing the first 1,000 entries. Enter a path to open another directory."
        : directory.entries.length ? "Select a folder or enter a directory path." : "This directory is empty.";
    } catch (error) {
      if (this.pending === pending && !pending.signal.aborted) {
        this.entries.replaceChildren();
        this.status.textContent = error instanceof Error ? error.message : "Could not list this directory.";
      }
    } finally {
      if (this.pending === pending) { this.pending = undefined; this.update(); }
    }
  }

  private async save(): Promise<void> {
    if (!this.selected || this.saving || this.pending || !this.canManage()) return;
    this.saving = true;
    this.update();
    try {
      if (await this.submit(this.selected, this.input.value.trim())) this.dialog.close();
      else this.status.textContent = "The workspace could not be changed. Check the path and try again.";
    } finally { this.saving = false; this.update(); }
  }
}
