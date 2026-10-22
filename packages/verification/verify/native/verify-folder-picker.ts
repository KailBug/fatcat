import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { launchWorkspacePicker, pickWorkspaceDirectory } from "@fatcat/webui/internal/folder-picker";
import { chromium } from "playwright";
import type { Browser } from "playwright";
import { randomUUID } from "node:crypto";

// Opens real Windows dialogs and closes them automatically; no model requests.
interface NativeWindow {
	ProcessId: number;
	Handle: number;
	Owner: number;
	Visible: boolean;
	OwnerVisible: boolean;
	OwnerEnabled: boolean;
	AboveOwner: boolean;
	OwnerToolWindow: boolean;
	PerMonitorV2: boolean;
	TaskbarEligible: boolean;
	Dpi: number;
}
interface Observation { windows: NativeWindow[]; dialog?: NativeWindow; hostProcessId?: number; ownerEnabled?: boolean; ownerExists?: boolean }
type Action = "inspect" | "select" | "cancel" | "absent" | "restored";

function inspect(processId: number, action: Action, screenshotPath?: string, ownerHandle?: number, parentId = process.pid): Promise<Observation> {
	return new Promise((resolve, reject) => {
		execFile("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden",
			"-ExecutionPolicy", "Bypass", "-File", fileURLToPath(new URL("./support/inspect-folder-picker.ps1", import.meta.url)),
			...(processId ? ["-PickerProcessId", String(processId)] : ["-ParentProcessId", String(parentId)]), "-Action", action,
			...(ownerHandle ? ["-OwnerHandle", String(ownerHandle)] : []),
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

function within<T>(pending: Promise<T>, label: string): Promise<T> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`${label} did not settle within 20 seconds.`)), 20_000);
		pending.then(resolve, reject).finally(() => clearTimeout(timer));
	});
}

async function verifyLifecycle(workspace: string, action: "tab-close" | "browser-close" | "server-close" | "server-exit"): Promise<void> {
	const worker = fork(fileURLToPath(new URL("./support/picker-server.js", import.meta.url)), [workspace],
		{ stdio: ["ignore", "pipe", "pipe", "ipc"], windowsHide: true });
	const exited = once(worker, "exit");
	let browser: Browser | undefined;
	let dialog: NativeWindow | undefined;
	let hostProcessId: number | undefined;
	try {
		const [ready] = await within(once(worker, "message"), "Fixture startup") as [{ url: string }];
		browser = await chromium.launch({ headless: false, channel: "msedge" });
		const context = await browser.newContext();
		const survivor = await context.newPage();
		await survivor.setContent("<title>Picker cleanup survivor</title><button>Usable</button>");
		const page = await context.newPage();
		await page.goto(ready.url);
		await page.bringToFront();
		await page.locator("#workspace-picker").click();
		const observation = await inspect(0, "inspect", undefined, undefined, worker.pid!);
		dialog = observation.dialog;
		hostProcessId = observation.hostProcessId;
		assert.ok(dialog);
		assert.ok(hostProcessId);
		assert.equal(dialog.OwnerEnabled, false);
		if (action === "tab-close") await page.close();
		else if (action === "browser-close") await browser.close();
		else if (action === "server-close") worker.send("close");
		else worker.kill();
		await inspect(dialog.ProcessId, "absent");
		await inspect(hostProcessId, "absent");
		const owner = await inspect(dialog.ProcessId, "restored", undefined, dialog.Owner);
		if (action === "browser-close") assert.equal(owner.ownerExists, false);
		else {
			assert.equal(owner.ownerExists, true, "The browser window must survive this check");
			assert.equal(owner.ownerEnabled, true, "The surviving browser must not remain disabled");
			await survivor.bringToFront();
			await survivor.getByRole("button", { name: "Usable" }).click();
		}
		if (action === "server-close") assert.deepEqual(await within(exited, "Fixture exit"), [0, null]);
		else if (action === "server-exit") await within(exited, "Fixture exit");
		console.log(`PASS ${action}: real HTTP/native picker exited, surviving browser restored`);
	} finally {
		if (worker.exitCode === null && worker.signalCode === null) worker.kill();
		await within(exited, "Fixture cleanup");
		if (dialog) await inspect(dialog.ProcessId, "absent");
		if (hostProcessId) await inspect(hostProcessId, "absent");
		await browser?.close();
	}
}

