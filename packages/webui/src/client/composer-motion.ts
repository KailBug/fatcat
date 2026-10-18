/** Owns idle presentation only; the page retains the draft and submission lifecycle. */
export class ComposerMotion {
	private enabled = false;
	private collapsed = false;
	private timer: number | undefined;

	constructor(private readonly form: HTMLFormElement, private readonly input: HTMLTextAreaElement,
		private readonly inputRegion: HTMLElement, private readonly wake: HTMLButtonElement,
		private readonly focusInput: () => void) {
		form.dataset.sleepEnabled = "false";
		form.addEventListener("pointerenter", () => this.refresh());
		form.addEventListener("pointerleave", () => this.refresh());
		form.addEventListener("focusin", () => this.refresh());
		form.addEventListener("focusout", () => queueMicrotask(() => this.refresh()));
		input.addEventListener("input", () => this.refresh());
		wake.addEventListener("click", () => {
			this.setCollapsed(false);
			this.focusInput();
			this.refresh();
		});
	}

	update(enabled: boolean): void {
		if (this.enabled !== enabled) this.form.dataset.sleepEnabled = String(enabled);
		this.enabled = enabled;
		this.refresh();
	}

	private canSleep(): boolean {
		return this.enabled && this.input.value.length === 0 && !this.form.matches(":hover")
			&& !this.form.contains(document.activeElement);
	}

	private refresh(): void {
		if (!this.enabled || this.input.value.length > 0) this.setCollapsed(false);
		if (this.collapsed || !this.canSleep()) {
			window.clearTimeout(this.timer);
			this.timer = undefined;
			return;
		}
		if (this.timer !== undefined) return;
		this.timer = window.setTimeout(() => {
			this.timer = undefined;
			if (this.canSleep()) this.setCollapsed(true);
		}, 1200);
	}

	private setCollapsed(collapsed: boolean): void {
		if (this.collapsed === collapsed) return;
		this.collapsed = collapsed;
		this.form.dataset.collapsed = String(collapsed);
		this.inputRegion.inert = collapsed;
		this.inputRegion.setAttribute("aria-hidden", String(collapsed));
		this.wake.disabled = !collapsed;
		this.wake.tabIndex = collapsed ? 0 : -1;
		this.wake.setAttribute("aria-hidden", String(!collapsed));
		this.wake.setAttribute("aria-expanded", String(!collapsed));
	}
}
