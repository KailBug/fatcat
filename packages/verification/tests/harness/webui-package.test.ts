import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { temporaryWorkspace } from "../support/workspace.js";

describe("Web UI workspace package", () => {
	it("loads without starting a server or taking signal ownership and rejects private paths", async (t) => {
		const { workspace } = await temporaryWorkspace(t);
		const script = `
			import assert from 'node:assert/strict';
			import { Server } from 'node:http';
			const interrupts = process.listenerCount('SIGINT');
			const termination = process.listenerCount('SIGTERM');
			Server.prototype.listen = () => { throw new Error('Import must not listen'); };
			globalThis.fetch = async () => { throw new Error('Import must not request a model'); };
			const { runWebUi } = await import(${JSON.stringify(import.meta.resolve("@fatcat/webui"))});
			assert.equal(typeof runWebUi, 'function');
			assert.equal(process.listenerCount('SIGINT'), interrupts);
			assert.equal(process.listenerCount('SIGTERM'), termination);
		`;
		assert.equal(execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
			cwd: workspace, encoding: "utf8", windowsHide: true, timeout: 10000,
		}), "");
		for (const entry of ["src/index.js", "dist/index.js", "server", "controller", "client/app"]) {
			await assert.rejects(import(`@fatcat/webui/${entry}`), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
		}
	});

	it("serves package-local assets and resolves the native helper from an unrelated working directory", async (t) => {
		const { workspace } = await temporaryWorkspace(t);
		const script = `
			import assert from 'node:assert/strict';
			import { readFile, readdir } from 'node:fs/promises';
			import { fileURLToPath } from 'node:url';
			import { SessionManager } from ${JSON.stringify(import.meta.resolve("@fatcat/runtime/session/manager"))};
			import { WebUiController } from ${JSON.stringify(import.meta.resolve("@fatcat/webui/internal/controller"))};
			import { startWebUiServer } from ${JSON.stringify(import.meta.resolve("@fatcat/webui/internal/server"))};
			import { pickWorkspaceDirectory } from ${JSON.stringify(import.meta.resolve("@fatcat/webui/internal/folder-picker"))};
			const root = new URL('./', ${JSON.stringify(import.meta.resolve("@fatcat/webui"))});
			const manager = await SessionManager.open({ maxIterations: 1, model: async () => {
				throw new Error('Resource checks must not request a model');
			} }, { workspace: process.cwd(), persistence: false });
			const controller = await WebUiController.create({ provider: 'deepseek', model: 'offline', workspace: process.cwd(),
				permission: 'read-only', shellPermission: 'deny', webPermission: 'deny', maxIterations: 1,
				maxRequestBytes: 262144, skills: 0, warnings: [] }, manager);
			const server = await startWebUiServer(controller, 0);
			try {
				for (const directory of ['client', 'public']) {
					for (const name of await readdir(new URL(directory + '/', root))) {
						if (directory === 'client' && !name.endsWith('.js')) continue;
						const response = await fetch(server.origin + (name === 'index.html' ? '/' : '/' + name));
						assert.equal(response.status, 200, name);
						assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(new URL(directory + '/' + name, root)));
					}
				}
				for (const path of ['/server.js', '/types.js', '/native-folder-dialog.ps1', '/client/app.js', '/app.js.map', '/package.json']) {
					assert.equal((await fetch(server.origin + path)).status, 404, path);
				}
				assert.equal((await fetch(server.origin + '/api/state')).status, 401);
				assert.equal(await pickWorkspaceDirectory(process.cwd(), new AbortController().signal, {
					platform: 'win32', launch: async (_file, args) => {
						const helper = fileURLToPath(new URL('native-folder-dialog.ps1', root));
						assert.equal(args.at(-1), helper);
						assert.match(await readFile(helper, 'utf8'), /IFileDialog/);
						return JSON.stringify({ path: null });
					},
				}), null);
			} finally { await server.close(); }
			console.log('webui-package-ok');
		`;
		assert.equal(execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
			cwd: workspace, encoding: "utf8", windowsHide: true, timeout: 15000,
		}).trim(), "webui-package-ok");
	});
});
