import { HarnessError } from "@fatcat/runtime/errors";

export function quoted(value: string): string {
	return JSON.stringify(value).replace(/[\u007f-\u009f]/g,
		(character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function quotedArguments(value: string, usage: string): string[] {
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
