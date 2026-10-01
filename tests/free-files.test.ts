import assert from "node:assert/strict";
import { link, mkdir, open, readFile, readdir, realpath, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import test from "node:test";
import { PermissionPolicy } from "../src/permissions/policy.js";
import { createWorkspace } from "../src/permissions/workspace.js";
import { createTools } from "../src/tools.js";
import type { Tools, ToolResult } from "../src/tools.js";
import { createReadTool } from "../src/tools/read.js";
import { createWriteTool } from "../src/tools/write.js";
import { temporaryWorkspace } from "./fixtures/workspace.js";

function errorCode(result: ToolResult, code: string): void {
  assert.equal(result.ok, false, JSON.stringify(result));
  if (!result.ok) assert.equal(result.error.code, code);
}

async function call(tools: Tools, name: string, args: object) {
  const result = await tools.execute(name, JSON.stringify(args));
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("Expected a successful fixture operation.");
  return result.result as { path: string; content?: string; entries?: { name: string; type: string }[];
    matches?: { path: string; line: number; text: string }[]; complete?: boolean; skippedFiles?: number; scannedFiles?: number };
}

test("unrestricted files use a fixed relative root, allow outside and hidden paths, and restore workspace limits", async (t) => {
  const { workspace, outside } = await temporaryWorkspace(t);
  await mkdir(join(workspace, "node_modules"));
  await mkdir(join(workspace, ".private"));
  await writeFile(join(outside, "notes.custom"), "outside fixture");
  await writeFile(join(workspace, ".private", "extensionless"), "hidden fixture");
  await writeFile(join(workspace, "node_modules", "module.custom"), "dependency fixture");
  const policy = new PermissionPolicy("freeToGo");
  let approvals = 0;
  const tools = await createTools(workspace, "read-only", async () => { approvals++; return true; }, {}, undefined, policy);
  const outsideFile = await realpath(join(outside, "notes.custom"));
  for (const path of [outsideFile, relative(workspace, outsideFile)]) {
    const result = await call(tools, "read", { path });
    assert.equal(result.path, outsideFile);
    assert.equal(result.content, "outside fixture");
  }
  assert.equal((await call(tools, "read", { path: ".private/extensionless" })).content, "hidden fixture");
  assert.equal((await call(tools, "read", { path: "node_modules/module.custom" })).content, "dependency fixture");
  const local = await call(tools, "write", { path: "relative.custom", content: "local fixture" });
  assert.equal(local.path, join(await realpath(workspace), "relative.custom"));
  assert.equal(await readFile(join(workspace, "relative.custom"), "utf8"), "local fixture");
  const external = await call(tools, "write", { path: "../outside/.created", content: "outside created" });
  assert.equal(external.path, join(await realpath(outside), ".created"));
  await call(tools, "write", { path: outsideFile, oldText: "outside fixture", newText: "outside updated" });
  assert.equal(await readFile(outsideFile, "utf8"), "outside updated");
  assert.equal(approvals, 0);
  const records = tools.getWrites!();
  assert.equal(records.length, 3);
  assert.deepEqual(records.map((record) => record.path), [local.path, external.path, outsideFile]);
  assert.ok(records.every((record) => record.status === "committed" && record.temporaryPath === undefined));
  for (const mode of ["default", "acceptEdits"] as const) {
    policy.select(mode);
    assert.equal(tools.getPermissionState!().fileAccess, "workspace");
    for (const path of [outsideFile, "../outside/notes.custom", ".private/extensionless", "node_modules/module.custom"]) {
      errorCode(await tools.execute("read", JSON.stringify({ path })), "PATH_NOT_ALLOWED");
    }
    errorCode(await tools.execute("write", JSON.stringify({ path: outsideFile, oldText: "updated", newText: "blocked" })), "PATH_NOT_ALLOWED");
  }
  assert.equal(approvals, 0);
  policy.select("plan");
  errorCode(await tools.execute("write", '{"path":"blocked.txt","content":"blocked"}'), "PERMISSION_DENIED");
  assert.deepEqual(tools.getWrites!(), records);
});

test("unrestricted directory pages and search include hidden, dependency, extensionless and linked files without following cycles", async (t) => {
  const { workspace, outside } = await temporaryWorkspace(t);
  await mkdir(join(workspace, "node_modules"));
  await writeFile(join(workspace, ".fixture"), "hit hidden");
  await writeFile(join(workspace, "README"), "hit extensionless");
  await writeFile(join(workspace, "node_modules", "module.custom"), "hit dependency");
  await writeFile(join(outside, "linked.custom"), "hit outside");
  await symlink(outside, join(workspace, "outside-link"), process.platform === "win32" ? "junction" : "dir");
  await symlink(workspace, join(outside, "cycle"), process.platform === "win32" ? "junction" : "dir");
  await link(join(outside, "linked.custom"), join(workspace, "hard-link.custom"));
  const policy = new PermissionPolicy("freeToGo");
  const tools = await createTools(workspace, "read-only", undefined, {}, undefined, policy);
  const listing = await call(tools, "read", { path: "." });
  assert.deepEqual(listing.entries, [
    { name: ".fixture", type: "file" }, { name: "README", type: "file" },
    { name: "hard-link.custom", type: "file" }, { name: "node_modules", type: "directory" },
    { name: "outside-link", type: "directory" },
  ]);
  const throughJunction = await call(tools, "read", { path: "outside-link/linked.custom" });
  assert.equal(throughJunction.path, await realpath(join(outside, "linked.custom")));
  assert.equal(throughJunction.content, "hit outside");
  assert.equal((await call(tools, "read", { path: "hard-link.custom" })).content, "hit outside");
  const result = await call(tools, "read", { path: ".", query: "hit" });
  assert.equal(result.complete, true);
  assert.equal(result.scannedFiles, 5);
  assert.deepEqual(result.matches!.map(({ path }) => path).sort(), [
    join(await realpath(workspace), ".fixture"), join(await realpath(workspace), "README"),
    join(await realpath(workspace), "hard-link.custom"), join(await realpath(workspace), "node_modules", "module.custom"),
    await realpath(join(outside, "linked.custom")),
  ].sort());
  policy.select("default");
  for (const path of ["outside-link/linked.custom", "hard-link.custom"]) {
    errorCode(await tools.execute("read", JSON.stringify({ path })), "PATH_NOT_ALLOWED");
  }
  policy.select("freeToGo");
  await call(tools, "write", { path: "outside-link/linked.custom", oldText: "hit outside", newText: "hit edited" });
  assert.equal(await readFile(join(outside, "linked.custom"), "utf8"), "hit edited");
  assert.equal(await readFile(join(workspace, "hard-link.custom"), "utf8"), "hit outside");
  assert.equal(tools.getWrites!()[0]!.path, await realpath(join(outside, "linked.custom")));
});

test("unrestricted addressing keeps UTF-8, binary, file-size, exact-edit and no-overwrite protocols", async (t) => {
  const { workspace, outside } = await temporaryWorkspace(t);
  await writeFile(join(outside, "good"), "hit valid");
  await writeFile(join(outside, "binary.bin"), Buffer.from([65, 0, 66]));
  await writeFile(join(outside, "invalid.custom"), Buffer.from([0xff]));
  await writeFile(join(outside, "oversized"), "x".repeat(1048577));
  const tools = await createTools(workspace, "read-only", undefined, {}, undefined, new PermissionPolicy("freeToGo"));
  for (const name of ["binary.bin", "invalid.custom"]) {
    errorCode(await tools.execute("read", JSON.stringify({ path: join(outside, name) })), "UNSUPPORTED_FILE");
  }
  errorCode(await tools.execute("read", JSON.stringify({ path: join(outside, "oversized") })), "FILE_TOO_LARGE");
  const search = await call(tools, "read", { path: outside, query: "hit" });
  assert.equal(search.complete, false);
  assert.equal(search.skippedFiles, 3);
  assert.equal(search.scannedFiles, 1);
  assert.deepEqual(search.matches, [{ path: await realpath(join(outside, "good")), line: 1, text: "hit valid" }]);
  for (const content of ["binary\0text", "\ud800"]) {
    errorCode(await tools.execute("write", JSON.stringify({ path: join(outside, "new.custom"), content })), "UNSUPPORTED_FILE");
  }
  errorCode(await tools.execute("write", JSON.stringify({ path: join(outside, "new.custom"), content: "\u4e2d".repeat(400000) })), "FILE_TOO_LARGE");
  errorCode(await tools.execute("write", JSON.stringify({ path: join(outside, "good"), content: "overwrite" })), "WRITE_CONFLICT");
  errorCode(await tools.execute("write", JSON.stringify({ path: join(outside, "good"), oldText: "missing", newText: "wrong" })), "WRITE_CONFLICT");
  errorCode(await tools.execute("write", JSON.stringify({ path: join(outside, "missing", "new"), content: "wrong" })), "NOT_FOUND");
  assert.equal(await readFile(join(outside, "good"), "utf8"), "hit valid");
  assert.deepEqual(tools.getWrites!(), []);
  assert.deepEqual((await readdir(outside)).sort(), ["binary.bin", "good", "invalid.custom", "oversized"]);
});

test("reads and search hold the policy until the asynchronous operation completes or cancels", async (t) => {
  const { workspace, outside } = await temporaryWorkspace(t);
  const path = join(outside, "fixture.custom");
  await writeFile(path, "hit fixture");
  const policy = new PermissionPolicy("freeToGo");
  const scope = await createWorkspace(workspace, policy);
  for (const searching of [false, true]) {
    let entered!: () => void;
    let resume!: () => void;
    const waiting = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    let paused = false;
    const reader = createReadTool({ ...scope, async resolvePath(input, signal) {
      const target = await scope.resolvePath(input, signal);
      if (!paused && (!searching || target.stat.isFile())) { paused = true; entered(); await gate; }
      return target;
    } });
    const controller = new AbortController();
    const operation = Promise.resolve(reader.execute(searching ? { path: outside, query: "hit" } : { path }, controller.signal));
    await waiting;
    assert.throws(() => policy.select("plan"), /active tool operation/);
    if (searching) controller.abort();
    resume();
    if (searching) await assert.rejects(operation, { code: "CANCELLED" });
    else assert.equal((await operation).ok, true);
    policy.select("plan");
    policy.select("freeToGo");
  }
  assert.equal(await readFile(path, "utf8"), "hit fixture");
});

test("outside writes preserve concurrent changes and cancel staged publication with complete cleanup", async (t) => {
  const { workspace, outside } = await temporaryWorkspace(t);
  const path = join(outside, "fixture.custom");
  await writeFile(path, "original");
  const policy = new PermissionPolicy("freeToGo");
  const scope = await createWorkspace(workspace, policy);
  const changed = createWriteTool(scope, "read-only", {
    link, rename, unlink, open: async (...args) => {
      const file = await open(...args);
      await writeFile(path, "concurrent user edit");
      return file;
    },
  });
  await assert.rejects(async () => changed.tool.execute({ path, oldText: "original", newText: "agent edit" }), { code: "WRITE_CONFLICT" });
  assert.equal(await readFile(path, "utf8"), "concurrent user edit");
  assert.equal(changed.getWrites()[0]!.status, "failed");
  assert.equal(changed.getWrites()[0]!.path, await realpath(path));
  assert.equal(changed.getWrites()[0]!.temporaryPath, undefined);
  const controller = new AbortController();
  const cancelled = createWriteTool(scope, "read-only", {
    link, rename, unlink, open: async (...args) => {
      const file = await open(...args);
      controller.abort();
      return file;
    },
  });
  await assert.rejects(async () => cancelled.tool.execute({ path, oldText: "concurrent user edit", newText: "cancelled edit" }, controller.signal), { code: "CANCELLED" });
  assert.equal(await readFile(path, "utf8"), "concurrent user edit");
  assert.deepEqual(await readdir(outside), ["fixture.custom"]);
  assert.equal(cancelled.getWrites()[0]!.status, "failed");
  assert.equal(cancelled.getWrites()[0]!.errorCode, "CANCELLED");
  policy.select("plan");
});

test("a new outside path changing through a junction cannot publish at an outdated destination", async (t) => {
  const { workspace, outside, base } = await temporaryWorkspace(t);
  const alternative = join(base, "alternative");
  await mkdir(alternative);
  const alias = join(workspace, "alias");
  await symlink(outside, alias, process.platform === "win32" ? "junction" : "dir");
  const writer = createWriteTool(await createWorkspace(workspace, new PermissionPolicy("freeToGo")), "read-only", {
    link, rename, unlink, open: async (...args) => {
      const file = await open(...args);
      await unlink(alias);
      await symlink(alternative, alias, process.platform === "win32" ? "junction" : "dir");
      return file;
    },
  });
  await assert.rejects(async () => writer.tool.execute({ path: "alias/new.custom", content: "unpublished fixture" }), { code: "WRITE_CONFLICT" });
  assert.deepEqual(await readdir(outside), []);
  assert.deepEqual(await readdir(alternative), []);
  assert.equal(writer.getWrites()[0]!.status, "failed");
  assert.equal(writer.getWrites()[0]!.errorCode, "WRITE_CONFLICT");
});

test("outside cleanup failures retain an absolute temporary path and the committed result", async (t) => {
  const { workspace, outside } = await temporaryWorkspace(t);
  const path = join(outside, "created.custom");
  const writer = createWriteTool(await createWorkspace(workspace, new PermissionPolicy("freeToGo")), "read-only", {
    open, link, rename, unlink: async () => { throw Object.assign(new Error("fixture cleanup failure"), { code: "EACCES" }); },
  });
  await assert.rejects(async () => writer.tool.execute({ path, content: "committed fixture" }), { code: "WRITE_CLEANUP" });
  const record = writer.getWrites()[0]!;
  assert.equal(record.status, "committed");
  assert.equal(record.path, await realpath(path));
  assert.equal(record.errorCode, "WRITE_CLEANUP");
  assert.ok(record.temporaryPath!.startsWith(`${await realpath(outside)}${process.platform === "win32" ? "\\" : "/"}.fatcat-write-`));
  assert.equal(await readFile(record.temporaryPath!, "utf8"), "committed fixture");
  assert.equal(await readFile(path, "utf8"), "committed fixture");
  await unlink(record.temporaryPath!);
  assert.deepEqual(await readdir(outside), ["created.custom"]);
});
