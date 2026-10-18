import assert from "node:assert/strict";
import type { Page } from "playwright";
import type { WebTurn, WebUiState } from "@fatcat/webui/internal/types";

/** Exercise the served view modules in Edge without changing the application's session. */
export async function verifyWebUiViews(page: Page, state: WebUiState): Promise<void> {
	const result = await page.evaluate(async (snapshot) => {
		const transcriptPath = "/transcript.js";
		const sessionListPath = "/session-list.js";
		const { TranscriptView } = await import(transcriptPath);
		const { SessionListView } = await import(sessionListPath);
		const container = document.createElement("div");
		const opened: string[][] = [];
		const transcript = new TranscriptView(container, {
			openReference: (reference: string, sessionId: string) => opened.push([reference, sessionId]),
			openPreview: () => { throw new Error("Unexpected preview"); },
			browserButtons: () => { throw new Error("Unexpected browser evidence"); },
		});
		const reference = `attachment:00000000-0000-4000-8000-000000000000@${"a".repeat(64)}#L1-L1`;
		const turn: WebTurn = {
			id: "view-fixture", prompt: "Read source", answer: `[Evidence](${reference})`, status: "answered",
			activity: ["read · completed"], sources: { reads: [{
				origin: "parent", name: "source.txt", reference: reference.split("#")[0]!, mode: "lines",
				summary: "One line read", citations: [{ reference, label: "Line 1" }], warnings: [], omittedLocations: 0,
			}], omittedReads: 0 },
		};
		transcript.update([turn], "original-session", snapshot.info.workspace);
		const article = container.firstElementChild;
		const oldCitation = container.querySelector<HTMLButtonElement>(".attachment-citation")!;
		container.querySelectorAll("details").forEach((details) => { details.open = true; });
		transcript.update([structuredClone(turn)], "original-session", snapshot.info.workspace);
		const reused = container.firstElementChild === article;
		transcript.update([{ ...turn, activity: [...turn.activity, "More evidence"] }], "original-session", snapshot.info.workspace);
		const replaced = container.firstElementChild !== article;
		const expanded = [...container.querySelectorAll("details[open]")].map((details) => (details as HTMLElement).dataset.kind);
		transcript.update([], "different-session", snapshot.info.workspace);
		oldCitation.click();
		const removed = container.childElementCount === 0;

		const listContainer = document.createElement("div");
		let canManage = true;
		const selections: string[] = [];
		const joins: string[][] = [];
		const list = new SessionListView(listContainer, {
			canManage: () => canManage,
			createChat: () => {},
			selectSession: (session: { id: string }) => selections.push(session.id),
			joinProject: (sessionId: string, projectId: string) => joins.push([sessionId, projectId]),
			closeSessionMenu: () => {}, openSessionMenu: () => {}, openProjectMenu: () => {},
		});
		const session = snapshot.sessions[0]!;
		const project = { id: "view-project", name: "View project", workspace: session.workspace };
		const next = { current: session, sessions: [session], projects: [project] };
		list.update(next);
		const button = listContainer.querySelector<HTMLButtonElement>(".conversation")!;
		list.update(structuredClone(next));
		const listReused = button === listContainer.querySelector(".conversation");
		list.setDisabled(true);
		const disabled = [...listContainer.querySelectorAll<HTMLButtonElement>(".project-new-chat,.project-more")].every((item) => item.disabled);
		list.setDisabled(false);
		const enabled = [...listContainer.querySelectorAll<HTMLButtonElement>(".project-new-chat,.project-more")].every((item) => !item.disabled);
		canManage = false;
		const blockedDrag = new DragEvent("dragstart", { cancelable: true, dataTransfer: new DataTransfer() });
		button.dispatchEvent(blockedDrag);
		canManage = true;
		const dataTransfer = new DataTransfer();
		button.dispatchEvent(new DragEvent("dragstart", { cancelable: true, dataTransfer }));
		listContainer.querySelector(".project-group")!.dispatchEvent(new DragEvent("drop", { cancelable: true, dataTransfer }));
		button.click();
		listContainer.querySelector<HTMLButtonElement>(".project-toggle")!.click();
		list.update({ ...next, projects: [{ ...project, name: "Renamed project" }],
			sessions: [session, { ...session, id: "new-session", projectId: project.id }] });
		const collapsedAfterRefresh = listContainer.querySelector<HTMLElement>(".project-sessions")!.hidden;
		const collapsedLabel = listContainer.querySelector(".project-toggle")!.getAttribute("aria-label");
		listContainer.querySelector<HTMLButtonElement>(".project-toggle")!.click();
		const expandedAfterClick = !listContainer.querySelector<HTMLElement>(".project-sessions")!.hidden;
		return { reused, replaced, expanded, removed, opened, reference, listReused, disabled, enabled,
			blockedDrag: blockedDrag.defaultPrevented, selections, joins, sessionId: session.id,
			collapsedAfterRefresh, collapsedLabel, expandedAfterClick };
	}, state);
	assert.equal(result.reused, true);
	assert.equal(result.replaced, true);
	assert.deepEqual(result.expanded, ["sources", "activity"]);
	assert.equal(result.removed, true);
	assert.deepEqual(result.opened, [[result.reference, "original-session"]]);
	assert.equal(result.listReused, true);
	assert.equal(result.disabled, true);
	assert.equal(result.enabled, true);
	assert.equal(result.blockedDrag, true);
	assert.deepEqual(result.selections, [result.sessionId]);
	assert.deepEqual(result.joins, [[result.sessionId, "view-project"]]);
	assert.equal(result.collapsedAfterRefresh, true);
	assert.equal(result.collapsedLabel, "Expand Renamed project");
	assert.equal(result.expandedAfterClick, true);
}
