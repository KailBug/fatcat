import { SessionStore } from "@fatcat/runtime/session/store";

const [root, sessionId, uploadId] = process.argv.slice(2);
if (!root || !sessionId || !uploadId || !process.send) throw new Error("Expected store root, session ID, upload ID and IPC.");

function send(type: string): Promise<void> {
	return new Promise((resolve, reject) => process.send!({ type }, (error: Error | null) => error ? reject(error) : resolve()));
}

function request(type: string): Promise<void> {
	return new Promise((resolve) => {
		const listener = (message: unknown) => {
			if (typeof message === "object" && message !== null && "type" in message && message.type === type) {
				process.off("message", listener);
				resolve();
			}
		};
		process.on("message", listener);
	});
}

process.once("disconnect", () => process.exit(1));
const timeout = setTimeout(() => process.exit(1), 10000);
try {
	const store = new SessionStore({ root });
	async function* body() { yield Buffer.from("Same bytes"); }
	const staged = await store.attachments.stageUpload({ sessionId, locationRevision: 0 }, { uploadId, name: "same.md" }, body());
	let next = request("complete");
	await send("staged");
	await next;
	await store.attachments.completeUpload(uploadId, undefined, staged.stageToken);
	next = request("cleanup");
	await send("completed");
	await next;
	await store.attachments.discardUpload(uploadId, staged.stageToken);
	await send("cleaned");
} catch (error) {
	await new Promise<void>((resolve) => process.send!({ type: "failed", message: String(error) }, () => resolve()));
	process.exitCode = 1;
} finally {
	clearTimeout(timeout);
	process.removeAllListeners("disconnect");
	process.disconnect();
}
