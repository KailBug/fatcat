import { spawn } from "node:child_process";
import { join } from "node:path";

export type ProcessResult = {
  status: "completed" | "timed_out" | "output_limit" | "cancelled" | "spawn_failed" | "termination_failed";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
  cleanup: "foreground-exited" | "tree-killed" | "not-started" | "unconfirmed";
};
export const outputLimit = 16 * 1024;

/** Limit command inheritance to runtime/OS settings, excluding provider credentials. */
export function commandEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = new Set(["systemroot", "windir", "comspec", "path", "pathext", "temp", "tmp",
    "userprofile", "homedrive", "homepath", "appdata", "localappdata", "programfiles", "programfiles(x86)",
    "programdata", "processor_architecture", "number_of_processors", "pnpm_home", "psmodulepath"]);
  return Object.fromEntries(Object.entries(env).filter(([key, value]) => allowed.has(key.toLowerCase()) && value !== undefined));
}

function windowsExecutable(name: string): string {
  return join(process.env.SystemRoot ?? "C:\\Windows", "System32", name);
}

async function terminateTree(pid: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const killer = spawn(windowsExecutable("taskkill.exe"), ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true, stdio: "ignore", env: commandEnvironment(),
    });
    const timer = setTimeout(() => { killer.kill(); resolve(false); }, 3000);
    killer.once("error", () => { clearTimeout(timer); resolve(false); });
    killer.once("close", (code) => { clearTimeout(timer); resolve(code === 0); });
  });
}

/** No profile, no stdin, and no persistent shell state between tool calls. */
export async function runPowerShell(command: string, cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<ProcessResult> {
  const started = Date.now();
  const script = `$ErrorActionPreference = 'Stop'
                  $ProgressPreference = 'SilentlyContinue'
                  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
                  [Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
                  $OutputEncoding = [Console]::OutputEncoding
                  $global:LASTEXITCODE = 0
                  try {
                    & {
                  ${command}
                    }
                    if (-not $?) { exit 1 }
                    exit $LASTEXITCODE
                  } catch {
                    [Console]::Error.WriteLine($_.ToString())
                    exit 1
                  }`;
  function executeProcess(resolve: (result: ProcessResult) => void): void {
    const child = spawn(windowsExecutable("WindowsPowerShell/v1.0/powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { cwd, env: commandEnvironment(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let truncated = false;
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let reason: ProcessResult["status"] | undefined;
    let termination: Promise<boolean> | undefined;
    let fallback: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(() => stop("timed_out"), timeoutMs);
    const abort = () => stop("cancelled");

    function finish(status: ProcessResult["status"], cleanup: ProcessResult["cleanup"]): void {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      clearTimeout(fallback);
      signal?.removeEventListener("abort", abort);
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      // Streaming decode omits an incomplete UTF-8 suffix after the byte limit.
      const decode = (parts: Buffer[]) => new TextDecoder().decode(Buffer.concat(parts), { stream: truncated });
      resolve({ status, cleanup, exitCode, stdout: decode(stdout), stderr: decode(stderr),
        truncated, durationMs: Date.now() - started });
    }
    function stop(status: ProcessResult["status"]): void {
      if (settled || reason) return;
      reason = status;
      if (!child.pid) return;
      // Never target a PID after observing its exit: it could have been reused.
      if (exited) { finish("termination_failed", "unconfirmed"); return; }
      termination = terminateTree(child.pid);
      fallback = setTimeout(() => finish("termination_failed", "unconfirmed"), 5000);
    }
    function collect(parts: Buffer[], chunk: Buffer): void {
      if (settled) return;
      const remaining = outputLimit - size;
      const kept = chunk.subarray(0, remaining);
      if (kept.length) { parts.push(kept); size += kept.length; }
      if (chunk.length > remaining) { truncated = true; stop("output_limit"); }
    }
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    child.once("error", () => { reason = "spawn_failed"; });
    child.once("exit", (code) => { exited = true; exitCode = code; });
    child.once("close", async (code) => {
      exitCode = code;
      if (termination) {
        const killed = await termination;
        finish(killed ? reason! : "termination_failed", killed ? "tree-killed" : "unconfirmed");
      } else finish(reason ?? "completed", reason === "spawn_failed" ? "not-started" : "foreground-exited");
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  }

  return new Promise<ProcessResult>(executeProcess);
}
