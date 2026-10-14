import type { Approval, WebTurn, WebUiState } from "../controller.js";
import { renderMarkdown } from "./markdown.js";
import type { SessionSummary } from "../../src/session/record.js";
import { SessionMenu } from "./session-menu.js";
import type { SessionAction } from "./session-menu.js";
import { SessionDialog } from "./session-dialog.js";
import type { SessionMutation } from "./session-dialog.js";
import { icon } from "./icons.js";
import { PermissionMenu } from "./permission-menu.js";
import { FilePreview } from "./preview.js";
import { BrowserEvidenceView } from "./browser-evidence.js";
import { CronPanel } from "./cron.js";
import { ProjectDialog } from "./projects.js";
import { ProjectMenu } from "./project-menu.js";
import { ProjectActionDialog } from "./project-actions.js";
import { AttachmentsPanel } from "./attachments.js";

function element<T extends HTMLElement>(id: string): T { return document.getElementById(id) as T; }
function node<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  if (className) result.className = className;
  return result;
}
const prompt = element<HTMLTextAreaElement>("prompt");
const send = element<HTMLButtonElement>("send");
const stop = element<HTMLButtonElement>("stop");
const newChat = element<HTMLButtonElement>("new-chat");
const newProject = element<HTMLButtonElement>("new-project");
const sessionList = element("sessions");
const scroll = element("scroll-area");
const messages = element("messages");
const notice = element("notice");
const dialog = element<HTMLDialogElement>("details");
const hashToken = new URLSearchParams(location.hash.slice(1)).get("token");
let token = hashToken ?? "";
try {
  if (hashToken) sessionStorage.setItem("fatcat-token", hashToken);
  else token = sessionStorage.getItem("fatcat-token") ?? "";
} catch { /* The current page still works when browser storage is unavailable. */ }
if (hashToken) history.replaceState(null, "", location.pathname);
let state: WebUiState | undefined;
let etag = "";
let connected = false;
let sending = false;
let approvalId: string | undefined;
let sessionSignature = "";
let detailsSessionId: string | undefined;
const rendered = new Map<string, { signature: string; element: HTMLElement }>();
const sessionMenu = new SessionMenu(element("session-menu"), (action, session) => { void sessionAction(action, session); },
  () => connected && !sending && !state?.busy);
const sessionDialog = new SessionDialog(sessionMutation, () => connected && !sending && !state?.busy);
const permissionMenu = new PermissionMenu(element<HTMLButtonElement>("permission-mode"), element("permission-menu"),
  (mode) => { void api("permission-mode", { mode }); });
const sessionDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const tokenCount = new Intl.NumberFormat("en-US");
const compactTokens = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const filePreview = new FilePreview(() => token);
const browserEvidence = new BrowserEvidenceView(() => token);
const cron = new CronPanel(api);
const projectDialog = new ProjectDialog(request, () => connected && !sending && !state?.busy);
const projectActions = new ProjectActionDialog(request, () => connected && !sending && !state?.busy);
const projectMenu = new ProjectMenu(element("project-menu"), (action, project) => projectActions.open(action, project),
  () => connected && !sending && !state?.busy);
const attachments = new AttachmentsPanel(() => token, () => refresh(true));
element("workspace-picker").addEventListener("click", () => {
  if (state) void api("session/choose-workspace", { id: state.current.id }, 310_000);
});

