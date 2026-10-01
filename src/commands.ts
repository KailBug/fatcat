import { HarnessError } from "./errors.js";
import { runSessionCommand, sessionCommandHelp } from "./session/commands.js";
import type { Conversation } from "./session/commands.js";
import type { SkillDescriptor } from "./skills.js";

export const interactiveCommandHelp = `/skills: list available skills; ${sessionCommandHelp}`;

function quoted(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Local commands display catalog metadata without loading instructions or changing history. */
export async function runInteractiveCommand(session: Conversation, prompt: string,
  skills: readonly SkillDescriptor[] = []): Promise<{ text: string; switched: boolean } | undefined> {
  const match = /^\/skills(?:\s+([\s\S]*))?$/.exec(prompt);
  if (!match) return runSessionCommand(session, prompt);
  if (match[1]?.trim()) throw new HarnessError("USAGE", "/skills does not take an argument.");
  return {
    text: skills.length ? skills.map((skill) => `$${skill.name} [${skill.scope}] | `
      + `${quoted(skill.description)} | ${quoted(skill.uri)}`).join("\n") : "No skills available for this workspace.",
    switched: false,
  };
}
