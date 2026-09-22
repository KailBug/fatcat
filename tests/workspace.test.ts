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
  hasCode(await call(defaultTools, "read", "notes.txt"), "UNKNOWN_TOOL");
  hasCode(await defaultTools.execute("__proto__", "{}"), "UNKNOWN_TOOL");
  const tools = await createTools(workspace);
  assert.deepEqual(tools.definitions.map((tool) => tool.function.name), ["sum", "read"]);
  for (const oldName of ["list_directory", "read_file"]) hasCode(await call(tools, oldName, "."), "UNKNOWN_TOOL");
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
  assert.deepEqual(await call(tools, "read", "."), {
    ok: true, result: { kind: "directory", path: ".", offset: 0, totalEntries: 1, entries: [{ name: "docs", type: "directory" }], truncated: false, nextOffset: null },
  });
  assert.deepEqual(await call(tools, "read", "docs\\notes.TXT"), {
    ok: true, result: { kind: "file", path: "docs/notes.TXT", offset: 0, totalLines: 2, startLine: 1, endLine: 2, content, truncated: false, nextOffset: null },
  });
  assert.equal(await readFile(path, "utf8"), content);
  await writeFile(join(workspace, "empty.txt"), "");
  await writeFile(join(workspace, "bom.txt"), "\ufeffHello");
  assert.deepEqual(await call(tools, "read", "empty.txt"), { ok: true, result: { kind: "file", path: "empty.txt", offset: 0, totalLines: 0, startLine: null, endLine: null, content: "", truncated: false, nextOffset: null } });
  assert.deepEqual(await call(tools, "read", "bom.txt"), { ok: true, result: { kind: "file", path: "bom.txt", offset: 0, totalLines: 1, startLine: 1, endLine: 1, content: "Hello", truncated: false, nextOffset: null } });
});

test("path validation rejects traversal, absolute, device, stream, and hidden paths", async (t) => {
  const { workspace, outside } = await temporaryWorkspace(t);
  await writeFile(join(outside, "secret.txt"), "outside-only");
  const tools = await createTools(workspace);
  for (const path of ["../outside/secret.txt", "docs/../../outside/secret.txt", "..\\outside\\secret.txt",
    join(outside, "secret.txt"), "/secret.txt", "C:\\secret.txt", "C:secret.txt", "\\\\host\\share\\file.txt",
    "\\\\?\\C:\\secret.txt", "notes.txt:secret", "CON.txt", "nul", "folder./notes.txt", "folder /notes.txt",
    ".env", ".ENV.local", "docs/.private/file.txt", ".git/config", "node_modules/file.txt", "NODE_MODULES/file.txt", "bad\0.txt"]) {
    const result = await call(tools, "read", path);
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
  assert.deepEqual(await call(tools, "read", "."), { ok: true, result: {
    kind: "directory", path: ".", offset: 0, totalEntries: 2, entries: [{ name: "docs", type: "directory" }, { name: "notes.txt", type: "file" }], truncated: false, nextOffset: null,
  } });
});

test("junctions and hard links cannot expose another directory or file", async (t) => {
  const { workspace, outside } = await temporaryWorkspace(t);
  await writeFile(join(outside, "secret.txt"), "outside-only");
  await symlink(outside, join(workspace, "escape"), process.platform === "win32" ? "junction" : "dir");
  await link(join(outside, "secret.txt"), join(workspace, "linked.txt"));
  const tools = await createTools(workspace);
  hasCode(await call(tools, "read", "escape/secret.txt"), "PATH_NOT_ALLOWED");
  hasCode(await call(tools, "read", "escape"), "PATH_NOT_ALLOWED");
  hasCode(await call(tools, "read", "linked.txt"), "PATH_NOT_ALLOWED");
  assert.deepEqual(await call(tools, "read", "."), { ok: true, result: { kind: "directory", path: ".", offset: 0, totalEntries: 0, entries: [], truncated: false, nextOffset: null } });
});

test("file results enforce byte limits, text encoding, and regular file types", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const tools = await createTools(workspace);
  await writeFile(join(workspace, "limit.txt"), "a\n".repeat(524288));
  await writeFile(join(workspace, "large.txt"), "a".repeat(1048577));
  await writeFile(join(workspace, "bad.txt"), Buffer.from([0xff, 0xfe]));
  await writeFile(join(workspace, "binary.txt"), Buffer.from([65, 0, 66]));
  await writeFile(join(workspace, "image.png"), "text");
  await mkdir(join(workspace, "folder.txt"));
  const limit = await call(tools, "read", "limit.txt");
  assert.equal(limit.ok, true);
  hasCode(await call(tools, "read", "large.txt"), "FILE_TOO_LARGE");
  for (const path of ["bad.txt", "binary.txt", "image.png"]) {
    hasCode(await call(tools, "read", path), "UNSUPPORTED_FILE");
  }
  assert.equal((await call(tools, "read", "folder.txt")).ok, true);
});

test("directory results signal partial listings and stop at a bounded entry count", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  for (let i = 0; i < 101; i++) await writeFile(join(workspace, `${i}.txt`), "");
  const tools = await createTools(workspace);
  const result = await call(tools, "read", ".");
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
    hasCode(await tools.execute("read", args), "INVALID_ARGUMENTS");
  }
  hasCode(await call(tools, "read", "missing.txt"), "NOT_FOUND");
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(tools.execute("read", '{"path":"."}', controller.signal), /cancelled/);
});

