import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createAgent } from "../src/agent.js";
import { loadConfig } from "../src/config.js";
import type { Message } from "../src/model.js";
import { Session } from "../src/session/session.js";
import { discoverSkills, withSkills } from "../src/skills.js";
import type { SkillDescriptor } from "../src/skills.js";
import { defaultTools } from "../src/tools.js";
import type { ToolResult } from "../src/tools.js";
import { temporaryWorkspace } from "./fixtures/workspace.js";

const bundled = [
  { subsystem: "web", name: "web-research" },
  { subsystem: "web", name: "weather-lookup" },
  { subsystem: "tools", name: "workspace-editing" },
  { subsystem: "subagent", name: "focused-delegation" },
  { subsystem: "context", name: "context-recovery" },
  { subsystem: "execution-report", name: "verification-handoff" },
];
const builtRoot = fileURLToPath(new URL("../src/skill/", import.meta.url));
const sourceRoot = fileURLToPath(new URL("../../src/skill/", import.meta.url));

function document(name: string, body = "Use the existing tools and permissions.") {
  return `---\nname: ${name}\ndescription: A controlled offline fixture.\n---\n${body}\n`;
}

async function install(root: string, name: string, body?: string) {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "SKILL.md"), document(name, body));
  return directory;
}

function objectResult(result: ToolResult): Record<string, unknown> {
  assert.equal(result.ok, true, JSON.stringify(result));
  if (!result.ok || result.result === null || typeof result.result !== "object" || Array.isArray(result.result)) {
    throw new Error("Expected a successful object result.");
  }
  return result.result;
}

function errorCode(result: ToolResult, code: string) {
  assert.equal(result.ok, false, JSON.stringify(result));
  if (!result.ok) assert.equal(result.error.code, code);
}

test("built-in skills ship with the build and add only catalogued reads without a workspace", async (t) => {
  const { outside: userHome } = await temporaryWorkspace(t);
  const catalog = await discoverSkills({ userHome });
  assert.equal(catalog.warnings.length, 0);
  assert.equal(catalog.skills.length, bundled.length);
  const tools = withSkills(defaultTools, catalog);
  assert.deepEqual(tools.definitions.map((entry) => entry.function.name), ["sum", "read"]);
  for (const expected of bundled) {
    const descriptor = catalog.skills.find((entry) => entry.name === expected.name);
    assert.ok(descriptor, expected.name);
    assert.equal(descriptor.scope, "builtin");
    assert.equal(descriptor.subsystem, expected.subsystem);
    const relative = join(expected.subsystem, expected.name, "SKILL.md");
    const source = await readFile(join(sourceRoot, relative), "utf8");
    assert.equal(await readFile(join(builtRoot, relative), "utf8"), source);
    const result = objectResult(await tools.execute("read", JSON.stringify({ path: descriptor.uri })));
    assert.equal(result.kind, "skill");
    assert.equal(result.content, source);
    assert.equal(result.baseDirectory, join(builtRoot, expected.subsystem, expected.name));
  }
  errorCode(await tools.execute("read", JSON.stringify({ path: "package.json" })), "PATH_NOT_ALLOWED");
  errorCode(await tools.execute("read", JSON.stringify({ path: join(builtRoot, "tools", "workspace-editing", "SKILL.md") })), "PATH_NOT_ALLOWED");
  errorCode(await tools.execute("write", JSON.stringify({ path: "new.txt", content: "not allowed" })), "UNKNOWN_TOOL");
  errorCode(await tools.execute("shell", JSON.stringify({ command: "exit 0" })), "UNKNOWN_TOOL");
  assert.deepEqual((await discoverSkills({ userHome, builtinRoot: false })).skills, []);
});

