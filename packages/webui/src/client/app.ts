import type { PendingApproval as Approval } from "@fatcat/runtime/permissions/types";
import type { WebUiState } from "../types.js";
import { TranscriptView } from "./transcript.js";
import { displaySessions, SessionListView } from "./session-list.js";
import type { SessionSummary } from "@fatcat/runtime/session/record";
import { SessionMenu } from "./session-menu.js";
import type { SessionAction } from "./session-menu.js";
import { SessionDialog } from "./session-dialog.js";
import type { SessionMutation } from "./session-dialog.js";
import { PermissionMenu } from "./permission-menu.js";
import { FilePreview } from "./preview.js";
import { BrowserEvidenceView } from "./browser-evidence.js";
import { CronPanel } from "./cron.js";
import { ProjectDialog } from "./projects.js";
import { ProjectMenu } from "./project-menu.js";
import { ProjectActionDialog } from "./project-actions.js";
import { AttachmentsPanel } from "./attachments.js";
import { SettingsPanel } from "./settings.js";
import { ComposerMotion } from "./composer-motion.js";
import { ModelControls } from "./model-controls.js";

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
const home = element<HTMLAnchorElement>("home");
const newProject = element<HTMLButtonElement>("new-project");
const scroll = element("scroll-area");
const scrollBottom = element<HTMLButtonElement>("scroll-bottom");
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
let detailsSessionId: string | undefined;
const sessionSearch = element<HTMLInputElement>("session-search");
const clearSessionSearch = element<HTMLButtonElement>("clear-session-search");
let sessionQuery = "";
const sessionMenu = new SessionMenu(element("session-menu"), (action, session) => { void sessionAction(action, session); },
  () => connected && !sending && !state?.busy);
const sessionDialog = new SessionDialog(sessionMutation, () => connected && !sending && !state?.busy);
const permissionMenu = new PermissionMenu(element<HTMLButtonElement>("permission-mode"), element("permission-menu"),
  (mode) => { void api("permission-mode", { mode }); });
const tokenCount = new Intl.NumberFormat("en-US");
const filePreview = new FilePreview(() => token);
const browserEvidence = new BrowserEvidenceView(() => token);
const cron = new CronPanel(api);
const projectDialog = new ProjectDialog(request, () => connected && !sending && !state?.busy);
const projectActions = new ProjectActionDialog(request, () => connected && !sending && !state?.busy);
const projectMenu = new ProjectMenu(element("project-menu"), (action, project) => projectActions.open(action, project),
  () => connected && !sending && !state?.busy);
const attachments = new AttachmentsPanel(() => token, () => refresh(true));
const settings = new SettingsPanel(element<HTMLButtonElement>("show-settings"), element<HTMLDialogElement>("settings-panel"), () => {
  if (state) void sessionAction("details", state.current);
});
const composerMotion = new ComposerMotion(element<HTMLFormElement>("composer"), prompt, element("composer-input"),
  element<HTMLButtonElement>("wake-composer"), () => { resize(); prompt.focus({ preventScroll: true }); });
const transcript = new TranscriptView(element("messages"), {
  openReference: (reference, sessionId, name) => { void attachments.openReference(reference, sessionId, name); },
  openPreview: (path) => { void filePreview.open(path); },
  browserButtons: (check) => browserEvidence.buttons(check),
});
const sessionList = new SessionListView(element("sessions"), {
  canManage: () => connected && !sending && !state?.busy,
  createChat: (projectId) => {
    void api("session/new", { projectId }).then((accepted) => { if (accepted) sessionChanged(); });
  },
  selectSession: (session, selected) => {
    sessionMenu.close();
    if (!connected || sending || state?.busy) return;
    if (selected) { scroll.scrollTop = scroll.scrollHeight; closeSidebar(); return; }
    void api("session/resume", { id: session.id }).then((accepted) => { if (accepted) sessionChanged(); });
  },
  joinProject: (sessionId, projectId) => {
    const selected = state && displaySessions(state).find((session) => session.id === sessionId);
    if (state && selected) projectDialog.join(selected, state, projectId);
  },
  closeSessionMenu: () => sessionMenu.close(),
  openSessionMenu: (session, trigger, x, y) => sessionMenu.open(session, trigger, x, y),
  openProjectMenu: (project, trigger, x, y) => projectMenu.open(project, trigger, x, y),
});
element("workspace-picker").addEventListener("click", () => {
  if (state) void api("session/choose-workspace", { id: state.current.id }, 310_000);
});

