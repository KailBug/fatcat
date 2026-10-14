import assert from "node:assert/strict";
import test from "node:test";
import { withAutomationTool } from "../src/automation/tool.js";
import { loadConfig } from "../src/config.js";
import { prepareRequestContext } from "../src/context/request.js";
import { createDocumentVision, type DocumentVision } from "../src/documents/vision.js";
import { HarnessError } from "../src/errors.js";
import { createTurnReporter, type ReportEvent } from "../src/execution-report.js";
import { runAgentTurn } from "../src/loop.js";
import type { Message, Model, ModelObservation, ModelTurn } from "../src/model.js";
import { withSkills, type SkillCatalog } from "../src/skills.js";
import { createSubagentTools } from "../src/subagent.js";
import type { Tools } from "../src/tools.js";
import { failure } from "../src/tools/types.js";

const config = loadConfig({ HARNESS_PROVIDER: "kimi", MOONSHOT_API_KEY: "offline-vision-budget" });
const image = { data: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ7sAAAAASUVORK5CYII=", "base64"),
  mimeType: "image/png" as const, width: 1, height: 1 };
const definition: Tools["definitions"][number] = { type: "function", function: {
  name: "read", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
} };

function answer(content: string): ModelTurn {
  return { message: { role: "assistant", content }, toolCalls: [] };
}

function calls(name: string, args: string, ...ids: string[]): ModelTurn {
  const toolCalls = ids.map((id) => ({ id, type: "function" as const, function: { name, arguments: args } }));
  return { message: { role: "assistant", content: null, tool_calls: toolCalls }, toolCalls };
}

function observation(observe?: (event: ModelObservation) => void): void {
  observe?.({ type: "model_input", bytes: 500, limitBytes: 262144, accepted: true });
  observe?.({ type: "model_usage", usage: { promptTokens: 8, completionTokens: 2, totalTokens: 10 } });
}

function visionTools(vision: DocumentVision, beforeAnalyze?: () => void): Tools {
  const tools: Tools = {
    definitions: [definition],
    execute: async () => failure("DOCUMENT_BUDGET", "Document requests require an executing turn."),
    forTurn: (_event, context) => ({ ...tools,
      execute: async (_name, _args, signal) => {
        try {
          beforeAnalyze?.();
          let observe: ((event: ModelObservation) => void) | undefined;
          const result = await vision.analyze([image], {
            mode: "visual", ...(signal ? { signal } : {}),
            beforeRequest: () => {
              if (!context) throw new HarnessError("DOCUMENT_BUDGET", "No turn allowance.");
              observe = context.documentRequest();
            },
            observe: (event) => observe?.(event),
          });
          return { ok: true, result: { content: result.text, sourceKind: result.sourceKind } };
        } catch (error) {
          if (!(error instanceof HarnessError) || error.code === "CANCELLED") throw error;
          return failure(error.code, error.message);
        }
      },
    }),
  };
  return tools;
}

test("document requests consume the turn allowance and preserve the final answer", async () => {
  let transfers = 0;
  let mainRequests = 0;
  const events: ReportEvent[] = [];
  const vision = createDocumentVision(config, async () => {
    transfers++;
    return Response.json({ usage: { prompt_tokens: 90, completion_tokens: 10, total_tokens: 100 },
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "The chart increases." } }] });
  });
  const model: Model = async (messages, _signal, observe, options) => {
    observation(observe);
    if (++mainRequests === 1) {
      assert.equal(options?.toolChoice, "auto");
      return calls("read", '{"path":"attachment:fixture"}', "page-one", "page-two");
    }
    assert.equal(options?.toolChoice, "none");
    assert.match(String(messages[0]?.content), /request 3 of 3/);
    const results = messages.filter((message) => message.role === "tool").map((message) => String(message.content));
    assert.match(results[0]!, /The chart increases/);
    assert.match(results[1]!, /DOCUMENT_BUDGET/);
    return answer("One page was analyzed; the second remains uncovered.");
  };
  const result = await runAgentTurn("Review both pages", [], { model, maxIterations: 3, tools: visionTools(vision),
    onEvent: createTurnReporter((event) => events.push(event)) });
  assert.equal(mainRequests, 2);
  assert.equal(transfers, 1);
  assert.match(result.answer, /uncovered/);
  assert.ok(!JSON.stringify(result.messages).includes(image.data.toString("base64")));
  assert.deepEqual(events.filter((event) => event.type === "model_request").map((event) =>
    ({ iteration: event.iteration, purpose: event.purpose ?? "conversation" })), [
    { iteration: 1, purpose: "conversation" }, { iteration: 2, purpose: "document" }, { iteration: 3, purpose: "conversation" },
  ]);
  const report = events.find((event) => event.type === "execution_report");
  assert.ok(report?.type === "execution_report");
  assert.deepEqual(report.report.modelRequests, { parent: 3, children: 0 });
  assert.deepEqual(report.report.tokenUsage.parent.totals, { promptTokens: 106, completionTokens: 14, totalTokens: 120 });
  assert.equal(report.report.toolResults.errors, 1);
});

