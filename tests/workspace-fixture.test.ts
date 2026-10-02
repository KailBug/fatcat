import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readdir, realpath, symlink } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { temporaryWorkspace } from "./fixtures/workspace.js";

test("workspace fixtures canonicalize an aliased temporary root and clean up only their own directory", async (t) => {
  const { base } = await temporaryWorkspace(t);
  const root = join(base, "real-temp");
  const alias = join(base, "temp-alias");
  await mkdir(root);
  await mkdir(join(root, "keep"));
  await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
  assert.notEqual(alias, await realpath(alias));
  const fixture = new URL("./fixtures/workspace.js", import.meta.url).href;
  const script = `
    import assert from "node:assert/strict";
    import { realpath } from "node:fs/promises";
    import test from "node:test";
    import { temporaryWorkspace } from ${JSON.stringify(fixture)};
    await test("canonical fixture", async (t) => {
      const paths = await temporaryWorkspace(t);
      for (const path of Object.values(paths)) assert.equal(path, await realpath(path));
    });
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8", timeout: 15000,
    env: { ...process.env, NODE_TEST_CONTEXT: undefined, TEMP: alias, TMP: alias, TMPDIR: alias },
  });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.deepEqual(await readdir(root), ["keep"]);
});
