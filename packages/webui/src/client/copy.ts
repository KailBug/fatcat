/** Copies explicit display content without reading or changing session state. */
export function copyControl(text: string, label: string): HTMLElement {
	const control = document.createElement("div");
	control.className = "copy-control";
	const button = document.createElement("button");
	button.type = "button";
	button.className = "copy-button";
	button.textContent = label;
	button.setAttribute("aria-label", label);
	const status = document.createElement("span");
	status.className = "sr-only";
	status.role = "status";
	let copying = false;
	button.addEventListener("click", async () => {
		if (copying) return;
		copying = true;
		button.setAttribute("aria-disabled", "true");
		button.textContent = "Copying…";
		status.textContent = "";
		status.className = "sr-only";
		try {
			await navigator.clipboard.writeText(text);
			button.textContent = "Copied";
			status.textContent = "Copied to clipboard.";
		} catch {
			button.textContent = label;
			status.className = "copy-error";
			status.textContent = "Copy failed. Try again or select the text and copy manually.";
		} finally {
			copying = false;
			button.removeAttribute("aria-disabled");
		}
	});
	button.addEventListener("blur", () => { if (!copying) button.textContent = label; });
	control.append(button, status);
	return control;
}
