import { Marked } from "marked";
import type { MarkedToken, Token, Tokens } from "marked";
import { parseSourceReference } from "./attachments.js";
import { copyControl } from "./copy.js";

const markdown = new Marked({ gfm: true, breaks: false });
const decoder = document.createElement("textarea");
let sequence = 0;

function decode(text: string): string {
	// Escape every literal tag opener before using detached RCDATA to decode entities.
	decoder.innerHTML = text.replaceAll("<", "&lt;");
	return decoder.value;
}

function externalUrl(href: string): string | undefined {
	try {
		const url = new URL(decode(href));
		return ["https:", "http:", "mailto:"].includes(url.protocol) ? url.href : undefined;
	} catch { return undefined; }
}

/** Marked owns syntax; explicit DOM construction never executes source HTML. */
export function renderMarkdown(text: string, openSource?: (reference: string) => void): HTMLElement {
	const root = document.createElement("div"); root.className = "answer";
	const prefix = `answer-${++sequence}-`;
	const headings = new Map<string, HTMLElement>();
	const anchors: { link: HTMLAnchorElement; fragment: string }[] = [];
	const source = (reference: string, label: string): HTMLButtonElement | undefined => {
		if (!openSource || !parseSourceReference(reference)) return undefined;
		const button = document.createElement("button");
		button.type = "button"; button.className = "attachment-citation"; button.textContent = label; button.title = reference;
		button.addEventListener("click", () => openSource(reference));
		return button;
	};
	const appendText = (parent: HTMLElement, value: string): void => {
		if (parent.closest("a")) { parent.append(document.createTextNode(value)); return; }
		const pattern = /attachment:[a-f0-9-]+@[a-f0-9]+(?:#(?:L[0-9]+-L[0-9]+|parse=[a-zA-Z0-9._%-]+&unit=[a-zA-Z0-9._%-]+))?/g;
		let position = 0;
		for (const match of value.matchAll(pattern)) {
			parent.append(document.createTextNode(value.slice(position, match.index)));
			parent.append(source(match[0], "Attachment source") ?? document.createTextNode(match[0]));
			position = match.index + match[0].length;
		}
		parent.append(document.createTextNode(value.slice(position)));
	};
	const render = (tokens: readonly Token[], parent: HTMLElement): void => {
		for (const item of tokens) {
			const token = item as MarkedToken;
			switch (token.type) {
				case "space": case "def": case "checkbox": break;
				case "html": parent.append(document.createTextNode(token.text)); break;
				case "escape": parent.append(document.createTextNode(decode(token.text))); break;
				case "text":
					if (token.tokens) render(token.tokens, parent); else appendText(parent, decode(token.text));
					break;
				case "br": case "hr": parent.append(document.createElement(token.type)); break;
				case "strong": case "em": case "del": case "paragraph": case "blockquote": {
					const element = document.createElement(token.type === "paragraph" ? "p" : token.type);
					parent.append(element); render(token.tokens, element); break;
				}
				case "heading": {
					const heading = document.createElement(`h${Math.min(token.depth + 1, 6)}`); render(token.tokens, heading);
					const base = (heading.textContent ?? "").toLowerCase().trim().replace(/[^\p{L}\p{N}_\s-]/gu, "").replace(/\s+/g, "-") || "section";
					let slug = base;
					for (let index = 1; headings.has(slug); index++) slug = `${base}-${index}`;
					heading.id = prefix + slug; headings.set(slug, heading); parent.append(heading); break;
				}
				case "codespan": {
					const value = token.text;
					const citation = parent.closest("a") ? undefined : source(value, "Attachment source");
					if (citation) parent.append(citation);
					else { const code = document.createElement("code"); code.textContent = value; parent.append(code); }
					break;
				}
				case "code": {
					const block = document.createElement("div"); block.className = "code-block";
					const header = document.createElement("div"); header.className = "code-header";
					const label = document.createElement("span"); label.className = "code-label"; label.textContent = token.lang || "Code";
					const pre = document.createElement("pre"); pre.tabIndex = 0;
					pre.setAttribute("role", "region"); pre.setAttribute("aria-label", token.lang ? `${token.lang} code` : "Code");
					const code = document.createElement("code"); code.textContent = token.text; pre.append(code);
					header.append(label, copyControl(token.text, "Copy code")); block.append(header, pre); parent.append(block); break;
				}
				case "link": case "image": {
					const href = decode(token.href);
					const label = token.type === "image" ? `Image: ${decode(token.text) || "Untitled"}` : decode(token.text);
					if (parent.closest("a")) { parent.append(document.createTextNode(label)); break; }
					const citation = source(href, label);
					if (citation) { parent.append(citation); break; }
					const url = externalUrl(token.href);
					if (!url && !href.startsWith("#")) { parent.append(document.createTextNode(label)); break; }
					const link = document.createElement("a");
					if (token.type === "image") { link.textContent = label; link.className = "markdown-image-link"; }
					else render(token.tokens, link);
					if (token.title) link.title = decode(token.title);
					if (url) { link.href = url; link.target = "_blank"; link.rel = "noopener noreferrer"; }
					else anchors.push({ link, fragment: href.slice(1) });
					parent.append(link); break;
				}
				case "list": {
					const list = document.createElement(token.ordered ? "ol" : "ul");
					if (list instanceof HTMLOListElement && typeof token.start === "number") list.start = token.start;
					for (const entry of token.items) {
						const li = document.createElement("li");
						if (entry.task) {
							li.className = "task-item";
							const box = document.createElement("input"); box.type = "checkbox"; box.disabled = true;
							box.checked = Boolean(entry.checked); box.setAttribute("aria-label", entry.checked ? "Completed task" : "Incomplete task"); li.append(box);
						}
						render(entry.tokens, li); list.append(li);
					}
					parent.append(list); break;
				}
				case "table": {
					const container = document.createElement("div"); container.className = "markdown-table";
					container.tabIndex = 0; container.setAttribute("role", "region"); container.setAttribute("aria-label", "Markdown table");
					const table = document.createElement("table");
					const row = (cells: Tokens.TableCell[], header: boolean): HTMLTableRowElement => {
						const tr = document.createElement("tr");
						cells.forEach((value, index) => {
							const cell = document.createElement(header ? "th" : "td");
							if (header) cell.setAttribute("scope", "col");
							const align = token.align[index]; if (align) cell.className = `align-${align}`;
							render(value.tokens, cell); tr.append(cell);
						}); return tr;
					};
					const head = document.createElement("thead"); head.append(row(token.header, true));
					const body = document.createElement("tbody"); token.rows.forEach((cells) => body.append(row(cells, false)));
					table.append(head, body); container.append(table); parent.append(container); break;
				}
				default: parent.append(document.createTextNode(token.raw));
			}
		}
	};
	try {
		render(markdown.lexer(text), root);
		for (const { link, fragment } of anchors) {
			let slug = fragment;
			try { slug = decodeURIComponent(fragment); } catch { /* Unmatched fragments remain plain text. */ }
			const heading = headings.get(slug);
			if (!heading) { link.replaceWith(...link.childNodes); continue; }
			link.href = `#${heading.id}`;
			link.addEventListener("click", (event) => {
				event.preventDefault(); heading.tabIndex = -1;
				heading.focus({ preventScroll: true }); heading.scrollIntoView({ block: "start", behavior: "instant" });
			});
		}
	} catch {
		root.replaceChildren(); const fallback = document.createElement("p"); fallback.textContent = text; root.append(fallback);
	}
	return root;
}
