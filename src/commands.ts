import { HarnessError } from "./errors.js";
import { runSessionCommand, sessionCommandHelp } from "./session/commands.js";
import type { Conversation } from "./session/commands.js";
import type { SkillDescriptor } from "./skills.js";
import { SessionManager } from "./session/manager.js";
import { contextCommandHelp, runContextCommand } from "./context/commands.js";
import type { CompactionOptions } from "./context/compaction.js";

export const interactiveCommandHelp = `/cron [description]: create automation in this session; /cron list|pause <id>|resume <id>|delete <id>. /skills: list available skills; ${contextCommandHelp} ${sessionCommandHelp}`;

export function automationCommandPrompt(prompt: string): string | undefined {
  const match = /^\/cron\s+([\s\S]+)$/.exec(prompt);
  const description = match?.[1]?.trim();
  if (!description || /^(?:list|pause|resume|delete)(?:\s|$)/.test(description)) return;
  return `Schedule in this conversation: ${description}`;
}

function quoted(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Dispatch host commands; only explicit compaction may request a model summary. */
export async function runInteractiveCommand(session: Conversation, prompt: string,
  skills: readonly SkillDescriptor[] = [], options: CompactionOptions = {}): Promise<{ text: string; switched: boolean } | undefined> {
  const context = await runContextCommand(session, prompt, options);
  if (context) return context;
  const automation = /^\/cron(?:\s+(list|pause|resume|delete)(?:\s+(\S+))?)?\s*$/.exec(prompt);
  if (automation) {
    if (!(session instanceof SessionManager)) throw new HarnessError("AUTOMATION_UNAVAILABLE", "Automation requires a saved session.");
    const action = automation[1] ?? "list";
    if (action === "list") {
      if (automation[2]) throw new HarnessError("USAGE", "/cron list takes no ID.");
      const tasks = (await session.listAutomations()).filter((task) => task.sessionId === session.current.id);
      return { text: tasks.length ? tasks.map((task) => `${task.id} | ${task.enabled ? "enabled" : "paused"} | ${task.runs}/${task.maxRuns} runs | ${JSON.stringify(task.trigger)} | ${quoted(task.prompt)}`).join("\n")
        : "No automation in this session. Use /cron followed by your task and schedule, for example: /cron every 5 minutes review src/cli.ts.", switched: false };
    }
    if (!automation[2]) throw new HarnessError("USAGE", `Use /cron ${action} <task-id>.`);
    await session.manageAutomation({ action, id: automation[2] });
    return { text: `Automation ${action} completed.`, switched: false };
  }
  const match = /^\/skills(?:\s+([\s\S]*))?$/.exec(prompt);
  if (!match) return runSessionCommand(session, prompt);
  if (match[1]?.trim()) throw new HarnessError("USAGE", "/skills does not take an argument.");
  if (session instanceof SessionManager && session.skills) skills = session.skills.skills;
  return {
    text: skills.length ? skills.map((skill) => `$${skill.name} [${skill.scope}] | `
      + `${quoted(skill.description)} | ${quoted(skill.uri)}`).join("\n") : "No skills available for this workspace.",
    switched: false,
  };
}
