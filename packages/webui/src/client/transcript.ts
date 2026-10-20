import type { BrowserRecord } from "@fatcat/runtime/browser/protocol";
import type { WebTurn } from "../types.js";
import { renderMarkdown } from "./markdown.js";
import { copyControl } from "./copy.js";

interface TranscriptActions {
	openReference(reference: string, sessionId: string, name?: string): void;
	openPreview(path: string): void;
	browserButtons(check: BrowserRecord & { laterWriteAttempt?: boolean }): HTMLElement;
}

function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
	const result = document.createElement(tag);
	if (text !== undefined) result.textContent = text;
	if (className) result.className = className;
	return result;
}

/** Owns rendered nodes only; the page owns the current snapshot and scroll policy. */
export class TranscriptView {
	private readonly rendered = new Map<string, { signature: string; element: HTMLElement }>();

	constructor(private readonly container: HTMLElement, private readonly actions: TranscriptActions) {}

	update(turns: readonly WebTurn[], sessionId: string, workspace: string): void {
		for (const [id, previous] of this.rendered) {
			if (!turns.some((turn) => turn.id === id)) { previous.element.remove(); this.rendered.delete(id); }
		}
		for (const turn of turns) {
			const signature = JSON.stringify(turn);
			const previous = this.rendered.get(turn.id);
			if (previous?.signature === signature) continue;
			const article = this.renderTurn(turn, sessionId, workspace);
			if (previous) {
				const openKinds = [...previous.element.querySelectorAll("details[open]")].map((item) => (item as HTMLElement).dataset.kind);
				article.querySelectorAll("details").forEach((item) => { item.open = openKinds.includes(item.dataset.kind); });
				previous.element.replaceWith(article);
			} else this.container.append(article);
			this.rendered.set(turn.id, { signature, element: article });
		}
	}

	private renderTurn(turn: WebTurn, sessionId: string, workspace: string): HTMLElement {
		const article = node("article", undefined, "turn");
		if (turn.automation) article.append(node("div", "Scheduled task", "scheduled-turn-label"));
		article.append(node("div", turn.prompt, "user-message"));
		const label = node("div", undefined, "assistant-label");
		const logo = node("img", undefined, "cat-mark"); logo.src = "/looking.png"; logo.alt = "";
		label.append(logo, node("span", "Fatcat")); article.append(label);
		if (turn.answer) {
			article.append(renderMarkdown(turn.answer, (reference) => {
				if (sessionId) void this.actions.openReference(reference, sessionId);
			}));
			const actions = node("div", undefined, "answer-actions");
			const copy = copyControl(turn.answer, "Copy answer");
			copy.title = "Copy answer as Markdown";
			actions.append(copy);
			article.append(actions);
		}
		if (turn.error) article.append(node("p", `${turn.error}\nThis turn was not saved to model history. Completed operations remain in effect.`, "error"));
		if (turn.sources?.reads.length) {
			const sources = node("details", undefined, "attachment-sources");
			sources.dataset.kind = "sources";
			sources.append(node("summary", `Sources read · ${turn.sources.reads.length} operations`),
				node("p", "These are recorded attachment reads from this chat and its delegated tasks. Reading a location does not prove that an answer analyzed it correctly."));
			const list = node("ul");
			for (const read of turn.sources.reads) {
				const item = node("li");
				item.append(node("strong", `${read.name} · ${read.mode}${read.origin === "subagent" ? " · subagent" : ""}`), node("p", read.summary));
				const links = node("div", undefined, "attachment-actions");
				for (const citation of read.citations) {
					const link = node("button", citation.label, "attachment-citation");
					link.type = "button";
					link.title = citation.reference;
					link.addEventListener("click", () => { if (sessionId) void this.actions.openReference(citation.reference, sessionId, read.name); });
					links.append(link);
				}
				item.append(links);
				for (const warning of read.warnings) item.append(node("p", warning));
				if (read.omittedLocations) item.append(node("p", `${read.omittedLocations} additional source locations are not listed in this bounded summary.`));
				list.append(item);
			}
			sources.append(list);
			if (turn.sources.omittedReads) sources.append(node("p", `${turn.sources.omittedReads} additional attachment reads are not listed in this bounded summary.`));
			article.append(sources);
		}
		if (turn.status === "running") article.append(node("p", "Working on it…", "waiting"));
		if (turn.activity.length) {
			const activity = node("details"); activity.dataset.kind = "activity";
			activity.append(node("summary", `Activity · ${turn.activity.length} recent events`));
			const list = node("ul"); turn.activity.forEach((entry) => list.append(node("li", entry))); activity.append(list); article.append(activity);
		}
		if (turn.report) {
			const report = turn.report;
			for (const check of report.browserChecks ?? []) article.append(this.actions.browserButtons(check));
			const previews = node("div", undefined, "preview-files");
			const paths = new Set(report.writes.filter((write) => write.status === "committed").map((write) => write.path));
			for (let path of paths) {
				path = path.replaceAll("\\", "/");
				const root = workspace.replaceAll("\\", "/").replace(/\/$/, "");
				if (root && path.toLowerCase().startsWith(`${root.toLowerCase()}/`)) path = path.slice(root.length + 1);
				if (!/\.(html?|svg)$/i.test(path) || /^(?:\/|[a-z]:)/i.test(path)) continue;
				const button = node("button", `Preview ${path}`, "preview-file-button");
				button.type = "button";
				const selectedPath = path;
				button.addEventListener("click", () => this.actions.openPreview(selectedPath));
				previews.append(button);
			}
			if (previews.childElementCount) article.append(previews);
			const details = node("details"); details.dataset.kind = "report";
			details.append(node("summary", `Execution report · ${report.modelRequests.parent + report.modelRequests.children} requests · ${report.writes.length} writes · ${report.commands.length} commands`));
			details.append(node("p", "Task verification is not assessed automatically. Token totals cover only requests with valid provider usage reports."));
			details.append(node("pre", JSON.stringify(report, null, 2))); article.append(details);
		}
		return article;
	}
}
