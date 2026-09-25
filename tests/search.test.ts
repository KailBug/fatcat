import assert from "node:assert/strict";
import { link, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { createAgent } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import { runAgent } from "../src/loop.js";
import { createTools } from "../src/tools.js";
import type { Tools, ToolResult } from "../src/tools.js";
import { createReadTool } from "../src/tools/read.js";
import { createWorkspace } from "../src/tools/workspace.js";
import { temporaryWorkspace } from "./fixtures/workspace.js";

type SearchResult = { kind: string; path: string; query: string; offset: number; totalMatches: number;
  matches: { path: string; line: number; text: string }[]; truncated: boolean; nextOffset: number | null;
  scannedFiles: number; skippedFiles: number; complete: boolean };
async function search(tools: Tools, args: object): Promise<SearchResult> {
  const result = await tools.execute("read", JSON.stringify(args));
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as { ok: true; result: unknown }).result as SearchResult;
}
function errorCode(result: ToolResult, code: string) {
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, code);
}

test("read query searches a file or subtree with stable paths, literal matches and original line numbers", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await mkdir(join(workspace, "nested"));
  const source = "\ufeffIntro\r\n\r\nNeedle [x] twice [x]\rTail [x]\n";
  await writeFile(join(workspace, "nested", "code.TS"), source);
  await writeFile(join(workspace, "a.txt"), "[x] first\n[x] second\n");
  await writeFile(join(workspace, "empty.txt"), "");
  const tools = await createTools(workspace);
  const whole = await search(tools, { path: ".", query: "[x]" });
  assert.deepEqual(whole.matches, [
    { path: "a.txt", line: 1, text: "[x] first" }, { path: "a.txt", line: 2, text: "[x] second" },
    { path: "nested/code.TS", line: 3, text: "Needle [x] twice [x]" },
    { path: "nested/code.TS", line: 4, text: "Tail [x]" },
  ]);
  assert.equal(whole.kind, "search");
  assert.equal(whole.totalMatches, 4);
  assert.equal(whole.scannedFiles, 3);
  assert.equal(whole.complete, true);
  assert.equal(whole.skippedFiles, 0);
  assert.equal(whole.nextOffset, null);
  const file = await search(tools, { path: "nested\\code.TS", query: "[x]" });
  assert.deepEqual(file.matches, whole.matches.slice(2));
  assert.equal(file.path, "nested/code.TS");
  assert.equal((await search(tools, { path: ".", query: "needle" })).totalMatches, 0);
  assert.equal((await search(tools, { path: "empty.txt", query: "x" })).totalMatches, 0);
  assert.equal(await readFile(join(workspace, "nested", "code.TS"), "utf8"), source);
  assert.deepEqual(tools.getWrites!(), []);
  assert.deepEqual(tools.getCommands!(), []);
});

test("search pages advance over matching lines, including empty and past-end pages", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await writeFile(join(workspace, "a.ts"), "hit one\nmiss\nhit two\n");
  await writeFile(join(workspace, "b.ts"), "hit three");
  const tools = await createTools(workspace);
  let offset: number | null = 0;
  const all: SearchResult["matches"] = [];
  do {
    const page = await search(tools, { path: ".", query: "hit", offset, limit: 1 });
    assert.equal(page.totalMatches, 3);
    assert.equal(page.complete, true);
    all.push(...page.matches);
    assert.equal(page.truncated, page.nextOffset !== null);
    if (page.nextOffset !== null) assert.ok(page.nextOffset > offset);
    offset = page.nextOffset;
  } while (offset !== null);
  assert.deepEqual(all.map(({ path, line }) => [path, line]), [["a.ts", 1], ["a.ts", 3], ["b.ts", 1]]);
  const empty = await search(tools, { path: ".", query: "hit", offset: Number.MAX_SAFE_INTEGER });
  assert.deepEqual(empty.matches, []);
  assert.equal(empty.nextOffset, null);
  assert.equal(empty.truncated, false);
});

