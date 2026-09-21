import assert from "node:assert/strict";
import test from "node:test";
import { executeTool } from "../src/tools.js";

test("sum handles positive, negative, and decimal inputs without side effects", async () => {
  assert.deepEqual(await executeTool("sum", '{"numbers":[17,25]}'), { ok: true, result: 42 });
  assert.deepEqual(await executeTool("sum", '{"numbers":[-2,0.5,1.5]}'), { ok: true, result: 0 });
});

test("sum rejects malformed JSON and schema violations", async () => {
  for (const args of ["{", "null", "[]", "1", "{}", '{"numbers":[1]}',
    '{"numbers":[1,"2"]}', '{"numbers":[1,null]}', '{"numbers":[1,2],"extra":true}',
    '{"numbers":[1,1e400]}', JSON.stringify({ numbers: Array(33).fill(1) })]) {
    const result = await executeTool("sum", args);
    assert.equal(result.ok, false, args);
    if (!result.ok) assert.equal(result.error.code, "INVALID_ARGUMENTS");
  }
});

test("unknown tools and arithmetic overflow return structured errors", async () => {
  const unknown = await executeTool("not_available", "{}");
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.error.code, "UNKNOWN_TOOL");
  const overflow = await executeTool("sum", JSON.stringify({ numbers: [Number.MAX_VALUE, Number.MAX_VALUE] }));
  assert.equal(overflow.ok, false);
  if (!overflow.ok) assert.equal(overflow.error.code, "TOOL_EXECUTION_FAILED");
});