async function verify(initialPath: string, action: "select" | "cancel" | "abort" | "timeout", ownerId: string, screenshotPath?: string): Promise<void> {
	const controller = new AbortController();
	let processId = 0;
	let observation: Observation | undefined;
	let probeFailure: unknown;
	const pending = pickWorkspaceDirectory(initialPath, controller.signal, { ownerId, launch: async (file, args, options) => {
		const output = launchWorkspacePicker(file, args, { ...options, timeout: action === "timeout" ? 15_000 : options.timeout });
		const probe = (async () => {
			observation = await inspect(0, action === "abort" || action === "timeout" ? "inspect" : action, screenshotPath);
			processId = observation.dialog!.ProcessId;
			if (action === "abort") controller.abort();
		})();
		try { return (await Promise.all([output, probe]))[0]; }
		catch (error) { if (!observation) { probeFailure = error; controller.abort(); } await Promise.allSettled([output, probe]); throw error; }
	} });
	const inspected = pending.then((value) => { if (probeFailure) throw probeFailure; return value; });
	if (action === "timeout") await assert.rejects(inspected, /Could not open the Windows folder picker/);
	else assert.equal(await inspected, action === "select" ? initialPath : null);
	assert.ok(observation?.dialog, "The real Common Item Dialog must be visible");
	const dialog = observation.dialog;
	assert.equal(dialog.PerMonitorV2, true, "The actual dialog must use per-monitor DPI v2");
	assert.ok(dialog.Dpi >= 96);
	assert.ok(dialog.Owner !== 0, "The dialog must have an owner");
	assert.equal(dialog.OwnerVisible, true, "The actual browser must own the dialog");
	assert.equal(dialog.OwnerEnabled, false, "The browser must be disabled while the native dialog is open");
	assert.equal(dialog.AboveOwner, true, "The native picker must remain above its browser owner");
	assert.equal(observation.windows.some((window) => window.TaskbarEligible), false, "No helper window may qualify for a taskbar button");
	assert.deepEqual((await inspect(processId, "absent")).windows, [], "All native helper windows must close");
	assert.ok(observation.hostProcessId);
	await inspect(observation.hostProcessId, "absent");
	assert.equal((await inspect(processId, "restored", undefined, dialog.Owner)).ownerEnabled, true, "The browser must be re-enabled on every exit path");
	console.log(`PASS ${action}: per-monitor v2, ${dialog.Dpi} DPI, modal browser owner, no taskbar-eligible helper windows, cleaned up`);
}

assert.equal(process.platform, "win32", "Native folder picker verification requires Windows");
const temporaryRoot = await realpath(tmpdir());
const base = await mkdtemp(join(temporaryRoot, "fatcat-native-picker-"));
const workspace = join(base, "spaces ' & $(not-a-command) \u76ee\u5f55");
const screenshotPath = process.argv[2] ? resolve(process.argv[2]) : undefined;
let browser: Browser | undefined;
try {
	await mkdir(workspace);
	browser = await chromium.launch({ headless: false, channel: "msedge" });
	const page = await browser.newPage();
	const ownerId = randomUUID();
	await page.setContent(`<title>Fatcat workspace ${ownerId}</title><button onclick="this.textContent='Ready'">Check browser input</button>`);
	await page.bringToFront();
	for (const action of ["select", "cancel", "abort", "timeout"] as const) {
		await verify(workspace, action, ownerId, action === "select" ? screenshotPath : undefined);
		await page.getByRole("button").click();
		assert.equal(await page.getByRole("button").textContent(), "Ready");
	}
	await browser.close();
	browser = undefined;
	for (const action of ["tab-close", "browser-close", "server-close", "server-exit"] as const) await verifyLifecycle(workspace, action);
} finally {
	await browser?.close();
	assert.equal(dirname(resolve(base)), resolve(temporaryRoot));
	assert.ok(basename(base).startsWith("fatcat-native-picker-"));
	await rm(base, { recursive: true, force: true });
}
