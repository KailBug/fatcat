import { HarnessError } from "../../src/errors.js";
import type { Model } from "../../src/model.js";
import { SessionManager } from "../../src/session/manager.js";
import { SessionStore } from "../../src/session/store.js";

const [workspace, root, sessionId, kind] = process.argv.slice(2);
if (!workspace || !root || !sessionId || !["run", "compact"].includes(kind ?? "") || !process.send) {
	throw new Error("Expected workspace, store root, session ID, operation and an IPC channel.");
}

function send(message: Record<string, unknown>): Promise<void> {
	return new Promise((resolve, reject) => {
		if (!process.connected || !process.send) return reject(new Error("The parent IPC channel is closed."));
		process.send(message, (error: Error | null) => error ? reject(error) : resolve());
	});
}

const abort = new AbortController();
let requestExit!: () => void;
const exitRequested = new Promise<void>((resolve) => { requestExit = resolve; });
const onMessage = (message: unknown) => {
	if (typeof message !== "object" || message === null || !("type" in message)) return;
	if (message.type === "cancel" || message.type === "exit") abort.abort();
	if (message.type === "exit") requestExit();
};
process.on("message", onMessage);
process.once("disconnect", () => { abort.abort(); requestExit(); });
const timeout = setTimeout(() => { process.exitCode = 1; abort.abort(); requestExit(); }, 12000);

try {
	const model: Model = async (_messages, signal) => {
		await send({ type: "active", kind, pid: process.pid });
		return new Promise((_, reject) => {
			const cancel = () => reject(new HarnessError("CANCELLED", "Cancelled by the process test."));
			if (!signal || signal.aborted) cancel();
			else signal.addEventListener("abort", cancel, { once: true });
		});
	};
	const manager = await SessionManager.open({ model, compactionModel: model, maxIterations: 4 }, {
		workspace, store: new SessionStore({ root }), selection: { resume: sessionId },
	});
	let code = "COMPLETED";
	try {
		if (kind === "compact") await manager.compact({ signal: abort.signal });
		else await manager.run("Child process pending turn", { signal: abort.signal });
	} catch (error) {
		if (!(error instanceof HarnessError)) throw error;
		code = error.code;
	}
	await send({ type: "settled", kind, code, pid: process.pid, revision: manager.current.revision });
	await exitRequested;
} catch (error) {
	process.exitCode = 1;
	await send({ type: "failed", code: error instanceof HarnessError ? error.code : "INTERNAL",
		message: error instanceof Error ? error.message : "Child process failed." }).catch(() => {});
} finally {
	clearTimeout(timeout);
	process.off("message", onMessage);
	if (process.connected) process.disconnect();
}
