import type { WebUiState } from "../types.js";
import type { ModelSelection } from "@fatcat/runtime/model-catalog";

const numbers = new Intl.NumberFormat("en-US");
const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const count = (value: number | null | undefined) => value == null ? "Unknown" : compact.format(value);
const sameModel = (a: ModelSelection, b: ModelSelection) => a.provider === b.provider && a.region === b.region
  && a.workspaceId === b.workspaceId && a.model === b.model;
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = text;
  if (className) element.className = className;
  return element;
}

/** DOM, render signatures and temporary form input only; app.ts owns snapshots and requests. */
export class ModelControls {
  private readonly modelPanel: HTMLDialogElement;
  private readonly contextPanel: HTMLDialogElement;
  private modelSignature = "";
  private contextSignature = "";
  private disabled = true;
  private formDisabled = () => {};

  constructor(private readonly modelButton: HTMLButtonElement, private readonly contextButton: HTMLButtonElement,
    private readonly onSelect: (selection: ModelSelection, current: WebUiState) => Promise<void>,
    private readonly onRefresh: () => Promise<void>) {
    this.modelPanel = this.panel("model-panel", "Model and thinking", modelButton);
    this.contextPanel = this.panel("context-panel", "Context", contextButton);
    contextButton.addEventListener("click", () => {
      this.open(this.contextPanel, contextButton);
      void this.onRefresh().catch((error: unknown) => this.showError(this.contextPanel, error));
    });
    window.addEventListener("resize", () => {
      if (this.modelPanel.open) this.position(this.modelPanel, modelButton);
      if (this.contextPanel.open) this.position(this.contextPanel, contextButton);
    });
  }

  update(state: WebUiState | undefined, connected: boolean, changing: boolean): void {
    this.disabled = !connected || changing || Boolean(state?.busy) || !state?.current.modelSelection
      || !state.modelChoices.some((choice) => choice.available);
    this.modelButton.disabled = this.disabled;
    this.contextButton.disabled = !connected || !state;
    const selection = state?.current.modelSelection;
    this.modelButton.textContent = selection?.model ?? state?.info.model ?? "Connecting";
    this.modelButton.title = selection ? `${selection.model} · Thinking: ${selection.thinking}` : "Model selection is unavailable.";
    this.modelButton.setAttribute("aria-label", `Selected model: ${this.modelButton.title}`);
    const signature = JSON.stringify([state?.current.id, state?.current.revision, selection, state?.modelChoices]);
    if (signature !== this.modelSignature) {
      this.modelSignature = signature;
      if (this.modelPanel.open) this.modelPanel.close();
    }
    this.formDisabled();
    if (!connected || (state?.busy && !changing)) { if (this.modelPanel.open) this.modelPanel.close(); }
    this.renderContext(state);
  }

  openModel(state: WebUiState): void {
    if (this.disabled) return;
    this.buildModel(state); this.open(this.modelPanel, this.modelButton);
  }

  private panel(id: string, title: string, trigger: HTMLButtonElement): HTMLDialogElement {
    const panel = node("dialog", undefined, "composer-popover"); panel.id = id;
    const heading = node("h2", title); heading.id = `${id}-title`;
    panel.setAttribute("aria-labelledby", heading.id); panel.tabIndex = -1;
    const close = node("button", "×", "popover-close"); close.type = "button";
    close.setAttribute("aria-label", `Close ${title.toLowerCase()}`);
    close.addEventListener("click", () => panel.close());
    const error = node("p", undefined, "popover-error"); error.setAttribute("role", "alert"); error.hidden = true;
    panel.append(heading, close, error, node("div", undefined, "popover-content"));
    document.body.append(panel);
    trigger.setAttribute("aria-haspopup", "dialog"); trigger.setAttribute("aria-controls", id);
    trigger.setAttribute("aria-expanded", "false");
    let outside = false;
    const isOutside = (event: MouseEvent) => {
      const bounds = panel.getBoundingClientRect();
      return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
    };
    panel.addEventListener("pointerdown", (event) => { outside = event.target === panel && isOutside(event); });
    panel.addEventListener("click", (event) => { if (outside && event.target === panel && isOutside(event)) panel.close(); outside = false; });
    panel.addEventListener("close", () => { trigger.setAttribute("aria-expanded", "false"); if (!trigger.disabled) trigger.focus({ preventScroll: true }); });
    return panel;
  }

