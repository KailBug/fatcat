type Theme = "system" | "light" | "dark";

/** Owns local display preferences and the settings dialog, never execution policy. */
export class SettingsPanel {
	private theme: Theme = "system";
	private readonly systemTheme = window.matchMedia("(prefers-color-scheme: dark)");

	constructor(private readonly trigger: HTMLButtonElement, private readonly panel: HTMLDialogElement,
		showDetails: () => void) {
		try {
			const saved = localStorage.getItem("fatcat-theme");
			if (saved === "light" || saved === "dark") this.theme = saved;
		} catch { /* Display preferences remain usable when browser storage is unavailable. */ }
		this.applyTheme();
		this.systemTheme.addEventListener("change", () => this.applyTheme());
		panel.querySelectorAll<HTMLInputElement>('input[name="theme"]').forEach((input) => {
			input.checked = input.value === this.theme;
			input.addEventListener("change", () => {
				if (input.value !== "system" && input.value !== "light" && input.value !== "dark") return;
				this.theme = input.value;
				this.applyTheme();
				try { localStorage.setItem("fatcat-theme", this.theme); } catch { /* Keep the current selection for this page. */ }
			});
		});
		panel.querySelector<HTMLButtonElement>("#settings-session")!.addEventListener("click", () => {
			this.close(true);
			showDetails();
		});
		trigger.addEventListener("click", () => {
			if (panel.open) return;
			panel.showModal();
			trigger.setAttribute("aria-expanded", "true");
		});
		panel.querySelector<HTMLButtonElement>("#close-settings")!.addEventListener("click", () => this.close(true));
		panel.addEventListener("close", () => trigger.setAttribute("aria-expanded", "false"));
		panel.addEventListener("keydown", (event) => {
			if (event.key === "Tab") {
				const controls = [...panel.querySelectorAll<HTMLElement>("button:not(:disabled), summary, input:checked")]
					.filter((control) => control.getClientRects().length > 0);
				const first = controls[0];
				const last = controls.at(-1);
				if (event.shiftKey && document.activeElement === first) {
					event.preventDefault(); last?.focus();
				} else if (!event.shiftKey && document.activeElement === last) {
					event.preventDefault(); first?.focus();
				}
				return;
			}
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			this.close(true);
		});
		const outside = (event: MouseEvent) => {
			const bounds = panel.getBoundingClientRect();
			return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom;
		};
		let startedOutside = false;
		panel.addEventListener("pointerdown", (event) => { startedOutside = event.target === panel && outside(event); });
		panel.addEventListener("click", (event) => {
			if (startedOutside && event.target === panel && outside(event)) this.close(true);
			startedOutside = false;
		});
	}

	update(hasSession: boolean): void {
		this.panel.querySelector<HTMLButtonElement>("#settings-session")!.disabled = !hasSession;
	}

	close(restoreFocus = false): void {
		if (!this.panel.open) return;
		this.panel.close();
		this.trigger.setAttribute("aria-expanded", "false");
		if (restoreFocus) this.trigger.focus();
	}

	private applyTheme(): void {
		document.documentElement.dataset.theme = this.theme === "system" ? (this.systemTheme.matches ? "dark" : "light") : this.theme;
	}
}