test("a locally rejected document request is counted, reports bytes, and does not trigger conversation compaction", async () => {
  let transfers = 0;
  let mainRequests = 0;
  let compactions = 0;
  const events: ReportEvent[] = [];
  const vision = createDocumentVision({ ...config, maxRequestBytes: 1 }, async () => {
    transfers++;
    throw new Error("No document should be transmitted.");
  });
  await runAgentTurn("Read the image", [], {
    tools: visionTools(vision), maxIterations: 3,
    model: async (messages, _signal, observe, options) => {
      observation(observe);
      if (++mainRequests === 1) return calls("read", '{"path":"attachment:fixture"}', "rejected");
      assert.equal(options?.toolChoice, "none");
      assert.match(String(messages.at(-1)?.content), /MODEL_CONTEXT_LIMIT/);
      return answer("The image was not sent because it exceeds the byte limit.");
    },
    onContextLimit: async () => { compactions++; return undefined; },
    onEvent: createTurnReporter((event) => events.push(event)),
  });
  assert.equal(transfers, 0);
  assert.equal(compactions, 0);
  const report = events.find((event) => event.type === "execution_report");
  assert.ok(report?.type === "execution_report");
  assert.equal(report.report.modelRequests.parent, 3);
  assert.equal(report.report.requestBytes.parent.rejected, 1);
  assert.equal(report.report.tokenUsage.parent.reportedRequests, 2);
  assert.equal(report.report.outcome, "answered");
});

test("cancellation before document reservation sends nothing and stops the turn", async () => {
  const controller = new AbortController();
  let transfers = 0;
  const events: ReportEvent[] = [];
  const vision = createDocumentVision(config, async () => { transfers++; throw new Error("No transmission expected."); });
  await assert.rejects(runAgentTurn("Read", [], { signal: controller.signal,
    model: async () => calls("read", '{"path":"attachment:fixture"}', "cancelled"),
    tools: visionTools(vision, () => controller.abort()), maxIterations: 3,
    onEvent: createTurnReporter((event) => events.push(event)),
  }), { code: "CANCELLED" });
  assert.equal(transfers, 0);
  assert.equal(events.filter((event) => event.type === "model_request").length, 1);
  assert.ok(events.some((event) => event.type === "stopped" && event.code === "CANCELLED"));
  assert.ok(!events.some((event) => event.type === "completed" || event.type === "tool_result"));
});

test("cancellation during an auxiliary request aborts transport and prevents final continuation", async () => {
  const controller = new AbortController();
  let transfers = 0;
  let mainRequests = 0;
  const events: ReportEvent[] = [];
  const vision = createDocumentVision(config, async (_input, init) => new Promise<Response>((_resolve, reject) => {
    transfers++;
    init?.signal?.addEventListener("abort", () => reject(new Error("cancelled transfer")), { once: true });
    controller.abort();
  }));
  await assert.rejects(runAgentTurn("Read", [], { signal: controller.signal,
    model: async () => { mainRequests++; return calls("read", '{"path":"attachment:fixture"}', "cancelled"); },
    tools: visionTools(vision), maxIterations: 3, onEvent: createTurnReporter((event) => events.push(event)),
  }), { code: "CANCELLED" });
  assert.equal(mainRequests, 1);
  assert.equal(transfers, 1);
  const report = events.find((event) => event.type === "execution_report");
  assert.ok(report?.type === "execution_report");
  assert.equal(report.report.modelRequests.parent, 2);
  assert.equal(report.report.stopCode, "CANCELLED");
});

