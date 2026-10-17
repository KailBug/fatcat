import { randomUUID } from "node:crypto";
import { quoted, quotedArguments } from "../utils/command.js";
import { HarnessError } from "../errors.js";
import type { Conversation } from "../session/commands.js";
import { sessionLabel, sessionScopeLabel } from "../session/labels.js";
import { SessionManager } from "../session/manager.js";
import type { ProjectJoinPreview } from "./operations.js";
import type { ProjectRecord } from "./record.js";

export const projectCommandHelp = "/projects: list projects; /project: show scope; /project create \"name\" \"directory\": create; "
	+ "/project use <id|name>: start a project session; /project join <id|name>: preview joining; /project confirm <token> or /project cancel.";

const projectConfirmations = new WeakMap<SessionManager, { token: string; preview: ProjectJoinPreview }>();

/** Invalidate pending command approval only after a successful session switch. */
export function clearProjectConfirmation(session: SessionManager): void {
	projectConfirmations.delete(session);
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

export async function runProjectCommand(session: Conversation, prompt: string): Promise<{ text: string; switched: boolean } | undefined> {
	const match = /^\/(projects|project)(?:\s+([\s\S]*))?$/.exec(prompt);
	if (!match) return;
	const argument = match[2]?.trim();
	if (match[1] === "projects" && argument) throw new HarnessError("USAGE", "/projects does not take an argument.");
	if (!(session instanceof SessionManager)) throw new HarnessError("USAGE", "Session management requires a managed conversation.");
	if (match[1] === "projects") {
		const projects = await session.listProjects();
		return { text: projects.length ? projects.map((project) => `${project.id} | ${quoted(project.name)} | ${quoted(project.workspace)}`).join("\n")
			: 'No projects. Use /project create "name" "directory".', switched: false };
	}
	if (!argument) return { text: `${sessionScopeLabel(session.current)}. Workspace: ${quoted(session.current.workspace)}.`
		+ (session.current.projectId ? " The project workspace is fixed; session overrides are unavailable." : ""), switched: false };
	const actionMatch = /^(\S+)(?:\s+([\s\S]*))?$/.exec(argument)!;
	const action = actionMatch[1]!;
	const value = actionMatch[2]?.trim();
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