type FilePage = { kind: string; path: string; offset: number; totalLines: number; startLine: number | null; endLine: number | null; content: string; truncated: boolean; nextOffset: number | null };
type DirectoryPage = { entries: { name: string; type: string }[]; totalEntries: number; truncated: boolean; nextOffset: number | null };
async function readPage(tools: Tools, path: string, offset: number, limit: number) {
  const result = await tools.execute("read", JSON.stringify({ path, offset, limit }));
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok) throw new Error("Expected a page.");
  return result.result;
}

test("file pages retain line endings and positions without an extra trailing line", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const content = "first\r\n\r\n\u4e2d\u6587\rlast\n";
  await writeFile(join(workspace, "lines.txt"), content);
  const tools = await createTools(workspace);
  const first = await readPage(tools, "lines.txt", 0, 2) as FilePage;
  const last = await readPage(tools, "lines.txt", first.nextOffset!, 2) as FilePage;
  assert.deepEqual(first, { kind: "file", path: "lines.txt", offset: 0, totalLines: 4,
    startLine: 1, endLine: 2, content: "first\r\n\r\n", truncated: true, nextOffset: 2 });
  assert.deepEqual(last, { kind: "file", path: "lines.txt", offset: 2, totalLines: 4,
    startLine: 3, endLine: 4, content: "\u4e2d\u6587\rlast\n", truncated: false, nextOffset: null });
  assert.equal(first.content + last.content, content);
  for (const offset of [4, 5, Number.MAX_SAFE_INTEGER]) {
    const empty = await readPage(tools, "lines.txt", offset, 1) as FilePage;
    assert.equal(empty.content, "");
    assert.equal(empty.startLine, null);
    assert.equal(empty.endLine, null);
    assert.equal(empty.nextOffset, null);
    assert.equal(empty.truncated, false);
  }
});

test("the page budget counts UTF-8 bytes and never silently drops a long line", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const line = "\u4e2d".repeat(3000) + "\n";
  await writeFile(join(workspace, "bytes.txt"), line.repeat(8));
  await writeFile(join(workspace, "long.txt"), "short\n" + "a".repeat(16385));
  await writeFile(join(workspace, "exact.txt"), "a".repeat(16384));
  const tools = await createTools(workspace);
  const first = await readPage(tools, "bytes.txt", 0, 100) as FilePage;
  assert.equal(first.content, line);
  assert.equal(first.nextOffset, 1);
  assert.equal(first.totalLines, 8);
  assert.equal((await readPage(tools, "bytes.txt", 7, 100) as FilePage).nextOffset, null);
  assert.equal((await readPage(tools, "exact.txt", 0, 100) as FilePage).content.length, 16384);
  const beforeLong = await readPage(tools, "long.txt", 0, 100) as FilePage;
  assert.equal(beforeLong.content, "short\n");
  assert.equal(beforeLong.nextOffset, 1);
  hasCode(await tools.execute("read", '{"path":"long.txt","offset":1}'), "OUTPUT_LIMIT");
});

test("directory pages cover the sorted allowed entries exactly once", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const names = ["z.txt", "a.txt", "Upper.txt", "b.md", "folder"];
  for (const name of names.slice(0, -1)) await writeFile(join(workspace, name), "");
  await mkdir(join(workspace, "folder"));
  await writeFile(join(workspace, ".hidden.txt"), "hidden");
  const tools = await createTools(workspace);
  const received: string[] = [];
  let offset: number | null = 0;
  do {
    const result = await readPage(tools, ".", offset, 2) as DirectoryPage;
    assert.equal(result.totalEntries, names.length);
    received.push(...result.entries.map((entry) => entry.name));
    if (result.nextOffset !== null) assert.ok(result.nextOffset > offset);
    offset = result.nextOffset;
  } while (offset !== null);
  assert.deepEqual(received, names.sort());
  const end = await readPage(tools, ".", names.length, 2) as DirectoryPage;
  assert.deepEqual(end.entries, []);
  assert.equal(end.truncated, false);
  assert.equal(end.nextOffset, null);
});

test("directory output is bounded and a raw scan overflow is an explicit error", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const tools = await createTools(workspace);
  const names = Array.from({ length: 100 }, (_, index) => `${String(index).padStart(3, "0")}-${"x".repeat(190)}.txt`);
  for (const name of names) await writeFile(join(workspace, name), "");
  const first = await readPage(tools, ".", 0, 200) as DirectoryPage;
  assert.ok(first.entries.length < 100);
  assert.ok(Buffer.byteLength(JSON.stringify(first.entries)) <= 16386);
  const last = await readPage(tools, ".", first.nextOffset!, 200) as DirectoryPage;
  assert.deepEqual([...first.entries, ...last.entries].map((entry) => entry.name), names);
  assert.equal(last.nextOffset, null);
  for (let index = 100; index < 1000; index++) await writeFile(join(workspace, `${index}.bin`), "");
  assert.equal((await call(tools, "read", ".")).ok, true);
  await writeFile(join(workspace, "overflow.bin"), "");
  hasCode(await call(tools, "read", "."), "DIRECTORY_TOO_LARGE");
  assert.equal((await call(tools, "read", names[0]!)).ok, true);
});

test("pagination validates optional fields strictly before accessing the path", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const tools = await createTools(workspace);
  for (const args of [
    { offset: -1 }, { offset: 0.5 }, { offset: "1" }, { offset: null }, { offset: Number.MAX_SAFE_INTEGER + 1 },
    { limit: 0 }, { limit: 201 }, { limit: 1.5 }, { limit: "1" }, { limit: null }, { extra: 1 },
  ]) hasCode(await tools.execute("read", JSON.stringify({ path: "missing.txt", ...args })), "INVALID_ARGUMENTS");
  const definition = tools.definitions.find((tool) => tool.function.name === "read")!.function.parameters!;
  assert.equal(definition.additionalProperties, false);
  assert.deepEqual(definition.required, ["path"]);
});
