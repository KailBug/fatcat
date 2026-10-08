import assert from "node:assert/strict";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { SessionManager } from "../src/session/manager.js";
import { SessionStore } from "../src/session/store.js";
import { WebUiController } from "../webui/controller.js";
import { pickWorkspaceDirectory } from "../webui/folder-picker.js";
import { startWebUiServer } from "../webui/server.js";
import { temporaryWorkspace } from "./fixtures/workspace.js";

const agent = { maxIterations: 1, model: async () => ({ toolCalls: [], message: { role: "assistant" as const, content: "Ready" } }) };
const info = { provider: "deepseek", model: "offline", permission: "read-only", shellPermission: "deny", webPermission: "deny",
  maxIterations: 1, maxRequestBytes: 262144, skills: 0, warnings: [] };

test("native picker passes paths as data, bounds its helper and sanitizes failures", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const initial = join(workspace, "spaces ' & $(not-a-command)");
  const signal = new AbortController().signal;
  const selected = await pickWorkspaceDirectory(initial, signal, { platform: "win32", launch: async (file, args, options) => {
    assert.equal(file, "powershell.exe");
    assert.ok(args.includes("-STA"));
    assert.ok(args.includes("-File"));
    assert.ok(!args.includes(initial));
    assert.match(args.at(-1)!, /native-folder-dialog\.ps1$/);
    assert.equal(options.env.FATCAT_WORKSPACE_DIRECTORY, initial);
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    assert.equal(options.signal, signal);
    assert.equal(options.timeout, 300_000);
    assert.equal(options.maxBuffer, 32_768);
    return JSON.stringify({ path: workspace });
  } });
  assert.equal(selected, workspace);
  assert.equal(await pickWorkspaceDirectory(initial, signal, { platform: "win32", launch: async () => '{"path":null}' }), null);
  for (const output of ['{"path":"relative/path"}', '{"path":42}', '{}', 'invalid']) {
    await assert.rejects(pickWorkspaceDirectory(initial, signal, { platform: "win32", launch: async () => output }), /Could not open the Windows folder picker/);
  }
  await assert.rejects(pickWorkspaceDirectory(initial, signal, { platform: "win32", launch: async () => { throw new Error("private helper output"); } }),
    (error: Error) => !error.message.includes("private helper output"));
  let launched = false;
  assert.equal(await pickWorkspaceDirectory(initial, AbortSignal.abort(), { platform: "win32", launch: async () => { launched = true; return ""; } }), null);
  assert.equal(launched, false);
  await assert.rejects(pickWorkspaceDirectory(initial, signal, { platform: "linux" }), /requires Windows/);
});

test("native selection authenticates, serializes and preserves cancellation, drafts and inactive sessions", async (t) => {
  const { base, workspace, outside } = await temporaryWorkspace(t);
  const store = new SessionStore({ root: join(base, "sessions") });
  const other = await SessionManager.open(agent, { workspace: outside, store });
  const manager = await SessionManager.open(agent, { workspace, store, deferEmptySessions: true });
  const controller = await WebUiController.create({ ...info, workspace }, manager);
  const calls: string[] = [];
  let finish: ((path: string | null) => void) | undefined;
  const server = await startWebUiServer(controller, 0, (initial, signal) => {
    calls.push(initial);
    return new Promise((resolve) => {
      finish = resolve;
      signal.addEventListener("abort", () => resolve(null), { once: true });
    });
  });
  t.after(() => server.close());
  const token = new URL(server.url).hash.slice("#token=".length);
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const post = (body: unknown, custom = headers) => fetch(`${server.origin}/api/session/choose-workspace`, {
    method: "POST", headers: custom, body: JSON.stringify(body),
  });
  const waitForPicker = async () => {
    for (let i = 0; !finish && i < 200; i++) await delay(10);
    assert.ok(finish, "Picker should have opened");
  };
  const id = manager.current.id;
  assert.equal((await post({ id }, { ...headers, Authorization: "Bearer wrong" })).status, 401);
  assert.equal((await post({ id }, { ...headers, Origin: "https://example.com" } as typeof headers)).status, 403);
  assert.equal((await post({ id, extra: true })).status, 400);
  assert.equal((await post({ id: "missing" })).status, 400);
  assert.equal(calls.length, 0);
  const choosing = post({ id });
  await waitForPicker();
  assert.equal(controller.snapshot().busy, true);
  assert.equal((await post({ id })).status, 409);
  assert.throws(() => controller.submit("Do not run while choosing"), /Stop or finish/);
  finish!(outside);
  assert.equal((await choosing).status, 202);
  assert.equal(manager.current.workspace, outside);
  assert.equal(manager.current.revision, 0);

  controller.submit("Keep my transcript and report");
  for (let i = 0; controller.snapshot().busy && i < 200; i++) await delay(10);
  const before = controller.snapshot();
  finish = undefined;
  const cancelling = post({ id });
  await waitForPicker();
  finish!(null);
  assert.equal((await cancelling).status, 202);
  assert.deepEqual(controller.snapshot().current, before.current);
  assert.deepEqual(controller.snapshot().turns, before.turns);

  finish = undefined;
  const inactive = post({ id: other.current.id });
  await waitForPicker();
  finish!(workspace);
  assert.equal((await inactive).status, 202);
  assert.equal((await store.loadAny(other.current.id)).workspace, workspace);
  assert.equal(manager.current.workspace, outside);
  assert.deepEqual(controller.snapshot().turns, before.turns);

  finish = undefined;
  const invalid = post({ id });
  await waitForPicker();
  finish!(join(base, "missing"));
  assert.equal((await invalid).status, 400);
  assert.equal(manager.current.workspace, outside);
  assert.deepEqual(calls, [workspace, outside, outside, outside]);

  let aborted = false;
  const pending = controller.chooseWorkspace(id, (_initial, signal) => new Promise((resolve) => {
    signal.addEventListener("abort", () => { aborted = true; resolve(null); }, { once: true });
  }), new AbortController().signal);
  await delay(0);
  await controller.close();
  await pending;
  assert.equal(aborted, true);
  assert.deepEqual(controller.snapshot().turns, before.turns);
});
