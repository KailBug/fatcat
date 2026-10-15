import { randomUUID } from "node:crypto";
import { HarnessError, checkCancellation } from "../errors.js";
import { attachmentReference, parseAttachmentReference } from "../attachments/record.js";
import type { AttachmentInfo } from "../attachments/record.js";
import type { ProjectJoinPreview } from "../project/operations.js";
import type { ProjectRecord } from "../project/record.js";
import type { Session } from "./session.js";
import { SessionManager } from "./manager.js";
import type { SessionSummary } from "./record.js";

export type Conversation = Session | SessionManager;

export const sessionCommandHelp = "/new [--standalone] [name], /clear, /reset: start a new session; /sessions: list sessions; "
  + "/resume <id|name>: switch; /workspace [path]: show or change workspace; /rename <name>: rename; /fork [name]: copy history into a new session. "
  + "/projects: list projects; /project: show scope; /project create \"name\" \"directory\": create; "
  + "/project use <id|name>: start a project session; /project join <id|name>: preview joining; /project confirm <token> or /project cancel. "
  + "/attachments: list current attachments; /attach \"path\": import a file; /attachment remove <reference>: remove its scope association; "
  + "/attachment delete <reference> --confirm: permanently delete an unreferenced original.";

const projectConfirmations = new WeakMap<SessionManager, { token: string; preview: ProjectJoinPreview }>();

function quoted(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function sessionLabel(summary: SessionSummary): string {
  return `${summary.id}${summary.name ? ` (${quoted(summary.name)})` : ""}`;
}

export function sessionScopeLabel(summary: SessionSummary): string {
  return summary.projectId ? `Project: ${summary.projectName ? `${quoted(summary.projectName)} ` : ""}(${summary.projectId})`
    + (summary.projectError ? ` | unavailable: ${quoted(summary.projectError)}` : "")
    : "Standalone session";
}

export function formatSessionList(sessions: readonly SessionSummary[], activeId?: string): string {
  if (!sessions.length) return "No saved sessions.";
  return sessions.map((session) => `${session.id === activeId ? "*" : " "} ${sessionLabel(session)} | `
    + `${session.turnCount} saved turns | ${session.updatedAt} | ${quoted(session.title)} | ${quoted(session.workspace)} | ${sessionScopeLabel(session)}`
    + `${session.interrupted ? " | interrupted" : ""}${session.automationCount ? ` | [clock] ${session.automationCount} automation(s)` : ""}`).join("\n");
}

function quotedArguments(value: string, usage: string): string[] {
  const args: string[] = [];
  let remaining = value.trim();
  while (remaining) {
    const match = /^(?:"([^"]*)"|'([^']*)'|([^\s"']+))(?:\s+|$)/.exec(remaining);
    if (!match) throw new HarnessError("USAGE", `${usage} Quote arguments containing spaces.`);
    args.push(match[1] ?? match[2] ?? match[3]!);
    remaining = remaining.slice(match[0].length);
  }
  return args;
}

