import assert from "node:assert/strict";
import { link, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createTools, defaultTools } from "../src/tools.js";
import type { Tools, ToolResult } from "../src/tools.js";
import { temporaryWorkspace } from "./fixtures/workspace.js";

const call = (tools: Tools, name: string, path: string) => tools.execute(name, JSON.stringify({ path }));
function hasCode(result: ToolResult, code: string) {
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, code);
}

test("only an explicit valid workspace enables filesystem definitions and execution", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  assert.deepEqual(defaultTools.definitions.map((tool) => tool.function.name), ["sum"]);
  hasCode(await call(defaultTools, "read_file", "notes.txt"), "UNKNOWN_TOOL");
  hasCode(await defaultTools.execute("__proto__", "{}"), "UNKNOWN_TOOL");
  const tools = await createTools(workspace);
  assert.deepEqual(tools.definitions.map((tool) => tool.function.name), ["sum", "list_directory", "read_file"]);
  await assert.rejects(createTools(join(workspace, "missing")), /existing accessible directory/);
  await assert.rejects(createTools(" "), /existing accessible directory/);
  await writeFile(join(workspace, "file.txt"), "text");
  await assert.rejects(createTools(join(workspace, "file.txt")), /existing accessible directory/);
});

test("list and read support nested Windows paths and UTF-8 without modifying files", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await mkdir(join(workspace, "docs"));
  const content = "Line one\r\n\u4e2d\u6587\n";
  const path = join(workspace, "docs", "notes.TXT");
  await writeFile(path, content);
  const tools = await createTools(workspace);
  assert.deepEqual(await call(tools, "list_directory", "."), {
    ok: true, result: { path: ".", entries: [{ name: "docs", type: "directory" }], truncated: false },
  });
  assert.deepEqual(await call(tools, "read_file", "docs\\notes.TXT"), {
    ok: true, result: { path: "docs/notes.TXT", content },
  });
  assert.equal(await readFile(path, "utf8"), content);
  await writeFile(join(workspace, "empty.txt"), "");
  await writeFile(join(workspace, "bom.txt"), "\ufeffHello");
  assert.deepEqual(await call(tools, "read_file", "empty.txt"), { ok: true, result: { path: "empty.txt", content: "" } });
  assert.deepEqual(await call(tools, "read_file", "bom.txt"), { ok: true, result: { path: "bom.txt", content: "Hello" } });
});

test("path validation rejects traversal, absolute, device, stream, and hidden paths", async (t) => {
  const { workspace, outside } = await temporaryWorkspace(t);
  await writeFile(join(outside, "secret.txt"), "outside-only");
  const tools = await createTools(workspace);
  for (const path of ["../outside/secret.txt", "docs/../../outside/secret.txt", "..\\outside\\secret.txt",
    join(outside, "secret.txt"), "/secret.txt", "C:\\secret.txt", "C:secret.txt", "\\\\host\\share\\file.txt",
    "\\\\?\\C:\\secret.txt", "notes.txt:secret", "CON.txt", "nul", "folder./notes.txt", "folder /notes.txt",
    ".env", ".ENV.local", "docs/.private/file.txt", ".git/config", "node_modules/file.txt", "NODE_MODULES/file.txt", "bad\0.txt"]) {
    const result = await call(tools, "read_file", path);
    hasCode(result, "PATH_NOT_ALLOWED");
    assert.ok(!JSON.stringify(result).includes("outside-only"));
    assert.ok(!JSON.stringify(result).includes(workspace));
  }
});

test("directory listings omit dot paths, dependencies, and unsupported file types", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  for (const name of [".env", ".env.example", "secret.key", "photo.png", "notes.txt"]) await writeFile(join(workspace, name), "data");
  for (const name of [".git", "node_modules", "docs"]) await mkdir(join(workspace, name));
  const tools = await createTools(workspace);
  assert.deepEqual(await call(tools, "list_directory", "."), { ok: true, result: {
    path: ".", entries: [{ name: "docs", type: "directory" }, { name: "notes.txt", type: "file" }], truncated: false,
  } });
});

test("junctions and hard links cannot expose another directory or file", async (t) => {
  const { workspace, outside } = await temporaryWorkspace(t);
  await writeFile(join(outside, "secret.txt"), "outside-only");
  await symlink(outside, join(workspace, "escape"), process.platform === "win32" ? "junction" : "dir");
  await link(join(outside, "secret.txt"), join(workspace, "linked.txt"));
  const tools = await createTools(workspace);
  hasCode(await call(tools, "read_file", "escape/secret.txt"), "PATH_NOT_ALLOWED");
  hasCode(await call(tools, "list_directory", "escape"), "PATH_NOT_ALLOWED");
  hasCode(await call(tools, "read_file", "linked.txt"), "PATH_NOT_ALLOWED");
  assert.deepEqual(await call(tools, "list_directory", "."), { ok: true, result: { path: ".", entries: [], truncated: false } });
});

test("file results enforce byte limits, text encoding, and regular file types", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const tools = await createTools(workspace);
  await writeFile(join(workspace, "limit.txt"), "a".repeat(65536));
  await writeFile(join(workspace, "large.txt"), "a".repeat(65537));
  await writeFile(join(workspace, "bad.txt"), Buffer.from([0xff, 0xfe]));
  await writeFile(join(workspace, "binary.txt"), Buffer.from([65, 0, 66]));
  await writeFile(join(workspace, "image.png"), "text");
  await mkdir(join(workspace, "folder.txt"));
  const limit = await call(tools, "read_file", "limit.txt");
  assert.equal(limit.ok, true);
  hasCode(await call(tools, "read_file", "large.txt"), "FILE_TOO_LARGE");
  for (const path of ["bad.txt", "binary.txt", "image.png", "folder.txt"]) {
    hasCode(await call(tools, "read_file", path), "UNSUPPORTED_FILE");
  }
  hasCode(await call(tools, "list_directory", "limit.txt"), "INVALID_ARGUMENTS");
});

test("directory results signal partial listings and stop at a bounded entry count", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  for (let i = 0; i < 101; i++) await writeFile(join(workspace, `${i}.txt`), "");
  const tools = await createTools(workspace);
  const result = await call(tools, "list_directory", ".");
  assert.equal(result.ok, true);
  if (result.ok) {
    const value = result.result as { entries: unknown[]; truncated: boolean };
    assert.equal(value.entries.length, 100);
    assert.equal(value.truncated, true);
  }
});

test("malformed arguments and missing files become safe tool errors; cancellation remains fatal", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const tools = await createTools(workspace);
  for (const args of ["{", "[]", "null", "{}", '{"path":1}', '{"path":""}', '{"path":".","extra":true}', JSON.stringify({ path: "a".repeat(1025) })]) {
    hasCode(await tools.execute("read_file", args), "INVALID_ARGUMENTS");
  }
  hasCode(await call(tools, "read_file", "missing.txt"), "NOT_FOUND");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(tools.execute("list_directory", '{"path":"."}', controller.signal), /cancelled/);
});