function renderSessionList(): void {
  if (!state) return;
  const count = sessionList.update(state, sessionQuery);
  const status = element("session-search-status");
  status.hidden = !sessionQuery.trim();
  status.textContent = sessionQuery.trim() ? `${count} matching ${count === 1 ? "chat" : "chats"}` : "";
  clearSessionSearch.hidden = !sessionQuery;
  sessionList.setDisabled(!connected || sending || state.busy);
}
sessionSearch.addEventListener("input", () => {
  sessionQuery = sessionSearch.value;
  sessionMenu.close(); projectMenu.close(); renderSessionList();
});
clearSessionSearch.addEventListener("click", () => {
  sessionSearch.value = ""; sessionQuery = ""; renderSessionList(); sessionSearch.focus();
});
sessionSearch.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && sessionQuery) {
    event.preventDefault(); event.stopPropagation(); clearSessionSearch.click();
  } else if (event.key === "ArrowDown" && !event.isComposing) {
    const first = [...element("sessions").querySelectorAll<HTMLButtonElement>("[data-session-id]")]
      .find((button) => button.getClientRects().length > 0);
    if (first) { event.preventDefault(); first.focus(); }
  }
});

const modelControls = new ModelControls(element<HTMLButtonElement>("model"), element<HTMLButtonElement>("context-usage"),
  async (selection, current) => { await request("model", { sessionId: current.current.id, revision: current.current.revision,
    previous: current.current.modelSelection, selection }); }, async () => { if (!sending) await request("context/refresh", {}); });
element("model").addEventListener("click", () => { if (state) modelControls.openModel(state); });

