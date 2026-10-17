import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { describe, it } from "node:test";
import { parseCliOptions } from "@fatcat/cli/internal/cli/options";

describe("CLI argument boundaries", () => {
  it("distinguishes optional resume selectors from option values and literal arguments", () => {
    for (const flag of ["--resume", "-r"]) {
      assert.equal(parseCliOptions([flag]).values.resume, "");
      assert.equal(parseCliOptions([flag]).values.chat, true);
      const tui = parseCliOptions([flag, "--tui"]);
      assert.equal(tui.values.resume, "");
      assert.equal(tui.values.chat, undefined);
      assert.equal(parseCliOptions([flag, "saved session"]).values.resume, "saved session");
      assert.deepEqual(parseCliOptions(["--", flag]).positionals, [flag]);
    }
    assert.equal(parseCliOptions(["--resume=-name"]).values.resume, "-name");
    assert.deepEqual(parseCliOptions(["--resume", "--", "-r"]).positionals, ["-r"]);
  });

  it("infers chat only when selection has no explicit mode or prompt", () => {
    for (const selection of [["--name", "New"], ["--project", "project"], ["--continue"]]) {
      assert.equal(parseCliOptions(selection).values.chat, true);
      assert.equal(parseCliOptions([...selection, "--prompt", "task"]).values.chat, undefined);
      assert.equal(parseCliOptions([...selection, "--webui"]).values.chat, undefined);
    }
    assert.deepEqual(parseCliOptions([]), { values: Object.create(null), positionals: [] });
    // These are checked at their existing launch stages, after local early-return paths.
    assert.equal(parseCliOptions(["--prompt", " "]).values.prompt, " ");
    assert.equal(parseCliOptions(["--tui"]).values.tui, true);
  });

  it("preserves the first error when several argument groups are invalid", () => {
    const cases: [string[], RegExp][] = [
      [["--unknown", "--chat", "--tui"], /Invalid arguments/],
      [["--chat", "--tui", "--port", "bad"], /Choose one mode/],
      [["--webui", "--workspace", " ", "--port", "bad"], /Use --workspace/],
      [["--webui", "--port", "bad", "--permission", "bad"], /Use --port/],
      [["--chat", "--continue", "--resume", "--web-permission", "bad"], /Choose --continue or --resume/],
      [["--chat", "--web-permission", "bad", "--permission", "bad"], /Use --web-permission/],
      [["--chat", "--permission", "bad", "--shell-permission", "bad"], /Use --permission ask/],
      [["--chat", "--permission-mode", "freeToGo", "--web-permission", "deny"], /Free to go cannot be combined/],
    ];
    for (const [args, message] of cases) {
      assert.throws(() => parseCliOptions(args), (error: unknown) => {
        assert.ok(error instanceof Error && "code" in error);
        assert.equal(error.code, "USAGE");
        assert.match(error.message, message);
        return true;
      });
    }
  });

  it("imports parsing and orchestration without executing argv or installing host listeners", () => {
    const modules = [import.meta.resolve("@fatcat/cli/internal/cli/options"), import.meta.resolve("@fatcat/cli")];
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      process.argv = [process.execPath, "fixture", "--version"];
      const before = process.listenerCount("SIGINT");
      for (const url of ${JSON.stringify(modules)}) await import(url);
      assert.equal(process.listenerCount("SIGINT"), before);
      assert.equal(process.exitCode, undefined);
    `], { encoding: "utf8", timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
  });
});