test("search bounds encoded match payloads and rejects an oversized whole line", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const line = "hit " + "\"".repeat(6000);
  await writeFile(join(workspace, "quoted.txt"), `${line}\n${line}`);
  await writeFile(join(workspace, "unicode.txt"), "\u4e2d\u6587 \u{1f408}");
  const tools = await createTools(workspace);
  const page = await search(tools, { path: "quoted.txt", query: "hit" });
  assert.equal(page.matches.length, 1);
  assert.equal(page.nextOffset, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(page.matches)) <= 16384);
  assert.equal((await search(tools, { path: "quoted.txt", query: "hit", offset: 1 })).nextOffset, null);
  assert.equal((await search(tools, { path: ".", query: "\u{1f408}" })).matches[0]!.text, "\u4e2d\u6587 \u{1f408}");
  await writeFile(join(workspace, "long.txt"), "hit " + "x".repeat(16384));
  errorCode(await tools.execute("read", JSON.stringify({ path: "long.txt", query: "hit" })), "OUTPUT_LIMIT");
});

test("invalid queries cannot turn search into regex, multiline, or unbounded input", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  const tools = await createTools(workspace);
  for (const query of [null, false, 42, {}, [], "", " ", "x\ny", "x\ry", "x\0", "x".repeat(513), "\ud800"]) {
    errorCode(await tools.execute("read", JSON.stringify({ path: ".", query })), "INVALID_ARGUMENTS");
  }
  for (const options of [{ regex: true }, { recursive: true }, { offset: -1 }, { limit: 201 }]) {
    errorCode(await tools.execute("read", JSON.stringify({ path: ".", query: "valid", ...options })), "INVALID_ARGUMENTS");
  }
  assert.equal((await search(tools, { path: ".", query: "x".repeat(512) })).totalMatches, 0);
});

test("recursive search excludes restricted names, dependencies, unsupported extensions and links", async (t) => {
  const { workspace, outside } = await temporaryWorkspace(t);
  for (const folder of [".private", "node_modules", "src"]) {
    await mkdir(join(workspace, folder));
    await writeFile(join(workspace, folder, "code.ts"), folder === "src" ? "hit allowed" : "hit hidden-secret");
  }
  await writeFile(join(workspace, ".env"), "hit hidden-secret");
  await writeFile(join(workspace, "image.png"), "hit unsupported-secret");
  await writeFile(join(outside, "secret.ts"), "hit outside-secret");
  await symlink(outside, join(workspace, "escape"), process.platform === "win32" ? "junction" : "dir");
  await link(join(outside, "secret.ts"), join(workspace, "linked.ts"));
  const tools = await createTools(workspace);
  const result = await search(tools, { path: ".", query: "hit" });
  assert.deepEqual(result.matches, [{ path: "src/code.ts", line: 1, text: "hit allowed" }]);
  assert.equal(result.complete, true);
  assert.ok(!JSON.stringify(result).includes("secret"));
  assert.ok(!JSON.stringify(result).includes(workspace));
  for (const path of ["../outside", "escape", "linked.ts", ".private", "node_modules", "src/code.ts:stream"]) {
    errorCode(await tools.execute("read", JSON.stringify({ path, query: "hit" })), "PATH_NOT_ALLOWED");
  }
});

test("skipped oversized and invalid text files make recursive coverage explicitly incomplete", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await writeFile(join(workspace, "good.ts"), "nothing relevant");
  await writeFile(join(workspace, "large.ts"), "hit" + "x".repeat(1048576));
  await writeFile(join(workspace, "bad.ts"), Buffer.from([0xff]));
  await writeFile(join(workspace, "binary.ts"), Buffer.from([65, 0, 66]));
  const tools = await createTools(workspace);
  const result = await search(tools, { path: ".", query: "hit" });
  assert.equal(result.totalMatches, 0);
  assert.equal(result.complete, false);
  assert.equal(result.skippedFiles, 3);
  assert.equal(result.scannedFiles, 1);
  assert.equal(result.nextOffset, null);
  errorCode(await tools.execute("read", '{"path":"large.ts","query":"hit"}'), "FILE_TOO_LARGE");
  errorCode(await tools.execute("read", '{"path":"bad.ts","query":"hit"}'), "UNSUPPORTED_FILE");
});

