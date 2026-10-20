/** Owns only the preview's local width preference and pointer/keyboard interaction. */
export class PreviewResize {
	private preferred: number | undefined;
	private drag: { id: number; x: number; width: number; preferred: number | undefined } | undefined;
	private visible = false;
	private readonly storageKey = "fatcat-preview-width";

	constructor(private readonly handle: HTMLElement, private readonly panel: HTMLElement) {
		try {
			const value = Number(localStorage.getItem(this.storageKey));
			if (Number.isFinite(value) && value >= 200 && value <= 20000) this.preferred = value;
		} catch { /* Width remains adjustable without browser storage. */ }
		window.addEventListener("resize", () => this.apply());
		handle.addEventListener("pointerdown", (event) => {
			if (!this.visible || event.button !== 0 || this.drag) return;
			event.preventDefault();
			handle.focus();
			this.drag = { id: event.pointerId, x: event.clientX, width: panel.getBoundingClientRect().width, preferred: this.preferred };
			handle.setPointerCapture(event.pointerId);
			document.body.classList.add("preview-resizing");
		});
		handle.addEventListener("pointermove", (event) => {
			if (this.drag?.id !== event.pointerId) return;
			this.preferred = this.clamp(this.drag.width + this.drag.x - event.clientX);
			this.apply();
		});
		handle.addEventListener("pointerup", (event) => { if (this.drag?.id === event.pointerId) this.finish(true); });
		handle.addEventListener("pointercancel", () => this.finish(false));
		handle.addEventListener("lostpointercapture", () => this.finish(false));
		handle.addEventListener("dblclick", () => this.reset());
		handle.addEventListener("keydown", (event) => {
			if (event.key === "Escape" && this.drag) { event.preventDefault(); this.finish(false); return; }
			if (event.key === "Enter") { event.preventDefault(); this.reset(); return; }
			const step = event.shiftKey ? 64 : 16;
			const width = panel.getBoundingClientRect().width;
			const limits = this.limits();
			const next = event.key === "ArrowLeft" ? width + step : event.key === "ArrowRight" ? width - step
				: event.key === "Home" ? limits.min : event.key === "End" ? limits.max : undefined;
			if (next === undefined) return;
			event.preventDefault();
			this.preferred = this.clamp(next);
			this.apply(); this.save();
		});
	}

	update(visible: boolean): void {
		if (!visible) this.finish(false);
		this.visible = visible;
		this.handle.hidden = !visible;
		this.apply();
	}

	private limits(): { min: number; max: number } {
		const style = getComputedStyle(document.documentElement);
		const min = Number.parseFloat(style.getPropertyValue("--preview-min-width"));
		const conversation = Number.parseFloat(style.getPropertyValue("--conversation-min-width"));
		const sidebar = document.getElementById("sidebar")!.getBoundingClientRect().width;
		return { min, max: Math.max(min, innerWidth - sidebar - this.handle.getBoundingClientRect().width - conversation) };
	}

	private clamp(width: number): number {
		const { min, max } = this.limits();
		return Math.max(min, Math.min(width, max));
	}

	private apply(): void {
		if (!this.visible) { this.panel.style.removeProperty("--preview-width"); return; }
		if (this.preferred === undefined) this.panel.style.removeProperty("--preview-width");
		else this.panel.style.setProperty("--preview-width", `${this.clamp(this.preferred)}px`);
		const { min, max } = this.limits();
		const width = Math.round(this.panel.getBoundingClientRect().width);
		this.handle.setAttribute("aria-valuemin", String(Math.round(min)));
		this.handle.setAttribute("aria-valuemax", String(Math.round(max)));
		this.handle.setAttribute("aria-valuenow", String(width));
		this.handle.setAttribute("aria-valuetext", `${width} pixels`);
	}

	private finish(commit: boolean): void {
		if (!this.drag) return;
		const drag = this.drag;
		this.drag = undefined;
		if (this.handle.hasPointerCapture(drag.id)) this.handle.releasePointerCapture(drag.id);
		document.body.classList.remove("preview-resizing");
		if (commit) this.save(); else this.preferred = drag.preferred;
		this.apply();
	}

	private reset(): void { this.finish(false); this.preferred = undefined; this.apply(); this.save(); }

	private save(): void {
		try {
			if (this.preferred === undefined) localStorage.removeItem(this.storageKey);
			else localStorage.setItem(this.storageKey, String(this.preferred));
		} catch { /* Keep the current width for this page. */ }
	}
}