  private open(panel: HTMLDialogElement, trigger: HTMLButtonElement): void {
    if (panel.open) return;
    panel.querySelector<HTMLElement>(".popover-error")!.hidden = true;
    panel.showModal(); this.position(panel, trigger); trigger.setAttribute("aria-expanded", "true");
  }

  private showError(panel: HTMLDialogElement, error: unknown): void {
    const message = panel.querySelector<HTMLElement>(".popover-error")!;
    message.textContent = error instanceof Error ? error.message : "Request failed. Try again.";
    message.hidden = false;
    if (panel.open) this.position(panel, panel === this.modelPanel ? this.modelButton : this.contextButton);
  }

  private position(panel: HTMLDialogElement, trigger: HTMLElement): void {
    const bounds = trigger.getBoundingClientRect();
    // Layout dimensions are unaffected by the scale animation.
    panel.style.left = `${Math.max(8, Math.min(bounds.right - panel.offsetWidth, innerWidth - panel.offsetWidth - 8))}px`;
    panel.style.top = `${Math.max(8, Math.min(bounds.top - panel.offsetHeight - 10, innerHeight - panel.offsetHeight - 8))}px`;
  }

  private buildModel(state: WebUiState): void {
    const selected = state.current.modelSelection!;
    const choices = state.modelChoices.filter((choice) => choice.available);
    let index = choices.findIndex((choice) => sameModel(choice.selection, selected));
    const content = this.modelPanel.querySelector<HTMLElement>(".popover-content")!;
    const select = node("button", undefined, "model-choice"); select.id = "model-choice"; select.type = "button";
    select.setAttribute("aria-label", "Model"); select.setAttribute("aria-haspopup", "listbox");
    select.setAttribute("aria-controls", "model-options"); select.setAttribute("aria-expanded", "false");
    const list = node("div", undefined, "model-options"); list.id = "model-options"; list.role = "listbox";
    list.setAttribute("aria-label", "Available models"); list.hidden = true;
    const range = node("input"); range.type = "range"; range.id = "thinking-level"; range.min = "0"; range.step = "1";
    range.setAttribute("aria-label", "Thinking strength");
    const ticks = node("div", undefined, "thinking-ticks");
    const apply = node("button", "Apply", "model-apply"); apply.type = "button";
    let options = [selected.thinking];
    const optionButtons: HTMLButtonElement[] = [];
    const closeList = (focus = false) => {
      list.hidden = true; select.setAttribute("aria-expanded", "false");
      if (focus) select.focus();
      if (this.modelPanel.open) this.position(this.modelPanel, this.modelButton);
    };
    const update = () => {
      const thinking = options[Number(range.value)]!;
      range.setAttribute("aria-valuetext", thinking);
      const choice = choices[index];
      range.title = choice?.descriptor.thinkingAliases?.[thinking] ? `Provider level: ${choice.descriptor.thinkingAliases[thinking]}` : thinking;
      range.disabled = this.disabled || !choice || options.length < 2;
      range.hidden = options.length === 1 && options[0] === "off";
      ticks.hidden = range.hidden;
      [...ticks.children].forEach((tick, i) => { (tick as HTMLElement).dataset.selected = String(i === Number(range.value)); });
      select.disabled = this.disabled;
      optionButtons.forEach((button) => { button.disabled = this.disabled; });
      apply.disabled = this.disabled || !choice || (sameModel(choice.selection, selected) && thinking === selected.thinking);
    };
    const refresh = () => {
      const choice = choices[index];
      // The picker offers enabled reasoning levels only; saved explicit off remains unchanged until Apply.
      options = choice?.descriptor.thinkingOptions.filter((level) => level !== "off") ?? [];
      if (!options.length) options = ["off"];
      const thinking = choice && sameModel(choice.selection, selected) && options.includes(selected.thinking)
        ? selected.thinking : choice?.descriptor.defaultThinking ?? selected.thinking;
      range.max = String(Math.max(0, options.length - 1)); range.value = String(Math.max(0, options.indexOf(thinking)));
      ticks.replaceChildren(...options.map((option) => node("span", option)));
      select.textContent = choice?.selection.model ?? selected.model;
      optionButtons.forEach((button, i) => { button.setAttribute("aria-selected", String(i === index)); button.tabIndex = i === index ? 0 : -1; });
      update();
    };
    const openList = (last = false) => {
      if (this.disabled) return;
      list.hidden = false; select.setAttribute("aria-expanded", "true");
      this.position(this.modelPanel, this.modelButton);
      const target = last ? optionButtons.at(-1) : optionButtons[Math.max(index, 0)];
      target?.focus(); target?.scrollIntoView({ block: "nearest" });
    };
    choices.forEach((choice, i) => {
      const button = node("button", choice.selection.model, "model-option"); button.type = "button"; button.role = "option";
      button.addEventListener("click", () => { index = i; refresh(); closeList(true); });
      button.addEventListener("keydown", (event) => {
        let next: number | undefined;
        if (event.key === "ArrowDown") next = (i + 1) % choices.length;
        if (event.key === "ArrowUp") next = (i - 1 + choices.length) % choices.length;
        if (event.key === "Home") next = 0;
        if (event.key === "End") next = choices.length - 1;
        if (next !== undefined) { event.preventDefault(); optionButtons[next]?.focus(); }
      });
      optionButtons.push(button); list.append(button);
    });
    list.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeList(true); }
      if (event.key === "Tab") closeList(true);
    });
    select.addEventListener("click", () => { if (list.hidden) openList(); else closeList(); });
    select.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); openList(event.key === "ArrowUp"); }
    });
    range.addEventListener("input", update);
    apply.addEventListener("click", () => {
      if (apply.disabled) return;
      this.modelPanel.querySelector<HTMLElement>(".popover-error")!.hidden = true;
      void this.onSelect({ ...choices[index]!.selection, thinking: options[Number(range.value)]! }, state)
        .catch((error: unknown) => this.showError(this.modelPanel, error));
    });
    this.formDisabled = update;
    content.replaceChildren(select, list, range, ticks, apply); refresh();
  }

  private renderContext(state: WebUiState | undefined): void {
    const usage = state?.contextUsage;
    const estimate = usage?.estimate;
    const notStarted = Boolean(state && state.current.turnCount === 0 && !state.turns.length && state.runningSessionId === null
      && usage?.consumption.requests === 0);
    const input = !notStarted && estimate?.status === "ready" ? estimate.inputTokens : null;
    const capacity = usage?.windowCapacityTokens ?? null;
    const known = input !== null && capacity !== null && capacity > 0;
    const percentage = known ? input / capacity * 100 : null;
    const percent = percentage === null ? "—" : percentage > 0 && percentage < .1 ? "<0.1%" : `${Math.round(percentage * 10) / 10}%`;
    const label = notStarted ? "Context: not started. System instructions and tools are prepared before the first request."
      : input === null ? estimate?.status === "pending" ? "Current context: updating" : "Current context: unknown"
      : `Current context: ${estimate?.status === "ready" && estimate.approximate ? "approximately " : "estimated "}${numbers.format(input)} tokens${percentage === null ? "" : ` (${percent})`}`;
    this.contextButton.title = label;
    this.contextButton.setAttribute("aria-label", `${label}. Open context summary.`);
    this.contextButton.dataset.known = String(known);
    this.contextButton.style.setProperty("--context-percent", `${Math.max(0, Math.min(100, percentage ?? 0))}%`);
    const signature = JSON.stringify([state?.current.id, usage?.estimate, capacity, notStarted]);
    if (signature === this.contextSignature) return;
    this.contextSignature = signature;
    const content = this.contextPanel.querySelector<HTMLElement>(".popover-content")!;
    const row = node("div", undefined, "context-summary");
    const amount = node("span", `${notStarted ? "Not started" : input === null && estimate?.status === "pending" ? "Updating" : `${estimate?.status === "ready" && estimate.approximate ? "≈" : ""}${count(input)}`} / ${count(capacity)}`, "context-amount");
    amount.title = notStarted ? label : estimate?.status === "ready" ? `${label}. ${estimate.method}` : estimate?.reason ?? label;
    row.append(node("span", "Context"), amount, node("span", percent, "context-percentage"));
    const track = node("div", undefined, "context-track"); track.role = "progressbar";
    track.setAttribute("aria-label", label); track.setAttribute("aria-valuemin", "0"); track.setAttribute("aria-valuemax", "100");
    if (known) track.setAttribute("aria-valuenow", String(Math.max(0, Math.min(100, percentage!))));
    track.setAttribute("aria-valuetext", label); track.dataset.known = String(known);
    const bar = node("div"); bar.style.width = `${Math.max(0, Math.min(100, percentage ?? 0))}%`; track.append(bar);
    content.replaceChildren(row, track);
    if (this.contextPanel.open) this.position(this.contextPanel, this.contextButton);
  }
}