function showError(message: string): void { notice.textContent = message; notice.hidden = false; }
function controls(): void {
  modelControls.update(state, connected, sending);
  filePreview.update(connected && !state?.current.projectError);
  const busy = Boolean(state?.busy);
  prompt.disabled = !connected;
  const running = state?.runningSessionId != null;
  send.hidden = running; stop.hidden = !running;
  send.disabled = !connected || sending || busy || !prompt.value.trim() || Boolean(state?.current.projectError);
  stop.disabled = !connected || sending;
  newChat.disabled = !connected || sending || busy;
  home.setAttribute("aria-disabled", String(newChat.disabled));
  newProject.disabled = !connected || sending || busy || !state?.persistent;
  element<HTMLButtonElement>("move-current-project").disabled = !connected || sending || busy || !state?.persistent || Boolean(state?.current.projectId);
  settings.update(Boolean(state));
  if (state) sessionMenu.update(displaySessions(state));
  sessionDialog.update();
  projectDialog.update();
  projectActions.update();
  if (state) projectMenu.update(state.projects);
  if (state) attachments.update(state, connected);
  element<HTMLButtonElement>("workspace-picker").disabled = !connected || sending || busy || Boolean(state?.current.projectId);
  sessionList.setDisabled(!connected || sending || busy);
  if (state) cron.update(state, !connected || sending || busy);
  permissionMenu.update(state?.permissionMode, !connected || sending || busy || Boolean(state?.approval));
  composerMotion.update(connected && !sending && !busy && !state?.approval && Boolean(state?.turns.length));
}
function connection(ok: boolean): void {
  connected = ok;
  element("connection").textContent = ok ? "Local" : "Disconnected";
  element("connection-dot").dataset.connected = String(ok);
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
  const pickerId = ["session/choose-workspace", "project/create", "project/workspace-preview"].includes(path) ? crypto.randomUUID() : undefined;
  const title = document.title;
  if (pickerId) document.title = `Fatcat workspace ${pickerId}`;
  sending = true; controls(); notice.hidden = true;
  try {
    const response = await fetch(`/api/${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json",
      ...(pickerId ? { "X-Fatcat-Picker": pickerId } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
    if (!response.ok) throw new Error((await response.json() as { error: string }).error);
    const result = await response.json() as T;
    await refresh(true);
    return result;
  } finally { if (pickerId) document.title = title; sending = false; controls(); }
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

function updateScrollNavigation(): void {
  const hidden = !state?.turns.length || scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 140;
  if (hidden && document.activeElement === scrollBottom) (prompt.disabled ? scroll : prompt).focus({ preventScroll: true });
  scrollBottom.hidden = hidden;
}
scroll.addEventListener("scroll", updateScrollNavigation, { passive: true });
const scrollObserver = new ResizeObserver(updateScrollNavigation);
scrollObserver.observe(scroll);
scrollObserver.observe(element("messages"));
scrollBottom.addEventListener("click", () => {
  scroll.scrollTo({ top: scroll.scrollHeight, behavior: "instant" });
  updateScrollNavigation();
});

function render(next: WebUiState): void {
  if (state && state.info.workspace !== next.info.workspace) filePreview.reset();
  const follow = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 140 || next.turns.length !== state?.turns.length || next.approval?.id !== state?.approval?.id || next.current.id !== state?.current.id;
  state = next;
  element("welcome").hidden = next.turns.length > 0;

  element("workspace").textContent = next.info.workspace;
  element("workspace").title = `${next.info.workspace}\nWrite ${next.info.permission} · Shell ${next.info.shellPermission} · Web ${next.info.webPermission}`;
  element("workspace-picker").title = next.current.projectId ? "This chat uses its project folder. Use the project menu to change it for every project chat." : "Change workspace";
  renderSessionList();
  const warning = element("session-warning");
  warning.hidden = (!next.current.interrupted && !next.current.projectError) || next.runningSessionId !== null;
  warning.textContent = next.current.projectError ?? "A turn in this session was interrupted. Model history contains only successful turns. Check current files and commands before retrying; completed operations were not undone.";
  element("run-status").textContent = next.runningSessionId !== null ? next.status : next.automationNotice;
  transcript.update(next.turns, next.current.id, next.info.workspace);
  renderApproval(next.approval);
  renderDetails(next);
  requestAnimationFrame(() => {
    if (follow) scroll.scrollTop = scroll.scrollHeight;
    updateScrollNavigation();
  });
  controls();
}

function renderDetails(next: WebUiState): void {
  if (!detailsSessionId) return;
  const selected = detailsSessionId === next.current.id ? next.current : displaySessions(next).find((session) => session.id === detailsSessionId);
  if (!selected) { dialog.close(); return; }
  const content = element("details-content"); content.replaceChildren();
  for (const [key, value] of Object.entries({ Provider: selected.modelSelection?.provider ?? "Unknown", Model: selected.modelSelection?.model ?? "Unknown", Workspace: selected.workspace,
    Project: selected.projectName ?? selected.projectId ?? "Independent session", "Project status": selected.projectError ?? "Available",
    "Session ID": selected.id, "Session name": selected.name ?? selected.title,
    "Active session": selected.id === next.current.id ? "Yes" : "No",
    "Saved locally": next.persistent && selected.revision > 0 ? "Yes" : "No", "Successful turns": selected.turnCount,
    "Created": selected.createdAt, "Updated": selected.updatedAt,
    "Forked from": selected.forkedFrom ?? "None", "Interrupted turn": selected.interrupted ? "Yes" : "No",
    "Write permission": next.info.permission, "Shell permission": next.info.shellPermission, "Public web": next.info.webPermission,
    "Permission mode": next.permissionMode.mode === "default" ? "Manual" : next.permissionMode.mode === "acceptEdits" ? "Accept edits" : next.permissionMode.mode === "plan" ? "Plan" : next.permissionMode.mode === "freeToGo" ? "Free to go" : "Custom permissions",
    "File access scope": next.permissionMode.fileAccess === "unrestricted" ? "Local files, including outside the workspace" : "Selected workspace",
    "Web tool network scope": next.info.webPermission === "deny" ? "Disabled at launch" : next.permissionMode.networkAccess === "unrestricted" ? "Local and public HTTP(S)" : "Public HTTP(S) only",
    "Parent iteration limit": next.info.maxIterations, "Request budget (bytes)": next.info.maxRequestBytes, "Available skills": next.info.skills,
    "Model context capacity (tokens)": selected.id !== next.current.id || next.contextUsage?.windowCapacityTokens == null ? "Unknown" : tokenCount.format(next.contextUsage.windowCapacityTokens),
    "Last parent request input (tokens)": selected.id !== next.current.id || next.contextUsage?.lastReportedInput?.inputTokens == null ? "Unavailable" : tokenCount.format(next.contextUsage.lastReportedInput.inputTokens),
    "Skill warnings": next.info.warnings.join("\n") || "None" })) content.append(node("dt", key), node("dd", String(value)));
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
let promptWidth = prompt.clientWidth;
new ResizeObserver(() => {
	const width = prompt.clientWidth;
	if (width === promptWidth) return;
	promptWidth = width;
	resize();
}).observe(prompt);
prompt.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault(); element<HTMLFormElement>("composer").requestSubmit();
  }
});
stop.addEventListener("click", () => { void api("stop", {}); });
function startNewChat(): void {
  if (!connected || sending || state?.busy) return;
  void api("session/new", { projectId: null }).then((accepted) => { if (accepted) sessionChanged(); });
}
newChat.addEventListener("click", startNewChat);
home.addEventListener("click", (event) => {
  event.preventDefault();
  startNewChat();
});
newProject.addEventListener("click", () => projectDialog.create());
element("move-current-project").addEventListener("click", () => {
  settings.close(true);
  if (state) projectDialog.join(state.current, state);
});
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
  const buttons = [...element("sidebar").querySelectorAll<HTMLElement>("a[href], button:not(:disabled), summary, input:not(:disabled)")]
    .filter((button) => button.getClientRects().length > 0);
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