test("skill, automation, and delegation wrappers bind child document allowance independently", async () => {
  let transfers = 0;
  let children = 0;
  const vision = createDocumentVision(config, async () => {
    transfers++;
    return Response.json({ usage: { prompt_tokens: 90, completion_tokens: 10, total_tokens: 100 },
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Visible chart." } }] });
  });
  const catalog: SkillCatalog = {
    skills: [{ name: "document-review", description: "Review a document", uri: "skill://document-review/SKILL.md", scope: "builtin" }],
    warnings: [], readDefinition: definition,
    read: async () => { throw new Error("The attachment must use the original read implementation."); },
  };
  const child: Model = async (messages, _signal, observe, options) => {
    observation(observe);
    children++;
    if (messages.at(-1)?.role === "user") return calls("read", '{"path":"attachment:fixture"}', "child-page", "child-extra-page");
    assert.equal(options?.toolChoice, "none");
    assert.match(String(messages[0]?.content), /request 3 of 3/);
    assert.match(String(messages.at(-1)?.content), /DOCUMENT_BUDGET/);
    return answer("One child page analyzed; the next was not covered.");
  };
  const base = withSkills(visionTools(vision), catalog);
  const tools = withAutomationTool(createSubagentTools(base, child, 8));
  for (let run = 0; run < 2; run++) {
    const events: ReportEvent[] = [];
    let parentRequests = 0;
    const result = await runAgentTurn("Inspect attachment independently", [], { tools, maxIterations: 2,
      model: async (messages, _signal, observe, options) => {
        observation(observe);
        if (++parentRequests === 1) return calls("delegate_task", '{"task":"Review two image pages"}', "child-review");
        assert.equal(options?.toolChoice, "none");
        assert.match(String(messages[0]?.content), /request 2 of 2/);
        assert.match(String(messages.at(-1)?.content), /next was not covered/);
        return answer("The child inspected one page.");
      },
      onEvent: createTurnReporter((event) => events.push(event)),
    });
    assert.match(result.answer, /one page/);
    const report = events.find((event) => event.type === "execution_report");
    assert.ok(report?.type === "execution_report");
    assert.deepEqual(report.report.modelRequests, { parent: 2, children: 3 });
    assert.deepEqual(report.report.tokenUsage.children.totals, { promptTokens: 106, completionTokens: 14, totalTokens: 120 });
    assert.equal(events.filter((event) => event.type === "subagent_event"
      && event.callId === "child-review" && event.event.type === "model_request" && event.event.purpose === "document").length, 1);
  }
  assert.equal(transfers, 2);
  assert.equal(children, 4);
});

test("context omission retains the exact parse identity without rewriting stored evidence", () => {
  const path = `attachment:11111111-1111-4111-8111-111111111111@${"a".repeat(64)}`;
  const parserVersion = `derived-${"b".repeat(64)}`;
  const result = { ok: true, result: { kind: "document", path, parserVersion,
    units: [{ id: "page-1", text: "original evidence ".repeat(1000) }] } };
  const messages: Message[] = [
    { role: "system", content: "Rules" },
    { role: "user", content: "Earlier request" },
    calls("read", JSON.stringify({ path, parserVersion }), "earlier-document").message,
    { role: "tool", tool_call_id: "earlier-document", content: JSON.stringify(result) },
    answer("Earlier answer").message,
    { role: "user", content: "Recent request" },
    answer("Recent answer").message,
    { role: "user", content: "Current request" },
  ];
  const before = structuredClone(messages);
  const prepared = prepareRequestContext({ messages }, 2000);
  assert.equal(prepared.omittedReadResults, 1);
  assert.ok(prepared.bytes <= 2000);
  const marker = JSON.parse(String(prepared.body.messages[3]?.content)) as { result: Record<string, unknown> };
  assert.equal(marker.result.kind, "context_omitted");
  assert.equal(marker.result.originalKind, "document");
  assert.equal(marker.result.path, path);
  assert.equal(marker.result.parserVersion, parserVersion);
  assert.deepEqual(messages, before);
  assert.ok(!JSON.stringify(prepared.body).includes("original evidence"));
});