async function selectedProject(session: SessionManager, selector: string | undefined): Promise<ProjectRecord> {
  const value = selector?.trim().replace(/^(["'])([\s\S]*)\1$/, "$2");
  if (!value) throw new HarnessError("USAGE", "A project ID or name is required. Use /projects to list projects.");
  const projects = await session.listProjects();
  const exact = projects.find((project) => project.id === value);
  if (exact) return exact;
  const matches = projects.filter((project) => project.name === value);
  if (matches.length > 1) throw new HarnessError("USAGE", "That project name is ambiguous. Use its ID from /projects.");
  if (!matches[0]) throw new HarnessError("PROJECT_NOT_FOUND", "No project matches that ID or name.");
  return matches[0];
}

async function runProjectCommand(session: SessionManager, argument?: string): Promise<{ text: string; switched: boolean }> {
  if (!argument) return { text: `${sessionScopeLabel(session.current)}. Workspace: ${quoted(session.current.workspace)}.`
    + (session.current.projectId ? " The project workspace is fixed; session overrides are unavailable." : ""), switched: false };
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(argument)!;
  const action = match[1]!;
  const value = match[2]?.trim();
  if (action === "cancel") {
    if (value) throw new HarnessError("USAGE", "/project cancel takes no argument.");
    projectConfirmations.delete(session);
    return { text: "Project join cancelled. No session was changed.", switched: false };
  }
  if (action === "confirm") {
    const pending = projectConfirmations.get(session);
    if (!pending || pending.token !== value) throw new HarnessError("USAGE", "No matching project confirmation. Use /project join again.");
    projectConfirmations.delete(session);
    if (pending.preview.sessionId !== session.current.id) throw new HarnessError("USAGE", "The active session changed. Use /project join again.");
    await session.joinProject(pending.preview);
    return { text: `Session joined. ${sessionScopeLabel(session.current)}. Workspace: ${quoted(session.current.workspace)}.`, switched: true };
  }
  if (action === "create") {
    const args = quotedArguments(value ?? "", 'Use /project create "name" "directory".');
    if (args.length !== 2) throw new HarnessError("USAGE", 'Use /project create "name" "directory".');
    const project = await session.createProject(args[0]!, args[1]!);
    return { text: `Project created: ${project.id} (${quoted(project.name)}). Workspace: ${quoted(project.workspace)}. Use /project use ${project.id} to start a session.`, switched: false };
  }
  if (action !== "use" && action !== "join") throw new HarnessError("USAGE", "Use /project create, use, join, confirm, or cancel. Use /projects to list projects.");
  const project = await selectedProject(session, value);
  if (action === "use") {
    await session.newSession(undefined, project.id);
    projectConfirmations.delete(session);
    return { text: `New session: ${sessionLabel(session.current)}. ${sessionScopeLabel(session.current)}. Workspace: ${quoted(session.current.workspace)}.`, switched: true };
  }
  const preview = await session.previewProjectJoin(project.id);
  if (preview.alreadyJoined) return { text: `This session already belongs to ${quoted(project.name)}.`, switched: false };
  const token = randomUUID();
  projectConfirmations.set(session, { token, preview });
  return { text: [
    `Join session ${preview.sessionId} to project ${quoted(preview.projectName)} (${preview.projectId})?`,
    `Current workspace: ${quoted(preview.fromWorkspace)}`,
    `Project workspace: ${quoted(preview.toWorkspace)}`,
    `Future uploads will be shared with this project. ${preview.attachmentCount} existing private attachment association(s) become project-shared. Session histories stay separate.`,
    `${preview.memoryCount} active private Memory entry/entries become project Memory, available to all project sessions. Original sources and revisions are preserved.`,
    "Workspace files will not be moved or copied. Past messages and source paths will not be rewritten. Tool permissions do not change.",
    `${preview.automationCount} existing automation(s) will be paused for review.`,
    `Confirm with /project confirm ${token}, or use /project cancel.`,
  ].join("\n"), switched: false };
}

function attachmentLabel(record: AttachmentInfo): string {
  return `${attachmentReference(record)} | ${quoted(record.name)} | ${record.size} bytes | ${quoted(record.mediaType)}`
    + (record.deleted ? " | deleted" : record.removed ? " | association removed" : " | saved");
}

async function runAttachmentCommand(session: SessionManager, command: string, argument: string | undefined,
  signal?: AbortSignal): Promise<{ text: string; switched: boolean }> {
  checkCancellation(signal);
  const sessionId = session.current.id;
  const scopeLabel = sessionScopeLabel(session.current);
  if (command === "attachments") {
    if (argument) throw new HarnessError("USAGE", "/attachments does not take an argument.");
    const attachments = await session.listAttachments(sessionId);
    checkCancellation(signal);
    return { text: attachments.length ? `${scopeLabel} attachments:\n${attachments.map(attachmentLabel).join("\n")}`
      : 'No attachments in this scope. Use /attach "path" to import a file.', switched: false };
  }
  if (command === "attach") {
    const paths = quotedArguments(argument ?? "", 'Use /attach "path".');
    if (paths.length !== 1 || !paths[0]) throw new HarnessError("USAGE", 'Use /attach "path".');
    const record = await session.importAttachment(paths[0], signal);
    return { text: `Attachment saved: ${attachmentLabel(record)}. ${scopeLabel}. `
      + "Ask the agent to read supported text or document formats. Image and PDF-page analysis requires a supported current model; saving does not analyze the file.", switched: false };
  }
  const args = quotedArguments(argument ?? "", "Use /attachment remove <reference> or /attachment delete <reference> --confirm.");
  const [action, reference, confirmation] = args;
  if (!reference || (action !== "remove" && action !== "delete") || args.length > 3
    || (action === "remove" && args.length !== 2) || (confirmation !== undefined && confirmation !== "--confirm")) {
    throw new HarnessError("USAGE", "Use /attachment remove <reference> or /attachment delete <reference> --confirm.");
  }
  parseAttachmentReference(reference);
  if (action === "remove") {
    await session.removeAttachment(sessionId, reference);
    return { text: `Attachment association removed from ${scopeLabel}: ${reference}. `
      + "The original and existing history references are retained. Other scopes are unchanged.", switched: false };
  }
  if (confirmation !== "--confirm") {
    const record = (await session.listAttachments(sessionId, true)).find((item) => attachmentReference(item) === reference);
    if (!record) throw new HarnessError("ATTACHMENT_NOT_FOUND", "That attachment is not available in this scope.");
    return { text: `Permanently delete ${attachmentLabel(record)} from ${scopeLabel}? `
      + "This destroys the original and removes the current scope's association, so every session in this scope loses access. "
      + "Other active scope associations or retained history/fork references block deletion. "
      + `Confirm with /attachment delete ${reference} --confirm.`, switched: false };
  }
  await session.deleteAttachment(sessionId, reference);
  return { text: `Attachment permanently deleted: ${reference}. Historical reference identities are not rewritten.`, switched: false };
}

/** Local session commands never become user messages or grant tool permissions. */
export async function runSessionCommand(session: Conversation, prompt: string, options: { signal?: AbortSignal } = {}): Promise<{
  text: string; switched: boolean;
} | undefined> {
  const match = /^\/(new|clear|reset|sessions|resume|rename|fork|workspace|projects|project|attachments|attach|attachment)(?:\s+([\s\S]*))?$/.exec(prompt);
  if (!match) return undefined;
  const command = match[1]!;
  const argument = match[2]?.trim();
  if ((command === "clear" || command === "reset" || command === "sessions" || command === "projects") && argument) {
    throw new HarnessError("USAGE", `/${command} does not take an argument.`);
  }
  if (!(session instanceof SessionManager)) {
    if (command === "new" || command === "clear" || command === "reset") {
      session.reset();
      return { text: "History cleared.", switched: true };
    }
    throw new HarnessError("USAGE", "Session management requires a managed conversation.");
  }
  if (command === "attachments" || command === "attach" || command === "attachment") {
    return runAttachmentCommand(session, command, argument, options.signal);
  }
  if (command === "project") return runProjectCommand(session, argument);
  if (command === "projects") {
    const projects = await session.listProjects();
    return { text: projects.length ? projects.map((project) => `${project.id} | ${quoted(project.name)} | ${quoted(project.workspace)}`).join("\n")
      : 'No projects. Use /project create "name" "directory".', switched: false };
  }
  if (command === "sessions" || (command === "resume" && !argument)) {
    return { text: formatSessionList(await session.list(), session.current.id), switched: false };
  }
  if (command === "workspace") {
    if (argument) {
      const path = argument.startsWith('"') && argument.endsWith('"') ? argument.slice(1, -1) : argument;
      await session.setWorkspace(path);
    }
    return { text: `Workspace: ${quoted(session.current.workspace)}`, switched: Boolean(argument) };
  }
  if (command === "rename") {
    if (!argument) throw new HarnessError("USAGE", "Use /rename <name>.");
    await session.rename(argument);
    return { text: `Session renamed: ${sessionLabel(session.current)}.`, switched: false };
  }
  if (command === "resume") await session.resume(argument!);
  else if (command === "fork") await session.fork(argument || undefined);
  else {
    const standalone = command === "new" && /^--standalone(?:\s|$)/.test(argument ?? "");
    const name = standalone ? argument!.slice("--standalone".length).trim() : argument;
    await session.newSession(name || undefined, standalone ? null : undefined);
  }
  projectConfirmations.delete(session);
  return {
    text: `${command === "resume" ? "Resumed" : command === "fork" ? "Forked" : "New"} session: ${sessionLabel(session.current)}.`
      + ` Workspace: ${quoted(session.current.workspace)}.`
      + ` ${sessionScopeLabel(session.current)}.`
      + (session.current.interrupted ? " The last turn was interrupted; inspect workspace files before repeating operations." : ""),
    switched: true,
  };
}
