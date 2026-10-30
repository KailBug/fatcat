import assert from "node:assert/strict";
import test from "node:test";
import { createTools, defaultTools, executeTool } from "@fatcat/runtime/tools";

test("default tools expose no implicit capabilities, including removed sum", async () => {
  assert.deepEqual(defaultTools.definitions, []);
  assert.deepEqual((await createTools()).definitions, []);
  for (const name of ["sum", "not_available"]) {
    const result = await executeTool(name, "{}");
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "UNKNOWN_TOOL");
  }
});
