import { completion } from "./session.js";

/** Trusted injection for the Linux executable's signal/settlement check. */
export function createTransport(): typeof fetch {
	return async () => completion(null, [{ id: "signal-command", type: "function", function: {
		name: "shell", arguments: JSON.stringify({
			command: "echo $$ > fatcat-signal-parent.pid; sleep 60 & echo $! > fatcat-signal-child.pid; wait", timeoutMs: 20000,
		}),
	} }]);
}
