import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessError } from "../src/errors.js";

export type WorkspacePicker = (initialPath: string, signal: AbortSignal) => Promise<string | null>;

type PickerLaunchOptions = {
  env: NodeJS.ProcessEnv;
  windowsHide: boolean;
  shell: false;
  timeout: number;
  maxBuffer: number;
  encoding: "utf8";
  signal: AbortSignal;
};
type PickerLauncher = (file: string, args: string[], options: PickerLaunchOptions) => Promise<string>;
type PickerOptions = { platform?: NodeJS.Platform; launch?: PickerLauncher };

const launchPicker: PickerLauncher = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, options, (error, stdout) => { if (error) reject(error); else resolve(stdout); });
});

/** The fixed helper opens the Windows Common Item Dialog; paths never become shell source. */
export async function pickWorkspaceDirectory(initialPath: string, signal: AbortSignal, options: PickerOptions = {}): Promise<string | null> {
  if ((options.platform ?? process.platform) !== "win32") {
    throw new HarnessError("INPUT", "The native workspace picker requires Windows.");
  }
  try {
    signal.throwIfAborted();
    const output = await (options.launch ?? launchPicker)("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-WindowStyle", "Hidden",
      "-ExecutionPolicy", "Bypass", "-File", fileURLToPath(new URL("./native-folder-dialog.ps1", import.meta.url)),
    ], { env: { ...process.env, FATCAT_WORKSPACE_DIRECTORY: initialPath }, windowsHide: true, shell: false,
      timeout: 300_000, maxBuffer: 32_768, encoding: "utf8", signal });
    signal.throwIfAborted();
    const result: unknown = JSON.parse(output.replace(/^\uFEFF/, ""));
    if (!result || typeof result !== "object" || !("path" in result)) throw new Error("Invalid picker response.");
    if (result.path === null) return null;
    if (typeof result.path !== "string" || !isAbsolute(result.path) || result.path.length > 4096 || /[\x00-\x1f]/.test(result.path)) {
      throw new Error("Invalid selected path.");
    }
    return result.path;
  } catch {
    if (signal.aborted) return null;
    throw new HarnessError("INPUT", "Could not open the Windows folder picker. Close any existing picker and try again.");
  }
}
