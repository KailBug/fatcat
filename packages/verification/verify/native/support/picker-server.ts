import { SessionManager } from "@fatcat/runtime/session/manager";
import { WebUiController } from "@fatcat/webui/internal/controller";
import { startWebUiServer } from "@fatcat/webui/internal/server";

// Isolated process used to verify that server exit closes the native picker pipe.
const workspace = process.argv[2]!;
const session = await SessionManager.open({ maxIterations: 1,
	model: async () => ({ message: { role: "assistant", content: "Unused injected response" } }) }, { workspace });
const controller = await WebUiController.create({ workspace, provider: "deepseek", model: "offline",
	permission: "read-only", shellPermission: "deny", webPermission: "deny", maxIterations: 1,
	maxRequestBytes: 262144, skills: 0, warnings: [] }, session);
const server = await startWebUiServer(controller, 0);
process.on("message", (message) => {
	if (message === "close") void server.close().then(() => process.disconnect());
});
process.send!({ url: server.url });
