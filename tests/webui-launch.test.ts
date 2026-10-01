import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { runWebUi } from "../webui/index.js";
import { openWebUiBrowser } from "../webui/open-browser.js";
import { temporaryWorkspace } from "./fixtures/workspace.js";

const privateUrl = "http://127.0.0.1:3210/#token=offline-private-capability";

test("browser opening uses a hidden Windows helper and keeps the private URL out of command text", async () => {
  let calls = 0;
  const environment = { PATH: "fixture-path", FATCAT_WEBUI_OPEN_BROWSER: "1" };
  const opening = new AbortController();
  await openWebUiBrowser(privateUrl, { platform: "win32", environment, signal: opening.signal,
    launch: async (file, args, options) => {
      calls++;
      assert.equal(file, "powershell.exe");
      assert.deepEqual(args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
      assert.ok(!args.some((arg) => arg.includes(privateUrl)));
      assert.match(args[4]!, /Start-Process -FilePath \$env:FATCAT_WEBUI_BROWSER_URL -ErrorAction Stop/);
      assert.equal(options.env.FATCAT_WEBUI_BROWSER_URL, privateUrl);
      assert.equal(options.env.PATH, "fixture-path");
      assert.equal(options.windowsHide, true);
      assert.equal(options.shell, false);
      assert.equal(options.timeout, 5000);
      assert.equal(options.signal, opening.signal);
    } });
  assert.equal(calls, 1);
  assert.ok(!("FATCAT_WEBUI_BROWSER_URL" in environment));
});

test("automation can disable browser opening and opener failures never expose the capability URL", async () => {
  await openWebUiBrowser(privateUrl, { environment: { FATCAT_WEBUI_OPEN_BROWSER: "0" },
    launch: async () => { assert.fail("Disabled opening must not launch a process."); } });
  await assert.rejects(openWebUiBrowser(privateUrl, { platform: "win32", environment: {},
    launch: async () => { throw new Error(`PRIVATE_LAUNCH_FAILURE ${privateUrl}`); } }),
  { message: "Could not open the default browser." });
});

test("Web UI requests one browser opening after listening and keeps serving if opening fails", { timeout: 10000 }, async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const output: string[] = [];
  const warnings: string[] = [];
  let calls = 0;
  let origin = "";
  let startupObservation: { status: number; workspace: string; sigintListeners: number; sigtermListeners: number } | undefined;
  const sigintListeners = process.listenerCount("SIGINT");
  const sigtermListeners = process.listenerCount("SIGTERM");
  let browserFailed!: () => void;
  const launchFailed = new Promise<void>((resolve) => { browserFailed = resolve; });
  t.mock.method(console, "log", (message: string) => { output.push(message); });
  t.mock.method(console, "warn", (message: string) => {
    warnings.push(message);
    browserFailed();
  });
  t.after(() => { if (process.listenerCount("SIGTERM") > sigtermListeners) process.emit("SIGTERM"); });
  const config = loadConfig({ DEEPSEEK_API_KEY: "offline-launch-secret", DEEPSEEK_MODEL: "offline-model" });
  const running = runWebUi(config, workspace, "read-only", "deny", "deny", 0, { persistence: false }, async (url) => {
    calls++;
    origin = new URL(url).origin;
    const status = (await fetch(origin)).status;
    const token = new URLSearchParams(new URL(url).hash.slice(1)).get("token");
    const state = await (await fetch(`${origin}/api/state`, { headers: { Authorization: `Bearer ${token}` } })).json();
    startupObservation = { status, workspace: state.info.workspace,
      sigintListeners: process.listenerCount("SIGINT"), sigtermListeners: process.listenerCount("SIGTERM") };
    throw new Error(`PRIVATE_LAUNCH_FAILURE ${url}`);
  });
  await launchFailed;
  assert.equal((await fetch(origin)).status, 200);
  process.emit("SIGTERM");
  const result = await running;
  assert.deepEqual(startupObservation, { status: 200, workspace,
    sigintListeners: sigintListeners + 1, sigtermListeners: sigtermListeners + 1 });
  assert.equal(result, 0);
  assert.equal(calls, 1);
  assert.equal(output.length, 2);
  assert.match(output[0]!, /^Fatcat Web UI: http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]+$/);
  assert.match(output[1]!, /browser opens automatically/);
  assert.deepEqual(warnings, ["Could not open the default browser. Use the private local link printed above."]);
  assert.ok(!warnings.join(" ").includes("token="));
  assert.ok(!output.join(" ").includes("offline-launch-secret"));
  assert.equal(process.listenerCount("SIGINT"), sigintListeners);
  assert.equal(process.listenerCount("SIGTERM"), sigtermListeners);
  await assert.rejects(fetch(origin));
});

test("Web UI shutdown remains available while browser opening is pending", { timeout: 10000 }, async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const warnings: string[] = [];
  let receivedSignal: AbortSignal | undefined;
  let rejectOpening!: (error: Error) => void;
  const opening = new Promise<void>((_resolve, reject) => { rejectOpening = reject; });
  const sigintListeners = process.listenerCount("SIGINT");
  const sigtermListeners = process.listenerCount("SIGTERM");
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "warn", (message: string) => { warnings.push(message); });
  t.after(() => { if (process.listenerCount("SIGINT") > sigintListeners) process.emit("SIGINT"); });
  const result = await runWebUi(loadConfig({ DEEPSEEK_API_KEY: "offline-launch-secret" }),
    workspace, "read-only", "deny", "deny", 0, { persistence: false }, async (_url, signal) => {
      receivedSignal = signal;
      process.emit("SIGINT");
      await opening;
    });
  assert.equal(result, 0);
  assert.equal(receivedSignal?.aborted, true);
  assert.equal(process.listenerCount("SIGINT"), sigintListeners);
  assert.equal(process.listenerCount("SIGTERM"), sigtermListeners);
  rejectOpening(new Error("Late opener failure"));
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(warnings, []);
});
