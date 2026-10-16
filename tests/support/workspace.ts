import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { TestContext } from "node:test";

export async function temporaryWorkspace(t: TestContext) {
  // Windows TEMP may use an 8.3 alias; match the canonical paths returned by tools.
  const temporaryRoot = await realpath(tmpdir());
  const base = await mkdtemp(join(temporaryRoot, "fatcat-tools-"));
  t.after(async () => {
    const target = resolve(base);
    if (dirname(target) !== temporaryRoot || !basename(target).startsWith("fatcat-tools-")) {
      throw new Error("Refusing to remove an unexpected temporary directory.");
    }
    await rm(target, { recursive: true, force: true });
  });
  const workspace = join(base, "workspace");
  const outside = join(base, "outside");
  await mkdir(workspace);
  await mkdir(outside);
  return { base, workspace, outside };
}
