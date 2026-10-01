import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { temporaryWorkspace } from "./fixtures/workspace.js";

const launcher = fileURLToPath(new URL("../scripts/start.js", import.meta.url));
const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const transport = new URL("./fixtures/chat-transport.js", import.meta.url).href;
const skillHome = fileURLToPath(new URL("./fixtures/empty-skill-home", import.meta.url));

function run(args: string[], cwd: string, initCwd: string | undefined, direct = false,
  overrides: NodeJS.ProcessEnv = {}) {
  const sessionDirectory = overrides.FATCAT_SESSION_DIR ?? mkdtempSync(join(tmpdir(), "fatcat-start-sessions-"));
  try {
    return spawnSync(process.execPath, ["--import", transport, direct ? cli : launcher, ...args], {
    cwd, encoding: "utf8", input: "", timeout: 5000,
    env: { ...process.env, INIT_CWD: initCwd, HARNESS_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "offline-start-only", DEEPSEEK_MODEL: "deepseek-flash",
      HARNESS_MAX_ITERATIONS: "8", HARNESS_REQUEST_TIMEOUT_MS: "60000", HARNESS_MAX_REQUEST_BYTES: "262144",
      USERPROFILE: skillHome, HOME: skillHome, FATCAT_SESSION_DIR: sessionDirectory,
      FATCAT_TEST_WORKSPACE_ROOT: undefined, ...overrides },
    });
  } finally {
    if (overrides.FATCAT_SESSION_DIR === undefined) {
      const target = resolve(sessionDirectory);
      assert.equal(dirname(target), resolve(tmpdir()));
      assert.ok(basename(target).startsWith("fatcat-start-sessions-"));
      rmSync(target, { recursive: true, force: true });
    }
  }
}

test("package launcher restores the invocation directory before creating workspace tools", async (t) => {
  const { workspace, outside } = await temporaryWorkspace(t);
  await writeFile(join(workspace, "notes.txt"), "invocation-directory-text");
  await writeFile(join(outside, "notes.txt"), "wrong-package-directory-text");
  const result = run(["--prompt", "workspace"], outside, workspace, false,
    { FATCAT_TEST_WORKSPACE_ROOT: workspace });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).result.content, "invocation-directory-text");
  assert.ok(!result.stderr.includes(workspace));
});

test("package launcher resolves relative and absolute workspace overrides from the invocation directory", async (t) => {
  const { workspace, outside } = await temporaryWorkspace(t);
  const relative = "nested workspace";
  const nested = join(workspace, relative);
  await mkdir(nested);
  for (const [override, expected] of [[relative, nested], [outside, outside]]) {
    const result = run(["--workspace", override!, "--prompt", "workspace location"], outside, workspace);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout), expected);
  }
});

test("package launcher discovers invocation-local skills without credentials", async (t) => {
  const { workspace, outside } = await temporaryWorkspace(t);
  const skill = join(workspace, ".agents", "skills", "launch-fixture");
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "---\nname: launch-fixture\ndescription: Inspect the launch fixture.\n---\nPRIVATE_LAUNCH_SKILL\n");
  const result = run(["--listSkills"], outside, workspace, false, { DEEPSEEK_API_KEY: "" });
  assert.equal(result.status, 0, result.stderr);
  const skills = JSON.parse(result.stdout).skills.filter((entry: { scope: string }) => entry.scope === "workspace");
  assert.deepEqual(skills.map((entry: { name: string }) => entry.name), ["launch-fixture"]);
  assert.ok(!result.stdout.includes("PRIVATE_LAUNCH_SKILL"));
  assert.ok(!result.stdout.includes(workspace));
});

test("package launcher falls back to its current directory when INIT_CWD is missing or blank", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  for (const initial of [undefined, "", "   "]) {
    const result = run(["--prompt", "workspace location"], workspace, initial);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout), workspace);
  }
});

test("package launcher rejects unusable INIT_CWD without exposing directory or credential values", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const file = join(workspace, "private-start-file.txt");
  await writeFile(file, "fixture");
  for (const initial of ["private-relative-directory", join(workspace, "private-missing-directory"), file]) {
    const result = run(["--prompt", "workspace location"], workspace, initial);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Error \[CONFIG\]/);
    assert.ok(!result.stderr.includes(initial));
    assert.ok(!result.stderr.includes("offline-start-only"));
  }
});

test("direct CLI invocation ignores an inherited package INIT_CWD", async (t) => {
  const { workspace, outside } = await temporaryWorkspace(t);
  await writeFile(join(workspace, "notes.txt"), "stale-package-directory-text");
  await writeFile(join(outside, "notes.txt"), "direct-cli-directory-text");
  const result = run(["--prompt", "workspace"], outside, workspace, true,
    { FATCAT_TEST_WORKSPACE_ROOT: outside });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).result.content, "direct-cli-directory-text");
});
