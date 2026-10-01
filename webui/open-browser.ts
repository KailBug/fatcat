import { execFile } from "node:child_process";

type BrowserLaunchOptions = {
  env: NodeJS.ProcessEnv;
  windowsHide: boolean;
  shell: false;
  timeout: number;
  signal?: AbortSignal;
};

type BrowserLauncher = (file: string, args: string[], options: BrowserLaunchOptions) => Promise<void>;

type BrowserOpenOptions = {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  launch?: BrowserLauncher;
  signal?: AbortSignal;
};

const launchBrowser: BrowserLauncher = (file, args, options) => new Promise<void>((resolve, reject) => {
  execFile(file, args, options, (error) => { if (error) reject(error); else resolve(); });
});

/** Open the authenticated local URL without putting it in shell command text or failure messages. */
export async function openWebUiBrowser(url: string, options: BrowserOpenOptions = {}): Promise<void> {
  const environment = options.environment ?? process.env;
  if (environment.FATCAT_WEBUI_OPEN_BROWSER === "0") return;
  const platform = options.platform ?? process.platform;
  const launch = options.launch ?? launchBrowser;
  const processOptions: BrowserLaunchOptions = { env: { ...environment }, windowsHide: true, shell: false, timeout: 5000 };
  if (options.signal) processOptions.signal = options.signal;
  try {
    if (platform === "win32") {
      processOptions.env.FATCAT_WEBUI_BROWSER_URL = url;
      await launch("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        "Start-Process -FilePath $env:FATCAT_WEBUI_BROWSER_URL -ErrorAction Stop"], processOptions);
    } else {
      await launch(platform === "darwin" ? "/usr/bin/open" : "xdg-open", [url], processOptions);
    }
  } catch {
    throw new Error("Could not open the default browser.");
  }
}
