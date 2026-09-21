import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { TestContext } from "node:test";

export async function temporaryWorkspace(t: TestContext) {
  const base = await mkdtemp(join(tmpdir(), "fatcat-tools-"));
  t.after(async () => {
    const target = resolve(base);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith("fatcat-tools-")) {
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