function showError(message: string): void { notice.textContent = message; notice.hidden = false; }
function controls(): void {
  filePreview.update(connected && !state?.current.projectError);
  const busy = Boolean(state?.busy);
  prompt.disabled = !connected;
  send.hidden = busy; stop.hidden = !busy;
  send.disabled = !connected || sending || !prompt.value.trim() || Boolean(state?.current.projectError);
  stop.disabled = !connected || sending;
  newChat.disabled = !connected || sending || busy;
  newProject.disabled = !connected || sending || busy || !state?.persistent;
  element<HTMLButtonElement>("current-project").disabled = !connected || sending || busy || !state?.persistent || Boolean(state?.current.projectId);
  if (state) sessionMenu.update(displaySessions(state));
  sessionDialog.update();
  projectDialog.update();
  projectActions.update();
  if (state) projectMenu.update(state.projects);
  if (state) attachments.update(state, connected);
  element<HTMLButtonElement>("workspace-picker").disabled = !connected || sending || busy || Boolean(state?.current.projectId);
  sessionList.querySelectorAll<HTMLButtonElement>(".project-new-chat,.project-more").forEach((button) => {
    button.disabled = !connected || sending || busy;
  });
  if (state) cron.update(state, !connected || sending || busy);
  permissionMenu.update(state?.permissionMode, !connected || sending || busy || Boolean(state?.approval));
}
function connection(ok: boolean): void {
  connected = ok;
  element("connection").textContent = ok ? "Local session" : "Disconnected";
  element("connection-dot").hidden = !ok;
  controls();
}
async function api(path: string, body: unknown, timeout = 15_000): Promise<boolean> {
  try { await request(path, body, timeout); return true; }
  catch (error) {
    showError(error instanceof Error ? error.message : "Request failed. Check the local server.");
    return false;
  }
}
async function request<T>(path: string, body: unknown, timeout = 15_000): Promise<T> {
  if (sending) throw new Error("Wait for the current request to finish.");
  sending = true; controls(); notice.hidden = true;
  try {
    const response = await fetch(`/api/${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
    if (!response.ok) throw new Error((await response.json() as { error: string }).error);
    const result = await response.json() as T;
    await refresh(true);
    return result;
  } finally { sending = false; controls(); }
}
async function refresh(force = false): Promise<void> {
  try {
    const response = await fetch("/api/state", { headers: { Authorization: `Bearer ${token}`, ...(!force && etag ? { "If-None-Match": etag } : {}) }, signal: AbortSignal.timeout(10_000) });
    if (response.status === 304) { if (!connected) notice.hidden = true; connection(true); return; }
    if (!response.ok) throw new Error((await response.json() as { error: string }).error);
    const next = await response.json() as WebUiState;
    if (!state || next.revision >= state.revision) {
      etag = response.headers.get("ETag") ?? "";
      render(next);
    }
    if (!connected) notice.hidden = true;
    connection(true);
  } catch (error) {
    connection(false);
    showError(error instanceof Error && !/fetch|timeout|abort/i.test(error.message) ? error.message : "Connection lost. Keep the terminal running; this page will reconnect automatically.");
  }
}

function renderTurn(turn: WebTurn): HTMLElement {
  const article = node("article", undefined, "turn");
  if (turn.automation) article.append(node("div", "Scheduled task", "scheduled-turn-label"));
  article.append(node("div", turn.prompt, "user-message"));
  const label = node("div", undefined, "assistant-label");
  const logo = node("img", undefined, "cat-mark"); logo.src = "/mini-logo.png"; logo.alt = "";
  label.append(logo, node("span", "Fatcat")); article.append(label);
  if (turn.answer) {
    const sessionId = state?.current.id;
    article.append(renderMarkdown(turn.answer, (reference) => {
      if (sessionId) void attachments.openReference(reference, sessionId);
    }));
  }
  if (turn.error) article.append(node("p", `${turn.error}\nThis turn was not saved to model history. Completed operations remain in effect.`, "error"));
  if (turn.sources?.reads.length) {
    const sources = node("details", undefined, "attachment-sources");
    sources.dataset.kind = "sources";
    sources.append(node("summary", `Sources read · ${turn.sources.reads.length} operations`),
      node("p", "These are recorded attachment reads from this chat and its delegated tasks. Reading a location does not prove that an answer analyzed it correctly."));
    const list = node("ul");
    const sessionId = state?.current.id;
    for (const read of turn.sources.reads) {
      const item = node("li");
      item.append(node("strong", `${read.name} · ${read.mode}${read.origin === "subagent" ? " · subagent" : ""}`), node("p", read.summary));
      const links = node("div", undefined, "attachment-actions");
      for (const citation of read.citations) {
        const link = node("button", citation.label, "attachment-citation");
        link.type = "button";
        link.title = citation.reference;
        link.addEventListener("click", () => { if (sessionId) void attachments.openReference(citation.reference, sessionId, read.name); });
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
    for (const check of report.browserChecks ?? []) article.append(browserEvidence.buttons(check));
    const previews = node("div", undefined, "preview-files");
    const paths = new Set(report.writes.filter((write) => write.status === "committed").map((write) => write.path));
    for (let path of paths) {
      path = path.replaceAll("\\", "/");
      const root = state?.info.workspace.replaceAll("\\", "/").replace(/\/$/, "");
      if (root && path.toLowerCase().startsWith(`${root.toLowerCase()}/`)) path = path.slice(root.length + 1);
      if (!/\.(html?|svg)$/i.test(path) || /^(?:\/|[a-z]:)/i.test(path)) continue;
      const button = node("button", `Preview ${path}`, "preview-file-button");
      button.type = "button";
      const selectedPath = path;
      button.addEventListener("click", () => filePreview.open(selectedPath));
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

function renderApproval(approval: Approval | null): void {
  const panel = element("approval");
  panel.hidden = !approval;
  if (!approval) { panel.replaceChildren(); approvalId = undefined; return; }
  if (approval.id === approvalId) return;
  approvalId = approval.id;
  panel.replaceChildren(node("h2", approval.kind === "browser" ? "Allow this browser check?" : approval.kind === "shell" ? "Allow this command?" : "Allow this file change?"));
  if (approval.kind === "browser") {
    panel.append(node("p", "Run this workspace page in an isolated browser. External network access is blocked. JSON and PNG evidence will be saved in fatcat-browser-evidence."));
    panel.append(node("pre", JSON.stringify(approval.request, null, 2)));
  } else if (approval.kind === "shell") {
    panel.append(node("p", `PowerShell · ${approval.request.cwd} · ${approval.request.timeoutMs / 1000}s timeout`));
    panel.append(node("pre", approval.request.command));
    if (approval.request.approvalReason) panel.append(node("p", approval.request.approvalReason, "approval-reason"));
    panel.append(node("p", "Commands run with your Windows user permissions and can access files and the network outside this workspace. This is not an OS sandbox."));
  } else {
    panel.append(node("p", `${approval.request.operation} · ${approval.request.path} · ${approval.request.bytes.toLocaleString("en-US")} bytes`));
    if (approval.request.oldText !== undefined) panel.append(node("p", "Replace this exact text:"), node("pre", approval.request.oldText));
    panel.append(node("p", approval.request.oldText !== undefined ? "With:" : "New file content:"), node("pre", approval.request.newText));
  }
  const actions = node("div", undefined, "approval-actions");
  for (const [label, allowed] of [["Deny", false], ["Allow once", true]] as const) {
    const button = node("button", label, allowed ? "allow" : "deny");
    button.addEventListener("click", async () => {
      const buttons = panel.querySelectorAll("button"); buttons.forEach((item) => { item.disabled = true; });
      await api("approval", { id: approval.id, allowed });
      buttons.forEach((item) => { item.disabled = false; });
    });
    actions.append(button);
  }
  panel.append(actions);
}

function render(next: WebUiState): void {
  if (state && state.info.workspace !== next.info.workspace) filePreview.reset();
  const follow = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 140 || next.turns.length !== state?.turns.length || next.approval?.id !== state?.approval?.id || next.current.id !== state?.current.id;
  state = next;
  element("welcome").hidden = next.turns.length > 0;
  element("model").textContent = next.info.model;
  element("model").title = `${next.info.provider} · ${next.info.model}`;
  renderContextUsage(next);
  element("workspace").textContent = next.info.workspace;
  element("workspace").title = `${next.info.workspace}\nWrite ${next.info.permission} · Shell ${next.info.shellPermission} · Web ${next.info.webPermission}`;
  element("current-project").textContent = next.current.projectName ?? (next.current.projectId ? "Unavailable project" : "Independent chat");
  element("current-project").title = next.current.projectId ? "This chat belongs to its project." : "Move this chat to a project";
  element("current-project").setAttribute("aria-label", next.current.projectId ? `Project: ${next.current.projectName ?? "Unavailable project"}` : "Move current chat to project");
  element("workspace-picker").title = next.current.projectId ? "This chat uses its project folder. Use the project menu to change it for every project chat." : "Change workspace";
  renderSessions(next);
  const warning = element("session-warning");
  warning.hidden = (!next.current.interrupted && !next.current.projectError) || next.busy;
  warning.textContent = next.current.projectError ?? "A turn in this session was interrupted. Model history contains only successful turns. Check current files and commands before retrying; completed operations were not undone.";
  element("run-status").textContent = next.busy ? next.status : next.automationNotice;
  for (const [id, previous] of rendered) {
    if (!next.turns.some((turn) => turn.id === id)) { previous.element.remove(); rendered.delete(id); }
  }
  for (const turn of next.turns) {
    const signature = JSON.stringify(turn);
    const previous = rendered.get(turn.id);
    if (previous?.signature === signature) continue;
    const article = renderTurn(turn);
    if (previous) {
      const openKinds = [...previous.element.querySelectorAll("details[open]")].map((item) => (item as HTMLElement).dataset.kind);
      article.querySelectorAll("details").forEach((item) => { item.open = openKinds.includes(item.dataset.kind); });
      previous.element.replaceWith(article);
    } else messages.append(article);
    rendered.set(turn.id, { signature, element: article });
  }
  renderApproval(next.approval);
  renderDetails(next);
  if (follow) requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
  controls();
}

function renderContextUsage(next: WebUiState): void {
  const { promptTokens, capacityTokens } = next.contextUsage;
  const chip = element("context-usage");
  const known = promptTokens !== null && capacityTokens !== null;
  const percentage = known ? promptTokens / capacityTokens * 100 : 0;
  const percentageLabel = percentage === 0 ? "0%" : percentage < 0.1 ? "<0.1%" : `${Math.round(percentage * 10) / 10}%`;
  element("context-label").textContent = known ? `Context ${percentageLabel}`
    : promptTokens === null ? "Context —" : `Context ${compactTokens.format(promptTokens)} tokens`;
  const usage = promptTokens === null ? "No input token usage is available yet."
    : `Last request input: ${tokenCount.format(promptTokens)} tokens.`;
  const capacity = capacityTokens === null ? "This model's context capacity is unknown."
    : `Model context capacity: ${tokenCount.format(capacityTokens)} tokens.`;
  chip.title = `${usage}\n${capacity}\nProvider-reported input for the latest parent request. Draft text and the latest reply are not counted.`;
  chip.setAttribute("aria-label", `${element("context-label").textContent}. ${usage} ${capacity}`);
  chip.dataset.known = String(known);
  chip.style.setProperty("--context-percent", `${Math.min(100, Math.max(0, percentage))}%`);
}

function renderDetails(next: WebUiState): void {
  if (!detailsSessionId) return;
  const selected = displaySessions(next).find((session) => session.id === detailsSessionId);
  if (!selected) { dialog.close(); return; }
  const content = element("details-content"); content.replaceChildren();
  for (const [key, value] of Object.entries({ Provider: next.info.provider, Model: next.info.model, Workspace: selected.workspace,
    Project: selected.projectName ?? selected.projectId ?? "Independent session", "Project status": selected.projectError ?? "Available",
    "Session ID": selected.id, "Session name": selected.name ?? selected.title,
    "Active session": selected.id === next.current.id ? "Yes" : "No",
    "Saved locally": next.persistent ? "Yes" : "No", "Successful turns": selected.turnCount,
    "Created": selected.createdAt, "Updated": selected.updatedAt,
    "Forked from": selected.forkedFrom ?? "None", "Interrupted turn": selected.interrupted ? "Yes" : "No",
    "Write permission": next.info.permission, "Shell permission": next.info.shellPermission, "Public web": next.info.webPermission,
    "Permission mode": next.permissionMode.mode === "default" ? "Manual" : next.permissionMode.mode === "acceptEdits" ? "Accept edits" : next.permissionMode.mode === "plan" ? "Plan" : next.permissionMode.mode === "freeToGo" ? "Free to go" : "Custom permissions",
    "File access scope": next.permissionMode.fileAccess === "unrestricted" ? "Local files, including outside the workspace" : "Selected workspace",
    "Web tool network scope": next.info.webPermission === "deny" ? "Disabled at launch" : next.permissionMode.networkAccess === "unrestricted" ? "Local and public HTTP(S)" : "Public HTTP(S) only",
    "Parent iteration limit": next.info.maxIterations, "Request budget (bytes)": next.info.maxRequestBytes, "Available skills": next.info.skills,
    "Model context capacity (tokens)": next.contextUsage.capacityTokens === null ? "Unknown" : tokenCount.format(next.contextUsage.capacityTokens),
    "Last parent request input (tokens)": selected.id !== next.current.id || next.contextUsage.promptTokens === null ? "Unavailable" : tokenCount.format(next.contextUsage.promptTokens),
    "Skill warnings": next.info.warnings.join("\n") || "None" })) content.append(node("dt", key), node("dd", String(value)));
}

function displaySessions(next: WebUiState): SessionSummary[] {
  if (next.current.revision === 0) return next.sessions;
  return next.sessions.some((session) => session.id === next.current.id) ? next.sessions : [next.current, ...next.sessions];
}

function renderSessions(next: WebUiState): void {
  const sessions = displaySessions(next);
  const signature = JSON.stringify([next.current.id, sessions, next.projects]);
  if (signature === sessionSignature) return;
  sessionSignature = signature;
  sessionList.replaceChildren();
  const groups = new Map<string, HTMLElement>();
  for (const project of next.projects) {
    const group = node("section", undefined, "project-group");
    group.dataset.projectId = project.id;
    group.setAttribute("aria-label", `Project ${project.name}`);
    const heading = node("div", undefined, "project-heading");
    const name = node("span", project.name, "project-name");
    name.title = `${project.name}\n${project.workspace}`;
    const create = node("button", undefined, "project-new-chat icon-button");
    create.type = "button";
    create.setAttribute("aria-label", `New chat in ${project.name}`);
    create.title = `New chat in ${project.name}`;
    create.append(icon("plus"));
    create.addEventListener("click", () => {
      void api("session/new", { projectId: project.id }).then((accepted) => { if (accepted) sessionChanged(); });
    });
    const more = node("button", undefined, "project-more icon-button");
    more.type = "button";
    more.dataset.projectActionId = project.id;
    more.setAttribute("aria-label", `Actions for project ${project.name}`);
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-controls", "project-menu");
    more.setAttribute("aria-expanded", "false");
    more.title = "Project actions";
    more.append(icon("ellipsis"));
    const openProjectMenu = () => {
      sessionMenu.close();
      const bounds = more.getBoundingClientRect();
      projectMenu.open(project, more, bounds.left, bounds.bottom + 4);
    };
    more.addEventListener("click", openProjectMenu);
    more.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
        event.preventDefault(); openProjectMenu();
      }
    });
    heading.addEventListener("contextmenu", (event) => {
      event.preventDefault(); openProjectMenu();
    });
    const actions = node("div", undefined, "project-heading-actions");
    actions.append(create, more);
    heading.append(name, actions);
    group.append(heading);
    group.addEventListener("dragover", (event) => {
      if (!connected || sending || state?.busy || !event.dataTransfer?.types.includes("application/x-fatcat-session")) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      group.classList.add("project-drop-target");
    });
    group.addEventListener("dragleave", (event) => {
      if (!(event.relatedTarget instanceof Node) || !group.contains(event.relatedTarget)) group.classList.remove("project-drop-target");
    });
    group.addEventListener("drop", (event) => {
      event.preventDefault();
      group.classList.remove("project-drop-target");
      const id = event.dataTransfer?.getData("application/x-fatcat-session");
      const selected = state && displaySessions(state).find((session) => session.id === id);
      if (state && selected) projectDialog.join(selected, state, project.id);
    });
    groups.set(project.id, group);
    sessionList.append(group);
  }
  const independent = node("section", undefined, "independent-sessions");
  independent.setAttribute("aria-label", "Independent chats");
  if (next.projects.length) independent.append(node("div", "Independent chats", "section-label"));
  sessionList.append(independent);
  if (sessions.length === 0 && next.projects.length === 0) {
    sessionList.append(node("p", "Your conversations will appear here after your first message.", "session-empty"));
  }
  for (const session of sessions) {
    const button = node("button", undefined, "conversation");
    const selected = session.id === next.current.id;
    button.setAttribute("aria-current", String(selected));
    const metadata = `${session.turnCount} ${session.turnCount === 1 ? "turn" : "turns"} · ${sessionDate.format(new Date(session.updatedAt))} · ${session.workspace}`;
    button.title = `${session.name ?? session.title}\n${metadata}\n${session.id}`;
    button.setAttribute("aria-description", metadata);
    button.dataset.sessionId = session.id;
    button.draggable = !session.projectId;
    button.addEventListener("dragstart", (event) => {
      if (!connected || sending || state?.busy || session.projectId) { event.preventDefault(); return; }
      event.dataTransfer?.setData("application/x-fatcat-session", session.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      sessionMenu.close();
    });
    button.addEventListener("dragend", () => {
      sessionList.querySelectorAll(".project-drop-target").forEach((group) => group.classList.remove("project-drop-target"));
    });
    button.setAttribute("aria-haspopup", "menu");
    const copy = node("span", undefined, "session-copy");
    copy.append(node("span", session.name ?? session.title, "session-name"));
    button.append(copy);
    button.addEventListener("click", () => {
      sessionMenu.close();
      if (!connected || sending || state?.busy) return;
      if (selected) { scroll.scrollTop = scroll.scrollHeight; closeSidebar(); return; }
      void api("session/resume", { id: session.id }).then((accepted) => { if (accepted) sessionChanged(); });
    });
    button.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      sessionMenu.open(session, button, event.clientX, event.clientY);
    });
    button.addEventListener("keydown", (event) => {
      if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
        event.preventDefault();
        const bounds = button.getBoundingClientRect();
        sessionMenu.open(session, button, bounds.left + 16, bounds.bottom);
      }
    });
    const row = node("div", undefined, "session-row");
    row.dataset.active = String(selected);
    const more = node("button", undefined, "session-more icon-button");
    more.type = "button";
    more.setAttribute("aria-label", `Actions for ${session.name ?? session.title}`);
    more.setAttribute("aria-haspopup", "menu");
    more.setAttribute("aria-controls", "session-menu");
    more.setAttribute("aria-expanded", "false");
    more.title = "Session actions";
    more.append(icon("ellipsis"));
    more.addEventListener("click", () => {
      const bounds = more.getBoundingClientRect();
      sessionMenu.open(session, more, bounds.left, bounds.bottom + 4);
    });
    row.append(button, more);
    if (session.automationCount) {
      const clock = node("span", undefined, "session-clock");
      clock.title = `${session.automationCount} linked automation task(s)`;
      clock.setAttribute("aria-label", clock.title);
      clock.append(icon("clock"));
      row.append(clock);
    }
    if (session.projectId && !groups.has(session.projectId)) {
      const missing = node("section", undefined, "project-group");
      missing.append(node("div", session.projectName ?? "Unavailable project", "project-heading"));
      groups.set(session.projectId, missing);
      sessionList.insertBefore(missing, independent);
    }
    (session.projectId ? groups.get(session.projectId)! : independent).append(row);
  }
}

function closeSidebar(restoreFocus = false): void {
  sessionMenu.close();
  document.body.classList.remove("sidebar-open");
  element("toggle-sidebar").setAttribute("aria-expanded", "false");
  element("sidebar").removeAttribute("role");
  element("sidebar").removeAttribute("aria-modal");
  document.querySelector("main")!.inert = false;
  if (restoreFocus) element("toggle-sidebar").focus();
}

function sessionChanged(): void { prompt.value = ""; resize(); requestAnimationFrame(() => prompt.focus()); closeSidebar(); }

async function sessionAction(action: SessionAction, session: SessionSummary): Promise<void> {
  if (action === "workspace") { await api("session/choose-workspace", { id: session.id }, 310_000); return; }
  if (action === "project") { if (state) projectDialog.join(session, state); return; }
  if (action === "details") {
    if (!state) return;
    detailsSessionId = session.id;
    renderDetails(state);
    dialog.showModal();
    return;
  }
  if (!connected || sending || state?.busy) return;
  sessionDialog.open(action, session);
}

async function sessionMutation(action: SessionMutation, session: SessionSummary, name?: string): Promise<string | undefined> {
  let accepted = false;
  if (action === "rename") {
    accepted = await api("session/rename", { id: session.id, name });
  } else if (action === "fork") {
    accepted = await api("session/fork", { id: session.id, ...(name ? { name } : {}) });
    if (accepted) sessionChanged();
  } else if (action === "delete") {
    const currentId = state?.current.id;
    accepted = await api("session/delete", { id: session.id, revision: session.revision });
    if (accepted && state?.current.id !== currentId) sessionChanged();
  }
  return accepted ? undefined : notice.textContent || "The session could not be changed. Try again.";
}

function resize(): void { prompt.style.height = "auto"; prompt.style.height = `${Math.min(prompt.scrollHeight, 180)}px`; controls(); }
element<HTMLFormElement>("composer").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!connected || state?.busy || sending || !prompt.value.trim() || state?.current.projectError) return;
  const draft = prompt.value;
  void api("message", { prompt: draft }).then((accepted) => {
    if (accepted && prompt.value === draft) { prompt.value = ""; resize(); }
    prompt.focus();
  });
});
prompt.addEventListener("input", resize);
prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault(); element<HTMLFormElement>("composer").requestSubmit();
  }
});
stop.addEventListener("click", () => { void api("stop", {}); });
newChat.addEventListener("click", () => {
  void api("session/new", { projectId: null }).then((accepted) => { if (accepted) sessionChanged(); });
});
newProject.addEventListener("click", () => projectDialog.create());
element("current-project").addEventListener("click", () => { if (state) projectDialog.join(state.current, state); });
element("close-details").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => { detailsSessionId = undefined; });
element("toggle-sidebar").addEventListener("click", () => {
  if (document.body.classList.contains("sidebar-open")) {
    closeSidebar(true);
    return;
  }
  document.body.classList.add("sidebar-open");
  element("toggle-sidebar").setAttribute("aria-expanded", "true");
  element("sidebar").setAttribute("role", "dialog");
  element("sidebar").setAttribute("aria-modal", "true");
  document.querySelector("main")!.inert = true;
  element("close-sidebar").focus();
});
element("close-sidebar").addEventListener("click", () => closeSidebar(true));
element("sidebar-backdrop").addEventListener("click", () => closeSidebar(true));
window.matchMedia("(max-width: 760px)").addEventListener("change", () => closeSidebar());
document.addEventListener("click", (event) => {
  if (event.target instanceof Element && !event.target.closest("aside, #toggle-sidebar, #session-menu, dialog")) {
    closeSidebar();
  }
});
document.addEventListener("keydown", (event) => {
  if (!document.body.classList.contains("sidebar-open") || document.querySelector("dialog[open]")) return;
  if (event.key === "Escape") {
    event.preventDefault();
    closeSidebar(true);
    return;
  }
  if (event.key !== "Tab" || !element("session-menu").hidden) return;
  const buttons = element("sidebar").querySelectorAll<HTMLElement>("a[href], button:not(:disabled)");
  const first = buttons[0];
  const last = buttons[buttons.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last?.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first?.focus();
  }
});
async function poll(): Promise<void> { await refresh(); window.setTimeout(() => { void poll(); }, document.hidden ? 3000 : 700); }
void poll();
