import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, open, readFile, readdir, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { HarnessError } from "../src/errors.js";
import { createTools } from "../src/tools.js";
import type { ToolResult } from "../src/tools.js";
import { createWorkspace } from "../src/permissions/workspace.js";
import { createWriteTool } from "../src/tools/write.js";
import { temporaryWorkspace } from "./fixtures/workspace.js";

function code(result: ToolResult, expected: string) {
  assert.equal(result.ok, false, JSON.stringify(result));
  if (!result.ok) assert.equal(result.error.code, expected);
}
const digest = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");

test("write is discoverable but read-only permission prevents all file changes", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const tools = await createTools(workspace);
  assert.ok(tools.definitions.some((tool) => tool.function.name === "write"));
  code(await tools.execute("write", '{"path":"new.txt","content":"private"}'), "PERMISSION_DENIED");
  assert.deepEqual(await readdir(workspace), []);
  assert.deepEqual(tools.getWrites!(), []);
  await assert.rejects(createTools(undefined, "workspace-write"), /explicit workspace/);
});

test("create publishes a complete file without overwriting and records safe metadata", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await mkdir(join(workspace, "src"));
  const tools = await createTools(workspace, "workspace-write");
  const content = "export const value = 7;\r\n";
  const result = await tools.execute("write", JSON.stringify({ path: "src\\value.ts", content }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(await readFile(join(workspace, "src", "value.ts"), "utf8"), content);
  assert.deepEqual(await readdir(join(workspace, "src")), ["value.ts"]);
  const records = tools.getWrites!();
  assert.equal(records.length, 1);
  assert.deepEqual({ ...records[0], id: "id" }, { id: "id", path: "src/value.ts", operation: "create", status: "committed",
    beforeHash: null, afterHash: digest(content), bytes: Buffer.byteLength(content) });
  assert.ok(!JSON.stringify(records).includes(content));
  records[0]!.status = "failed";
  assert.equal(tools.getWrites!()[0]!.status, "committed");
  code(await tools.execute("write", JSON.stringify({ path: "src/value.ts", content: "overwrite" })), "WRITE_CONFLICT");
  assert.equal(await readFile(join(workspace, "src", "value.ts"), "utf8"), content);
  assert.equal((await tools.execute("read", '{"path":"src/value.ts"}')).ok, true);
});

test("exact edits preserve BOM, mixed newlines, Unicode and unrelated user content", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const before = "\ufeff// user note\r\nexport const value = 1;\n// \u4e2d\u6587\r\n";
  await writeFile(join(workspace, "value.ts"), before);
  const tools = await createTools(workspace, "workspace-write");
  const result = await tools.execute("write", JSON.stringify({ path: "value.ts", oldText: "value = 1", newText: "value = 2" }));
  assert.equal(result.ok, true);
  const after = before.replace("value = 1", "value = 2");
  assert.equal(await readFile(join(workspace, "value.ts"), "utf8"), after);
  assert.equal(tools.getWrites!()[0]!.beforeHash, digest(before));
  assert.equal(tools.getWrites!()[0]!.afterHash, digest(after));
  assert.deepEqual(await readdir(workspace), ["value.ts"]);
});

test("missing, ambiguous and overlapping edit fragments cannot change a file", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await writeFile(join(workspace, "notes.txt"), "aaa\nsame same");
  const tools = await createTools(workspace, "workspace-write");
  for (const oldText of ["missing", "same", "aa"]) {
    code(await tools.execute("write", JSON.stringify({ path: "notes.txt", oldText, newText: "new" })), "WRITE_CONFLICT");
  }
  assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "aaa\nsame same");
  assert.deepEqual(tools.getWrites!(), []);
});

test("write validation rejects mixed forms, binary content and oversized text", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const tools = await createTools(workspace, "workspace-write");
  for (const args of [{}, { path: "" }, { path: "a.txt", content: 1 },
    { path: "a.txt", content: "a", oldText: "a", newText: "b" }, { path: "a.txt", oldText: "", newText: "b" },
    { path: "a.txt", oldText: "a", newText: "a" }, { path: "a.txt", content: "a", extra: true }]) {
    code(await tools.execute("write", JSON.stringify(args)), "INVALID_ARGUMENTS");
  }
  for (const content of ["a\0b", "\ud800"]) {
    code(await tools.execute("write", JSON.stringify({ path: "a.txt", content })), "UNSUPPORTED_FILE");
  }
  code(await tools.execute("write", JSON.stringify({ path: "a.txt", content: "\u4e2d".repeat(400000) })), "FILE_TOO_LARGE");
  code(await tools.execute("write", '{"path":"image.png","content":"text"}'), "UNSUPPORTED_FILE");
  code(await tools.execute("write", '{"path":"missing/a.txt","content":"text"}'), "NOT_FOUND");
  assert.deepEqual(await readdir(workspace), []);
});

test("write maintains path, junction and hard-link boundaries", async (t) => {
  const { workspace, outside } = await temporaryWorkspace(t);
  const tools = await createTools(workspace, "workspace-write");
  await writeFile(join(outside, "secret.txt"), "outside");
  await symlink(outside, join(workspace, "escape"), process.platform === "win32" ? "junction" : "dir");
  await link(join(outside, "secret.txt"), join(workspace, "linked.txt"));
  for (const path of ["../outside/new.txt", "C:\\new.txt", "/new.txt", "C:new.txt", ".env", ".git/a.txt",
    "node_modules/a.txt", "NUL.txt", "file.txt:stream", "escape/new.txt"]) {
    code(await tools.execute("write", JSON.stringify({ path, content: "blocked" })), "PATH_NOT_ALLOWED");
  }
  code(await tools.execute("write", '{"path":"linked.txt","oldText":"outside","newText":"blocked"}'), "PATH_NOT_ALLOWED");
  assert.equal(await readFile(join(outside, "secret.txt"), "utf8"), "outside");
  assert.deepEqual(await readdir(outside), ["secret.txt"]);
});