test("candidate-file and depth limits fail without returning incomplete matches as exhaustive", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await mkdir(join(workspace, "files"));
  for (let index = 0; index < 128; index++) await writeFile(join(workspace, "files", `${index}.ts`), "hit");
  const tools = await createTools(workspace);
  assert.equal((await search(tools, { path: "files", query: "hit" })).totalMatches, 128);
  await writeFile(join(workspace, "files", "overflow.ts"), "hit");
  errorCode(await tools.execute("read", '{"path":"files","query":"hit"}'), "SEARCH_LIMIT");
  let path = "deep";
  await mkdir(join(workspace, path));
  for (let depth = 0; depth < 12; depth++) { path += "/d"; await mkdir(join(workspace, path)); }
  await writeFile(join(workspace, path, "code.ts"), "hit");
  assert.equal((await search(tools, { path: "deep", query: "hit" })).totalMatches, 1);
  await mkdir(join(workspace, path, "extra"));
  errorCode(await tools.execute("read", '{"path":"deep","query":"hit"}'), "SEARCH_LIMIT");
});

test("raw entry budget includes unsupported files and narrow paths remain usable", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await mkdir(join(workspace, "src"));
  await writeFile(join(workspace, "src", "code.ts"), "hit");
  for (let index = 0; index < 1000; index++) await writeFile(join(workspace, `${index}.png`), "");
  const tools = await createTools(workspace);
  errorCode(await tools.execute("read", '{"path":".","query":"hit"}'), "SEARCH_LIMIT");
  assert.equal((await search(tools, { path: "src", query: "hit" })).totalMatches, 1);
});

test("cancellation and a file gaining a hard link after enumeration prevent content access", async (t) => {
  const { workspace, outside } = await temporaryWorkspace(t);
  await writeFile(join(workspace, "code.ts"), "hit safe");
  const scope = await createWorkspace(workspace);
  const controller = new AbortController();
  let resolutions = 0;
  const tool = createReadTool({ ...scope, async resolvePath(path, signal) {
    const target = await scope.resolvePath(path, signal);
    if (++resolutions === 2) controller.abort();
    return target;
  } });
  await assert.rejects(async () => tool.execute({ path: ".", query: "hit" }, controller.signal), /cancelled/);
  const tools = await createTools(workspace);
  await assert.rejects(tools.execute("read", '{"path":".","query":"hit"}', controller.signal), /cancelled/);
  let files = 0;
  const changed = createReadTool({ ...scope, async resolvePath(path, signal) {
    if (path.endsWith("code.ts") && ++files === 2) {
      // A second link makes the original candidate ineligible before its content is opened.
      await link(join(workspace, "code.ts"), join(outside, "alias.ts"));
    }
    return scope.resolvePath(path, signal);
  } });
  await assert.rejects(async () => changed.execute({ path: ".", query: "hit" }), /allowed relative path/);
});

test("the SDK child sees the same query schema and returns search results to its parent", async (t) => {
  const { workspace } = await temporaryWorkspace(t);
  await mkdir(join(workspace, "src"));
  await writeFile(join(workspace, "src", "code.ts"), "export const findMe = 42;");
  const config = loadConfig({ DEEPSEEK_API_KEY: "offline-search-only", HARNESS_MAX_ITERATIONS: "3" });
  let searches = 0;
  const agent = createAgent(config, await createTools(workspace), async (input, init) => {
    const body = await new Request(input, init).json() as { messages: { role: string; content?: string }[];
      tools: { function: { name: string; parameters: { properties: Record<string, unknown> } } }[] };
    const parent = body.tools.some((tool) => tool.function.name === "delegate_task");
    assert.ok(body.tools.find((tool) => tool.function.name === "read")!.function.parameters.properties.query);
    const last = body.messages.at(-1)!;
    const name = parent ? "delegate_task" : "read";
    if (last.role === "user") {
      if (!parent) searches++;
      const args = parent ? { task: "Locate findMe in src" } : { path: "src", query: "findMe" };
      return Response.json({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null,
        tool_calls: [{ id: name, type: "function", function: { name, arguments: JSON.stringify(args) } }] } }] });
    }
    assert.match(last.content!, /src\/code.ts/);
    return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Found src/code.ts:1" } }] });
  });
  assert.equal(await runAgent("Investigate", agent), "Found src/code.ts:1");
  assert.equal(searches, 1);
});
