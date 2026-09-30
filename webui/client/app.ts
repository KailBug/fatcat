import type { Approval, WebTurn, WebUiState } from "../controller.js";
import { renderMarkdown } from "./markdown.js";

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
const rendered = new Map<string, { signature: string; element: HTMLElement }>();

function showError(message: string): void { notice.textContent = message; notice.hidden = false; }
function controls(): void {
  const busy = Boolean(state?.busy);
  prompt.disabled = !connected;
  send.hidden = busy; stop.hidden = !busy;
  send.disabled = !connected || sending || !prompt.value.trim();
  stop.disabled = !connected || sending;
  newChat.disabled = !connected || sending || busy;
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
    if (response.status === 304) { connection(true); return; }
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
    panel.append(node("p", "Commands run with your Windows user permissions and can access files and the network outside this workspace. This is not an OS sandbox."));
  } else {
    panel.append(node("p", `${approval.request.operation} · ${approval.request.path} · ${approval.request.bytes.toLocaleString()} bytes`));
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
  const follow = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 140 || next.turns.length !== state?.turns.length || next.approval?.id !== state?.approval?.id;
  state = next;
  element("welcome").hidden = next.turns.length > 0;
  element("model").textContent = next.info.model;
  element("workspace").textContent = next.info.workspace;
  element("permissions").textContent = `Write ${next.info.permission} · Shell ${next.info.shellPermission} · Web ${next.info.webPermission}`;
  element("chat-title").textContent = next.turns[0]?.prompt ?? "New conversation";
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
  const content = element("details-content"); content.replaceChildren();
  for (const [key, value] of Object.entries({ Provider: next.info.provider, Model: next.info.model, Workspace: next.info.workspace,
    "Write permission": next.info.permission, "Shell permission": next.info.shellPermission, "Public web": next.info.webPermission,
    "Parent iteration limit": next.info.maxIterations, "Request budget (bytes)": next.info.maxRequestBytes, "Available skills": next.info.skills,
    "Skill warnings": next.info.warnings.join("\n") || "None" })) content.append(node("dt", key), node("dd", String(value)));
  if (follow) requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
  controls();
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
  if (state?.turns.length && !confirm("Clear this conversation? Files and commands will not be undone.")) return;
  void api("reset", {}).then((accepted) => { if (accepted) { prompt.value = ""; resize(); prompt.focus(); document.body.classList.remove("sidebar-open"); } });
});
element("conversation").addEventListener("click", () => { scroll.scrollTop = scroll.scrollHeight; document.body.classList.remove("sidebar-open"); });
element("settings").addEventListener("click", () => dialog.showModal());
element("close-details").addEventListener("click", () => dialog.close());
element("toggle-sidebar").addEventListener("click", () => {
  const open = document.body.classList.toggle("sidebar-open");
  element("toggle-sidebar").setAttribute("aria-expanded", String(open));
});
document.addEventListener("click", (event) => {
  if (event.target instanceof Element && !event.target.closest("aside, #toggle-sidebar")) {
    document.body.classList.remove("sidebar-open"); element("toggle-sidebar").setAttribute("aria-expanded", "false");
  }
});
document.addEventListener("keydown", (event) => { if (event.key === "Escape") { document.body.classList.remove("sidebar-open"); element("toggle-sidebar").setAttribute("aria-expanded", "false"); } });
document.querySelectorAll<HTMLButtonElement>("[data-prompt]").forEach((button) => button.addEventListener("click", () => {
  prompt.value = button.dataset.prompt!; resize(); prompt.focus();
}));
async function poll(): Promise<void> { await refresh(); window.setTimeout(() => { void poll(); }, document.hidden ? 3000 : 700); }
void poll();