test("a concurrent content change during staging is preserved and the failed attempt is recorded", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await writeFile(join(workspace, "notes.txt"), "old");
  const scope = await createWorkspace(workspace);
  let fileResolutions = 0;
  const writer = createWriteTool({ ...scope, async resolvePath(path, signal) {
    if (path === "notes.txt" && ++fileResolutions === 3) await writeFile(join(workspace, "notes.txt"), "user edit");
    return scope.resolvePath(path, signal);
  } }, "workspace-write");
  await assert.rejects(async () => writer.tool.execute({ path: "notes.txt", oldText: "old", newText: "new" }),
    (error: unknown) => error instanceof HarnessError && error.code === "WRITE_CONFLICT");
  assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "user edit");
  assert.equal(writer.getWrites()[0]!.status, "failed");
  assert.deepEqual(await readdir(workspace), ["notes.txt"]);
});

test("cancellation after staging removes the temporary file and leaves the target unchanged", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await writeFile(join(workspace, "notes.txt"), "old");
  const scope = await createWorkspace(workspace);
  const controller = new AbortController();
  let parents = 0;
  const writer = createWriteTool({ ...scope, async resolvePath(path, signal) {
    if (path === "." && ++parents === 2) controller.abort();
    return scope.resolvePath(path, signal);
  } }, "workspace-write");
  await assert.rejects(async () => writer.tool.execute({ path: "notes.txt", oldText: "old", newText: "new" }, controller.signal), /cancelled/);
  assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "old");
  assert.equal(writer.getWrites()[0]!.status, "failed");
  assert.equal(writer.getWrites()[0]!.errorCode, "CANCELLED");
  assert.deepEqual(await readdir(workspace), ["notes.txt"]);
});

test("overlapping writes are rejected and the journal cannot silently drop older records", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const tools = await createTools(workspace, "workspace-write");
  const first = tools.execute("write", '{"path":"first.txt","content":"first"}');
  code(await tools.execute("write", '{"path":"other.txt","content":"other"}'), "WRITE_BUSY");
  assert.equal((await first).ok, true);
  for (let index = 1; index < 100; index++) {
    assert.equal((await tools.execute("write", JSON.stringify({ path: `${index}.txt`, content: "" }))).ok, true);
  }
  code(await tools.execute("write", '{"path":"over.txt","content":"over"}'), "WRITE_LIMIT");
  assert.equal(tools.getWrites!().length, 100);
  assert.equal((await readdir(workspace)).length, 100);
});


test("publication errors remain uncertain and never report a successful edit", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await writeFile(join(workspace, "notes.txt"), "old");
  const writer = createWriteTool(await createWorkspace(workspace), "workspace-write", {
    open, link, unlink, rename: async () => { throw Object.assign(new Error("private I/O details"), { code: "EIO" }); },
  });
  await assert.rejects(async () => writer.tool.execute({ path: "notes.txt", oldText: "old", newText: "new" }));
  assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "old");
  assert.equal(writer.getWrites()[0]!.status, "uncertain");
  assert.equal(writer.getWrites()[0]!.errorCode, "TOOL_IO");
  assert.ok(!JSON.stringify(writer.getWrites()).includes("private I/O details"));
  assert.deepEqual(await readdir(workspace), ["notes.txt"]);
});

test("a file appearing at publication cannot be overwritten by create", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const writer = createWriteTool(await createWorkspace(workspace), "workspace-write", {
    open, rename, unlink, link: async (source, target) => {
      await writeFile(target, "concurrent-user-file");
      await link(source, target);
    },
  });
  await assert.rejects(async () => writer.tool.execute({ path: "notes.txt", content: "agent-file" }),
    (error: unknown) => error instanceof HarnessError && error.code === "WRITE_CONFLICT");
  assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "concurrent-user-file");
  assert.equal(writer.getWrites()[0]!.status, "failed");
  assert.deepEqual(await readdir(workspace), ["notes.txt"]);
});

test("cleanup failure after publication preserves the committed fact and names the residual temporary file", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const writer = createWriteTool(await createWorkspace(workspace), "workspace-write", {
    open, rename, link, unlink: async () => { throw Object.assign(new Error("cleanup unavailable"), { code: "EACCES" }); },
  });
  await assert.rejects(async () => writer.tool.execute({ path: "notes.txt", content: "committed" }),
    (error: unknown) => error instanceof HarnessError && error.code === "WRITE_CLEANUP");
  assert.equal(await readFile(join(workspace, "notes.txt"), "utf8"), "committed");
  const record = writer.getWrites()[0]!;
  assert.equal(record.status, "committed");
  assert.equal(record.errorCode, "WRITE_CLEANUP");
  assert.match(record.temporaryPath!, /^\.fatcat-write-/);
  await unlink(join(workspace, record.temporaryPath!));
  assert.deepEqual(await readdir(workspace), ["notes.txt"]);
});
