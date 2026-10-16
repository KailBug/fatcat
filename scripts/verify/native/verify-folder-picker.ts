import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pickWorkspaceDirectory } from "../../../webui/folder-picker.js";

// Opens real Windows dialogs and closes them automatically; no model requests.
interface NativeWindow {
	Handle: number;
	Owner: number;
	Visible: boolean;
	OwnerVisible: boolean;
	OwnerToolWindow: boolean;
	PerMonitorV2: boolean;
	TaskbarEligible: boolean;
	Dpi: number;
}
interface Observation { windows: NativeWindow[]; dialog?: NativeWindow }
type Action = "inspect" | "select" | "cancel" | "absent";

function inspect(processId: number, action: Action, screenshotPath?: string): Promise<Observation> {
	return new Promise((resolve, reject) => {
		execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
			"-ExecutionPolicy", "Bypass", "-File", fileURLToPath(new URL("../../../../scripts/verify/native/support/inspect-folder-picker.ps1", import.meta.url)),
			"-PickerProcessId", String(processId), "-Action", action,
			...(screenshotPath ? ["-ScreenshotPath", screenshotPath] : [])], {
			windowsHide: true, shell: false, timeout: 30_000, maxBuffer: 32_768, encoding: "utf8",
		}, (error, stdout) => {
			if (error) reject(error);
			else {
				try { resolve(JSON.parse(stdout.replace(/^\uFEFF/, "")) as Observation); }
				catch (error) { reject(error); }
			}
		});
	});
}

async function verify(initialPath: string, action: "select" | "cancel" | "abort" | "timeout", screenshotPath?: string): Promise<void> {
	const controller = new AbortController();
	let processId = 0;
	let observation: Observation | undefined;
	const pending = pickWorkspaceDirectory(initialPath, controller.signal, { launch: async (file, args, options) => {
		let stop = () => {};
		let startProbe!: () => void;
		const spawned = new Promise<void>((resolve) => { startProbe = resolve; });
		const output = new Promise<string>((resolve, reject) => {
			// Keep the production launcher and shorten only its verification deadline.
			const child = execFile(file, args, { ...options, timeout: action === "timeout" ? 10_000 : options.timeout }, (error, stdout) => {
				if (error) reject(error); else resolve(stdout);
			});
			stop = () => { child.kill(); };
			child.once("spawn", () => { processId = child.pid!; startProbe(); });
			child.once("error", startProbe);
		});
		const probe = spawned.then(async () => {
			assert.ok(processId > 0, "The picker helper must start");
			observation = await inspect(processId, action === "abort" || action === "timeout" ? "inspect" : action, screenshotPath);
			if (action === "abort") controller.abort();
		});
		try { return (await Promise.all([output, probe]))[0]; }
		catch (error) { stop(); await Promise.allSettled([output, probe]); throw error; }
	} });
	if (action === "timeout") await assert.rejects(pending, /Could not open the Windows folder picker/);
	else assert.equal(await pending, action === "select" ? initialPath : null);
	assert.ok(observation?.dialog, "The real Common Item Dialog must be visible");
	const dialog = observation.dialog;
	assert.equal(dialog.PerMonitorV2, true, "The actual dialog must use per-monitor DPI v2");
	assert.ok(dialog.Dpi >= 96);
	assert.ok(dialog.Owner !== 0, "The dialog must have an owner");
	assert.equal(dialog.OwnerVisible, false);
	assert.equal(dialog.OwnerToolWindow, true);
	assert.equal(observation.windows.some((window) => window.TaskbarEligible), false, "No helper window may qualify for a taskbar button");
	assert.deepEqual((await inspect(processId, "absent")).windows, [], "All native helper windows must close");
	console.log(`PASS ${action}: per-monitor v2, ${dialog.Dpi} DPI, hidden owner, no taskbar-eligible helper windows, cleaned up`);
}

assert.equal(process.platform, "win32", "Native folder picker verification requires Windows");
const temporaryRoot = await realpath(tmpdir());
const base = await mkdtemp(join(temporaryRoot, "fatcat-native-picker-"));
const workspace = join(base, "spaces ' & $(not-a-command) \u76ee\u5f55");
const screenshotPath = process.argv[2] ? resolve(process.argv[2]) : undefined;
try {
	await mkdir(workspace);
	for (const action of ["select", "cancel", "abort", "timeout"] as const) {
		await verify(workspace, action, action === "select" ? screenshotPath : undefined);
	}
} finally {
	assert.equal(dirname(resolve(base)), resolve(temporaryRoot));
	assert.ok(basename(base).startsWith("fatcat-native-picker-"));
	await rm(base, { recursive: true, force: true });
}
