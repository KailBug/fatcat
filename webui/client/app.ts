import type { Approval, WebTurn, WebUiState } from "../controller.js";
import { renderMarkdown } from "./markdown.js";
import type { SessionSummary } from "../../src/session/store.js";
import { SessionMenu } from "./session-menu.js";
import type { SessionAction } from "./session-menu.js";
import { SessionDialog } from "./session-dialog.js";
import type { SessionMutation } from "./session-dialog.js";
import { icon } from "./icons.js";
import { PermissionMenu } from "./permission-menu.js";

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

function showError(message: string): void { notice.textContent = message; notice.hidden = false; }
function controls(): void {
  const busy = Boolean(state?.busy);
  prompt.disabled = !connected;
  send.hidden = busy; stop.hidden = !busy;
  send.disabled = !connected || sending || !prompt.value.trim();
  stop.disabled = !connected || sending;
  newChat.disabled = !connected || sending || busy;
  if (state) sessionMenu.update(displaySessions(state));
  sessionDialog.update();
  permissionMenu.update(state?.permissionMode, !connected || sending || busy || Boolean(state?.approval));
}
function connection(ok: boolean): void {
  connected = ok;
  element("connection").textContent = ok ? "Local session" : "Disconnected";
  element("connection-dot").hidden = !ok;
  controls();
}
async function api(path: string, body: unknown): Promise<boolean> {
  if (sending) return false;
  sending = true; controls(); notice.hidden = true;
  try {
    const response = await fetch(`/api/${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error((await response.json() as { error: string }).error);
    await refresh(true);
    return true;
  } catch (error) {
    showError(error instanceof Error ? error.message : "Request failed. Check the local server.");
    return false;
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
  article.append(node("div", turn.prompt, "user-message"));
  const label = node("div", undefined, "assistant-label");
  label.append(node("span", "f.", "cat-mark"), node("span", "Fatcat")); article.append(label);
  if (turn.answer) article.append(renderMarkdown(turn.answer));
  if (turn.error) article.append(node("p", `${turn.error}\nThis turn was not saved to model history. Completed operations remain in effect.`, "error"));
  if (turn.status === "running") article.append(node("p", "Working on it…", "waiting"));
  if (turn.activity.length) {
    const activity = node("details"); activity.dataset.kind = "activity";
    activity.append(node("summary", `Activity · ${turn.activity.length} recent events`));
    const list = node("ul"); turn.activity.forEach((entry) => list.append(node("li", entry))); activity.append(list); article.append(activity);
  }
  if (turn.report) {
    const report = turn.report;
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
  panel.replaceChildren(node("h2", approval.kind === "shell" ? "Allow this command?" : "Allow this file change?"));
  if (approval.kind === "shell") {
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
  const follow = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 140 || next.turns.length !== state?.turns.length || next.approval?.id !== state?.approval?.id || next.current.id !== state?.current.id;
  state = next;
  element("welcome").hidden = next.turns.length > 0;
  element("model").textContent = next.info.model;
  element("model").title = `${next.info.provider} · ${next.info.model}`;
  renderContextUsage(next);
  element("workspace").textContent = next.info.workspace;
  element("workspace").title = `${next.info.workspace}\nWrite ${next.info.permission} · Shell ${next.info.shellPermission} · Web ${next.info.webPermission}`;
  renderSessions(next);
  const warning = element("session-warning");
  warning.hidden = !next.current.interrupted || next.busy;
  warning.textContent = "A turn in this session was interrupted. Model history contains only successful turns. Check current files and commands before retrying; completed operations were not undone.";
  element("run-status").textContent = next.busy ? next.status : "";
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
  for (const [key, value] of Object.entries({ Provider: next.info.provider, Model: next.info.model, Workspace: next.info.workspace,
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
  const signature = JSON.stringify([next.current.id, sessions]);
  if (signature === sessionSignature) return;
  sessionSignature = signature;
  sessionList.replaceChildren();
  for (const session of sessions) {
    const button = node("button", undefined, "conversation");
    const selected = session.id === next.current.id;
    button.setAttribute("aria-current", String(selected));
    const metadata = `${session.turnCount} ${session.turnCount === 1 ? "turn" : "turns"} · ${sessionDate.format(new Date(session.updatedAt))}`;
    button.title = `${session.name ?? session.title}\n${metadata}\n${session.id}`;
    button.setAttribute("aria-description", metadata);
    button.dataset.sessionId = session.id;
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
    sessionList.append(row);
  }
}

function closeSidebar(): void {
  sessionMenu.close();
  document.body.classList.remove("sidebar-open");
  element("toggle-sidebar").setAttribute("aria-expanded", "false");
}

function sessionChanged(): void { prompt.value = ""; resize(); requestAnimationFrame(() => prompt.focus()); closeSidebar(); }

async function sessionAction(action: SessionAction, session: SessionSummary): Promise<void> {
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
  if (!connected || state?.busy || sending || !prompt.value.trim()) return;
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
  void api("session/new", {}).then((accepted) => { if (accepted) sessionChanged(); });
});
element("close-details").addEventListener("click", () => dialog.close());
dialog.addEventListener("close", () => { detailsSessionId = undefined; });
element("toggle-sidebar").addEventListener("click", () => {
  const open = document.body.classList.toggle("sidebar-open");
  element("toggle-sidebar").setAttribute("aria-expanded", String(open));
});
element("sidebar-backdrop").addEventListener("click", closeSidebar);
document.addEventListener("click", (event) => {
  if (event.target instanceof Element && !event.target.closest("aside, #toggle-sidebar, #session-menu, #session-action-dialog")) {
    document.body.classList.remove("sidebar-open"); element("toggle-sidebar").setAttribute("aria-expanded", "false");
  }
});
document.addEventListener("keydown", (event) => { if (event.key === "Escape") { document.body.classList.remove("sidebar-open"); element("toggle-sidebar").setAttribute("aria-expanded", "false"); } });
document.querySelectorAll<HTMLButtonElement>("[data-prompt]").forEach((button) => button.addEventListener("click", () => {
  prompt.value = button.dataset.prompt!; resize(); prompt.focus();
}));
async function poll(): Promise<void> { await refresh(); window.setTimeout(() => { void poll(); }, document.hidden ? 3000 : 700); }
void poll();
