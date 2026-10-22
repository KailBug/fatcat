import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { HarnessError } from "@fatcat/runtime/errors";

export type WorkspacePicker = (initialPath: string, signal: AbortSignal, ownerId?: string) => Promise<string | null>;

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
type PickerOptions = { platform?: NodeJS.Platform; launch?: PickerLauncher; ownerId?: string };

export const launchWorkspacePicker: PickerLauncher = (file, args, options) => new Promise((resolve, reject) => {
  // Closing stdin asks the modal loop to close, so Windows can re-enable its browser owner.
  // Killing the process on cancellation would leave a cross-process owner disabled.
  const { signal, timeout, maxBuffer, encoding, ...launchOptions } = options;
  // Windows PowerShell needs a console host. A detached Node host keeps it alive
  // through server job teardown so stdin EOF can restore the browser owner.
  const child = spawn(process.execPath, [fileURLToPath(new URL("./native-folder-host.js", import.meta.url)), file, ...args],
    { ...launchOptions, detached: true, stdio: ["pipe", "pipe", "pipe"] });
  const cancel = () => child.stdin.end();
  let failure: Error | undefined;
  let output = "";
  let bytes = 0;
  const deadline = setTimeout(() => { failure ??= new Error("The folder picker timed out."); cancel(); }, timeout);
  child.stdout.setEncoding(encoding);
  child.stdout.on("data", (chunk: string) => {
    bytes += Buffer.byteLength(chunk, encoding);
    if (bytes > maxBuffer) { failure ??= new Error("The folder picker output exceeded its limit."); cancel(); }
    else output += chunk;
  });
  child.stderr.resume();
  child.once("error", (error) => { failure ??= error; });
  child.once("close", (code) => {
    clearTimeout(deadline);
    signal.removeEventListener("abort", cancel);
    if (failure) reject(failure);
    else if (code !== 0) reject(new Error("The folder picker process failed."));
    else resolve(output);
  });
  child.stdin.on("error", () => {});
  signal.addEventListener("abort", cancel, { once: true });
  if (signal.aborted) cancel();
});

/** The fixed helper owns the DPI-aware Common Item Dialog; paths never become shell source. */
export async function pickWorkspaceDirectory(initialPath: string, signal: AbortSignal, options: PickerOptions = {}): Promise<string | null> {
  if ((options.platform ?? process.platform) !== "win32") {
    throw new HarnessError("INPUT", "The native workspace picker requires Windows.");
  }
  try {
    signal.throwIfAborted();
    const output = await (options.launch ?? launchWorkspacePicker)("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-WindowStyle", "Hidden",
      "-ExecutionPolicy", "Bypass", "-File", fileURLToPath(new URL("./native-folder-dialog.ps1", import.meta.url)),
    ], { env: { ...process.env, FATCAT_WORKSPACE_DIRECTORY: initialPath, FATCAT_PICKER_OWNER: options.ownerId ?? "" }, windowsHide: true, shell: false,
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
