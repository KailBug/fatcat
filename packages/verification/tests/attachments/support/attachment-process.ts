import { join } from "node:path";
import { readAttachmentCatalog } from "@fatcat/runtime/internal/attachments/catalog";
import { MetadataTransactions } from "@fatcat/runtime/internal/metadata/transaction";
import { atomicJson } from "@fatcat/runtime/internal/metadata/files";
import { encodeSessionRecord, workspaceKey } from "@fatcat/runtime/session/record";
import { SessionStore } from "@fatcat/runtime/session/store";

const [root, sessionId, projectId] = process.argv.slice(2);
if (!root || !sessionId || !projectId || !process.send) throw new Error("Expected store root, session ID, project ID and IPC.");

function send(type: string): Promise<void> {
	return new Promise((resolve, reject) => process.send!({ type }, (error: Error | null) => error ? reject(error) : resolve()));
}

let commit!: () => void;
const requested = new Promise<void>((resolve) => { commit = resolve; });
process.on("message", (message: unknown) => {
	if (typeof message !== "object" || message === null || !("type" in message)) return;
	if (message.type === "commit") commit();
	if (message.type === "crash") process.exit(0);
});
process.once("disconnect", () => process.exit(1));
setTimeout(() => process.exit(1), 10000).unref();

try {
	const store = new SessionStore({ root });
	const session = await store.loadAny(sessionId);
	const project = await store.projects.load(projectId);
	const transactions = new MetadataTransactions(root, {
		remove: async () => {},
		publish: async (record) => {
			await atomicJson(join(root, workspaceKey(record.storageWorkspace!), `${record.id}.json`), encodeSessionRecord(record), 64 * 1024 * 1024);
			await send("partially-published");
			await new Promise<void>(() => {});
		},
	});
	await transactions.withLock(async () => {
		await send("locked");
		await requested;
		const catalog = await readAttachmentCatalog(join(root, "attachments"));
		for (const binding of catalog.bindings) {
			if (binding.scope.kind === "session" && binding.scope.sessionId === session.id) {
				binding.scope = { kind: "project", projectId: project.id };
			}
		}
		catalog.scopeRevisions[`session:${session.id}`] = (catalog.scopeRevisions[`session:${session.id}`] ?? 0) + 1;
		catalog.scopeRevisions[`project:${project.id}`] = (catalog.scopeRevisions[`project:${project.id}`] ?? 0) + 1;
		catalog.revision++;
		await transactions.commit({ catalog, writes: [{ ...session, workspace: project.workspace,
			location: { kind: "project", projectId: project.id }, locationRevision: 1, revision: session.revision + 1 }] });
	});
} catch (error) {
	await new Promise<void>((resolve) => process.send!({ type: "failed", message: String(error) }, () => resolve()));
	process.exit(1);
}