test("credential-free CLI finds launch-directory and packaged skills outside the installation", async (t) => {
  const { workspace, outside: userHome } = await temporaryWorkspace(t);
  await install(join(workspace, ".fatcat", "skills"), "cwd-only", "Discover the launch workspace without loading this body.");
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const result = spawnSync(process.execPath, [cli, "--listSkills"], {
    cwd: workspace,
    encoding: "utf8",
    timeout: 5000,
    env: { ...process.env, HOME: userHome, USERPROFILE: userHome, HARNESS_PROVIDER: "deepseek",
      DEEPSEEK_API_KEY: "", MOONSHOT_API_KEY: "", MIMO_API_KEY: "", DASHSCOPE_API_KEY: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  const listed = (JSON.parse(result.stdout) as { skills: SkillDescriptor[] }).skills;
  assert.deepEqual(listed.map((entry) => entry.name).sort(), [...bundled.map((entry) => entry.name), "cwd-only"].sort());
  assert.equal(listed.find((entry) => entry.name === "cwd-only")?.scope, "workspace");
  const builtins = listed.filter((entry) => entry.scope === "builtin");
  assert.equal(builtins.length, bundled.length);
  assert.ok(builtins.every((entry) => entry.subsystem));
  assert.ok(!result.stdout.includes(builtRoot));
  assert.ok(!result.stdout.includes(workspace));
  assert.ok(!result.stdout.includes("without loading this body"));
  for (const entry of builtins) assert.deepEqual(Object.keys(entry).sort(), ["description", "name", "scope", "subsystem", "uri"]);
});

test("workspace and user conventions take precedence over same-named built-in skills", async (t) => {
  const { base, workspace, outside: userHome } = await temporaryWorkspace(t);
  const builtinRoot = join(base, "builtin");
  const names = ["workspace-native", "workspace-convention", "user-native", "user-convention", "builtin-only"];
  for (const name of names) await install(join(builtinRoot, "tools"), name, "BUILTIN_SOURCE");
  for (const name of names.slice(0, 4)) await install(join(userHome, ".agents", "skills"), name, "USER_CONVENTION");
  for (const name of names.slice(0, 3)) await install(join(userHome, ".fatcat", "skills"), name, "USER_NATIVE");
  for (const name of names.slice(0, 2)) await install(join(workspace, ".agents", "skills"), name, "WORKSPACE_CONVENTION");
  await install(join(workspace, ".fatcat", "skills"), names[0]!, "WORKSPACE_NATIVE");
  const catalog = await discoverSkills({ workspace, userHome, builtinRoot });
  assert.equal(catalog.skills.length, names.length);
  const expected = [
    ["workspace-native", "workspace", "WORKSPACE_NATIVE"],
    ["workspace-convention", "workspace", "WORKSPACE_CONVENTION"],
    ["user-native", "user", "USER_NATIVE"],
    ["user-convention", "user", "USER_CONVENTION"],
    ["builtin-only", "builtin", "BUILTIN_SOURCE"],
  ];
  for (const [name, scope, body] of expected) {
    const descriptor = catalog.skills.find((entry) => entry.name === name)!;
    assert.equal(descriptor.scope, scope);
    assert.equal(descriptor.subsystem, scope === "builtin" ? "tools" : undefined);
    const result = objectResult(await catalog.read({ path: descriptor.uri }));
    assert.equal(result.content, document(name!, body));
  }
});

test("built-in discovery remains two levels deep and rejects malformed packages and unsafe resource paths", async (t) => {
  const { base, outside: userHome } = await temporaryWorkspace(t);
  const builtinRoot = join(base, "builtin");
  const directory = await install(join(builtinRoot, "tools"), "safe");
  await install(join(builtinRoot, "tools", "nested"), "hidden");
  const invalid = await install(join(builtinRoot, "tools"), "invalid");
  await writeFile(join(invalid, "SKILL.md"), document("different", "PRIVATE_BAD_METADATA"));
  await writeFile(join(directory, "guide.md"), "A bundled reference.\n");
  await writeFile(join(directory, ".env"), "PRIVATE_RESOURCE");
  const catalog = await discoverSkills({ userHome, builtinRoot });
  assert.deepEqual(catalog.skills.map((entry) => entry.name), ["safe"]);
  assert.equal(objectResult(await catalog.read({ path: "skill://safe/guide.md" })).content, "A bundled reference.\n");
  for (const path of ["skill://safe/../SKILL.md", "skill://safe/%2e%2e/SKILL.md", "skill://safe/SKILL.md/",
    "skill://safe/..\\SKILL.md", "skill://safe/.env"]) {
    errorCode(await catalog.read({ path }), "PATH_NOT_ALLOWED");
  }
  errorCode(await catalog.read({ path: "skill://hidden/SKILL.md" }), "NOT_FOUND");
  assert.ok(catalog.warnings.length > 0);
  assert.ok(!JSON.stringify(catalog.warnings).includes("PRIVATE_BAD_METADATA"));
  assert.ok(!JSON.stringify(catalog.warnings).includes(builtinRoot));
});

test("built-in roots, subsystems and packages cannot enter through junctions", async (t) => {
  for (const level of ["root", "subsystem", "package"]) {
    await t.test(level, async (subtest) => {
      const { base, outside: userHome } = await temporaryWorkspace(subtest);
      const installedRoot = join(base, "installed");
      await install(join(installedRoot, "tools"), "sample");
      const builtinRoot = join(base, "builtin");
      const parts = level === "root" ? [] : level === "subsystem" ? ["tools"] : ["tools", "sample"];
      const linked = join(builtinRoot, ...parts);
      await mkdir(join(linked, ".."), { recursive: true });
      await symlink(join(installedRoot, ...parts), linked, "junction");
      assert.deepEqual((await discoverSkills({ userHome, builtinRoot })).skills, []);
    });
  }
});

test("built-in reads recheck a replaced subsystem and reject resource junctions", async (t) => {
  const { base, outside: userHome } = await temporaryWorkspace(t);
  const builtinRoot = join(base, "builtin");
  const directory = await install(join(builtinRoot, "tools"), "sample");
  await writeFile(join(userHome, "private.md"), "PRIVATE_EXTERNAL_FILE");
  await symlink(userHome, join(directory, "references"), "junction");
  const catalog = await discoverSkills({ userHome, builtinRoot });
  errorCode(await catalog.read({ path: "skill://sample/references/private.md" }), "PATH_NOT_ALLOWED");
  const relocated = join(base, "relocated");
  await rename(join(builtinRoot, "tools"), relocated);
  await symlink(relocated, join(builtinRoot, "tools"), "junction");
  errorCode(await catalog.read({ path: "skill://sample/SKILL.md" }), "PATH_NOT_ALLOWED");
});

test("built-in discovery bounds both raw directory levels while preserving other valid sources", async (t) => {
  const { base, workspace, outside: userHome } = await temporaryWorkspace(t);
  await install(join(workspace, ".fatcat", "skills"), "project-skill");
  const builtinRoot = join(base, "builtin");
  await install(join(builtinRoot, "oversized"), "ignored");
  await Promise.all(Array.from({ length: 128 }, (_value, index) => writeFile(join(builtinRoot, "oversized", `entry-${index}.txt`), "")));
  await install(join(builtinRoot, "valid"), "fallback");
  const catalog = await discoverSkills({ workspace, userHome, builtinRoot });
  assert.deepEqual(catalog.skills.map((entry) => entry.name), ["project-skill", "fallback"]);
  assert.ok(catalog.warnings.some((warning) => warning.includes("oversized")));
  await Promise.all(Array.from({ length: 127 }, (_value, index) => writeFile(join(builtinRoot, `entry-${index}.txt`), "")));
  const oversized = await discoverSkills({ workspace, userHome, builtinRoot });
  assert.deepEqual(oversized.skills.map((entry) => entry.name), ["project-skill"]);
  assert.ok(oversized.warnings.some((warning) => warning.includes("oversized")));
});

test("built-in skills share the global catalog limit with higher-priority local skills", async (t) => {
  const { base, workspace, outside: userHome } = await temporaryWorkspace(t);
  await install(join(workspace, ".fatcat", "skills"), "project-skill");
  const builtinRoot = join(base, "builtin");
  for (let index = 0; index < 65; index++) await install(join(builtinRoot, "tools"), `entry-${String(index).padStart(3, "0")}`);
  const catalog = await discoverSkills({ workspace, userHome, builtinRoot });
  assert.equal(catalog.skills.length, 64);
  assert.equal(catalog.skills[0]?.name, "project-skill");
  assert.equal(catalog.skills.filter((entry) => entry.scope === "builtin").length, 63);
  assert.ok(catalog.warnings.some((warning) => warning.includes("64-skill")));
  errorCode(await catalog.read({ path: "skill://entry-064/SKILL.md" }), "NOT_FOUND");
});

test("an actual built-in skill loads through the SDK, persists in Session and loads independently for a child", async (t) => {
  const { outside: userHome } = await temporaryWorkspace(t);
  const catalog = await discoverSkills({ userHome });
  const source = await readFile(join(sourceRoot, "tools", "workspace-editing", "SKILL.md"), "utf8");
  const config = loadConfig({ DEEPSEEK_API_KEY: "offline-builtin-only", HARNESS_MAX_ITERATIONS: "4" });
  let parentReads = 0;
  let childReads = 0;
  function hasInstructions(messages: Message[]) {
    return messages.some((message) => {
      if (message.role !== "tool") return false;
      const result = JSON.parse(String(message.content)) as ToolResult;
      return result.ok && result.result !== null && typeof result.result === "object" && !Array.isArray(result.result)
        && result.result.kind === "skill" && result.result.content === source;
    });
  }
  const answer = (content: string) => Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] });
  const call = (name: string, args: unknown, id: string) => Response.json({ choices: [{ finish_reason: "tool_calls", message: {
    role: "assistant", content: null, tool_calls: [{ type: "function", id, function: { name, arguments: JSON.stringify(args) } }],
  } }] });
  const agent = createAgent(config, defaultTools, async (input, init) => {
    const { messages, tools } = await new Request(input, init).json() as { messages: Message[]; tools: { function: { name: string } }[] };
    const system = String(messages[0]?.content);
    for (const descriptor of catalog.skills) assert.ok(system.includes(descriptor.uri));
    assert.ok(!system.includes(source));
    const child = !tools.some((tool) => tool.function.name === "delegate_task");
    if (child) {
      if (messages.at(-1)?.role === "user") {
        assert.equal(hasInstructions(messages), false);
        childReads++;
        return call("read", { path: "skill://workspace-editing/SKILL.md" }, "child-read");
      }
      assert.equal(hasInstructions(messages), true);
      return answer("Child loaded the built-in skill.");
    }
    const prompt = messages.findLast((message) => message.role === "user")?.content;
    if (prompt === "Recall") return answer(hasInstructions(messages) ? "Loaded" : "Absent");
    if (prompt === "Delegate focused review") {
      assert.equal(hasInstructions(messages), true);
      if (messages.at(-1)?.role === "user") return call("delegate_task", { task: "Use $workspace-editing with independent evidence." }, "delegate");
      return answer("Delegated");
    }
    if (messages.at(-1)?.role === "user") {
      assert.equal(hasInstructions(messages), false);
      parentReads++;
      return call("read", { path: "skill://workspace-editing/SKILL.md" }, "parent-read");
    }
    assert.equal(hasInstructions(messages), true);
    return answer("Loaded");
  }, catalog);
  const session = new Session(agent);
  assert.equal(await session.run("Use $workspace-editing"), "Loaded");
  assert.equal(await session.run("Recall"), "Loaded");
  assert.equal(await session.run("Delegate focused review"), "Delegated");
  assert.equal(parentReads, 1);
  assert.equal(childReads, 1);
  session.reset();
  assert.equal(await session.run("Recall"), "Absent");
});
