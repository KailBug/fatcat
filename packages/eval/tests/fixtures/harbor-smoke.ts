import assert from "node:assert/strict";
import { completion } from "./session.js";

/** Deliberately incorrect submission: exercises Harbor scoring without a reference answer. */
export function createTransport(): typeof fetch {
	const calls = [
		{ name: "read", args: { path: "data/train.tsv", limit: 2 } },
		{ name: "write", args: { path: "rules.json", content: JSON.stringify([
			{ name: "injected-identity", src: "a", tgt: "a", left: "", right: "" },
		]) + "\n" } },
		{ name: "write", args: { path: "ordering.txt", content: "injected-identity\n" } },
		{ name: "shell", args: { command: process.platform === "win32"
			? "if (!(Test-Path rules.json) -or !(Test-Path ordering.txt)) { exit 1 }; Write-Output 'fatcat-harbor-smoke'"
			: "test -s rules.json && test -s ordering.txt && printf 'fatcat-harbor-smoke'" } },
		{ name: "read", args: { path: "rules.json" } },
	];
	let index = 0;
	return async (_input, init) => {
		const body = JSON.parse(String(init?.body));
		assert.equal(body.model, "deepseek-flash");
		if (index > 0) {
			const previous = body.messages.at(-1);
			assert.equal(previous.role, "tool");
			assert.doesNotMatch(previous.content, /"ok":false/);
			if (index === 4) assert.match(previous.content, /fatcat-harbor-smoke/);
		}
		const call = calls[index++];
		return call ? completion(null, [{ id: `harbor-${index}`, type: "function",
			function: { name: call.name, arguments: JSON.stringify(call.args) } }])
			: completion("Injected submission written. It is intentionally not a solution; use the official verifier.");
	};
}
