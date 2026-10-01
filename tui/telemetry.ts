import type { ExecutionReport, ReportEvent } from "../src/execution-report.js";
import type { LoopEvent } from "../src/loop.js";
import type { TokenUsage } from "../src/model-usage.js";

type TokenTotals = Pick<TokenUsage, "promptTokens" | "completionTokens" | "totalTokens">;

export type TuiUsage = {
  attemptedRequests: number;
  reportedRequests: number;
  coverage: "none" | "partial" | "complete";
  totals: TokenTotals | null;
  cache: {
    reportedRequests: number;
    /** Only prompts whose responses explicitly report valid cache counters. */
    promptTokens: number | null;
    cachedPromptTokens: number | null;
    hitRate: number | null;
  };
};

export type TuiSummary = {
  modelRequests: { parent: number; children: number };
  tokenUsage: { parent: TuiUsage; children: TuiUsage; total: TuiUsage };
  toolResults: { ok: number; errors: number };
  writes: number;
  commands: number;
  contextReduction: { requests: number; omittedReadResults: number; bytesSaved: number };
};

export type TuiTelemetrySnapshot = {
  /** Consumption in this process, including failed turns and conversations before reset. */
  session: TuiSummary & { turns: number; answered: number; stopped: number };
  turn: TuiSummary & {
    number: number;
    status: "idle" | "running" | "answered" | "stopped";
    stopCode: string | null;
    iteration: number;
  };
  conversation: { completedTurns: number; resets: number };
  /** Latest attempted parent request body; local bytes are not model context tokens. */
  parentRequest: { iteration: number; bytes: number; limitBytes: number; accepted: boolean } | null;
  /** Latest parent request's reported input tokens, cleared before every new request. */
  parentPromptTokens: number | null;
  activeChildIds: string[];
  /** Child activity in the current or most recent turn. */
  children: { started: number; completed: number; stopped: number };
  lastReport: ExecutionReport | null;
};

export type TuiTelemetry = {
  beginTurn(): void;
  observe(event: ReportEvent): void;
  finishTurn(outcome: "answered" | "stopped", stopCode?: string): void;
  resetConversation(completedTurns?: number): void;
  snapshot(): TuiTelemetrySnapshot;
};

function emptyUsage(): TuiUsage {
  return { attemptedRequests: 0, reportedRequests: 0, coverage: "none", totals: null,
    cache: { reportedRequests: 0, promptTokens: null, cachedPromptTokens: null, hitRate: null } };
}

function emptySummary(): TuiSummary {
  return {
    modelRequests: { parent: 0, children: 0 },
    tokenUsage: { parent: emptyUsage(), children: emptyUsage(), total: emptyUsage() },
    toolResults: { ok: 0, errors: 0 }, writes: 0, commands: 0,
    contextReduction: { requests: 0, omittedReadResults: 0, bytesSaved: 0 },
  };
}

function updateCoverage(summary: TuiUsage): void {
  summary.coverage = summary.reportedRequests === 0 ? "none"
    : summary.reportedRequests === summary.attemptedRequests ? "complete" : "partial";
}

function addUsage(summary: TuiUsage, usage: TokenUsage): void {
  if (summary.reportedRequests === 0) {
    summary.totals = { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, totalTokens: usage.totalTokens };
  } else if (summary.totals !== null) {
    const totals = { promptTokens: summary.totals.promptTokens + usage.promptTokens,
      completionTokens: summary.totals.completionTokens + usage.completionTokens,
      totalTokens: summary.totals.totalTokens + usage.totalTokens };
    summary.totals = Object.values(totals).every(Number.isSafeInteger) ? totals : null;
  }
  summary.reportedRequests++;
  updateCoverage(summary);

  const cached = usage.cachedPromptTokens;
  if (cached === undefined || !Number.isSafeInteger(cached) || cached < 0 || cached > usage.promptTokens) return;
  const cache = summary.cache;
  if (cache.reportedRequests === 0) {
    cache.promptTokens = usage.promptTokens;
    cache.cachedPromptTokens = cached;
  } else if (cache.promptTokens !== null && cache.cachedPromptTokens !== null) {
    const prompt = cache.promptTokens + usage.promptTokens;
    const hit = cache.cachedPromptTokens + cached;
    cache.promptTokens = Number.isSafeInteger(prompt) && Number.isSafeInteger(hit) ? prompt : null;
    cache.cachedPromptTokens = cache.promptTokens === null ? null : hit;
  }
  cache.reportedRequests++;
  cache.hitRate = cache.promptTokens !== null && cache.promptTokens > 0 && cache.cachedPromptTokens !== null
    ? cache.cachedPromptTokens / cache.promptTokens : null;
}

/** Observe existing events; this state never becomes model history or authorizes a tool. */
export function createTuiTelemetry(): TuiTelemetry {
  const session: TuiTelemetrySnapshot["session"] = { ...emptySummary(), turns: 0, answered: 0, stopped: 0 };
  let turn: TuiTelemetrySnapshot["turn"] = { ...emptySummary(), number: 0, status: "idle", stopCode: null, iteration: 0 };
  const conversation = { completedTurns: 0, resets: 0 };
  let parentRequest: TuiTelemetrySnapshot["parentRequest"] = null;
  let parentPromptTokens: number | null = null;
  let lastReport: ExecutionReport | null = null;
  const children = new Map<string, "running" | "completed" | "stopped">();
  const sessionWrites = new Set<string>();
  const sessionCommands = new Set<string>();
  const turnWrites = new Set<string>();
  const turnCommands = new Set<string>();

  function clearTurnDetails(): void {
    parentRequest = null;
    parentPromptTokens = null;
    lastReport = null;
    children.clear();
    turnWrites.clear();
    turnCommands.clear();
  }

  function observeLoop(event: LoopEvent, childId?: string): void {
    if (event.type === "subagent_event") {
      const id = childId ? `${childId}/${event.callId}` : event.callId;
      if (!children.has(id)) children.set(id, "running");
      observeLoop(event.event, id);
      return;
    }
    const scope = childId === undefined ? "parent" : "children";
    if (event.type === "model_request") {
      for (const summary of [session, turn]) {
        summary.modelRequests[scope]++;
        for (const usage of [summary.tokenUsage[scope], summary.tokenUsage.total]) {
          usage.attemptedRequests++;
          updateCoverage(usage);
        }
      }
      if (childId === undefined) {
        turn.iteration = event.iteration;
        parentRequest = null;
        parentPromptTokens = null;
      }
    } else if (event.type === "model_input" && childId === undefined) {
      parentRequest = { iteration: event.iteration, bytes: event.bytes, limitBytes: event.limitBytes, accepted: event.accepted };
    } else if (event.type === "model_usage") {
      if (childId === undefined && event.iteration === turn.iteration) parentPromptTokens = event.usage?.promptTokens ?? null;
      if (event.usage !== null) {
        for (const summary of [session, turn]) {
          addUsage(summary.tokenUsage[scope], event.usage);
          addUsage(summary.tokenUsage.total, event.usage);
        }
      }
    } else if (event.type === "context_reduction") {
      for (const summary of [session, turn]) {
        summary.contextReduction.requests++;
        summary.contextReduction.omittedReadResults += event.omittedReadResults;
        summary.contextReduction.bytesSaved += event.beforeBytes - event.afterBytes;
      }
    } else if (event.type === "tool_result") {
      for (const summary of [session, turn]) summary.toolResults[event.ok ? "ok" : "errors"]++;
    } else if (event.type === "write_record") {
      sessionWrites.add(event.record.id);
      turnWrites.add(event.record.id);
      session.writes = sessionWrites.size;
      turn.writes = turnWrites.size;
    } else if (event.type === "shell_record") {
      sessionCommands.add(event.record.id);
      turnCommands.add(event.record.id);
      session.commands = sessionCommands.size;
      turn.commands = turnCommands.size;
    } else if (event.type === "completed" && childId !== undefined) {
      children.set(childId, "completed");
    } else if (event.type === "stopped") {
      if (childId === undefined) turn.stopCode = event.code;
      else children.set(childId, "stopped");
    }
  }

  return {
    beginTurn() {
      if (turn.status === "running") throw new Error("A telemetry turn is already running.");
      session.turns++;
      turn = { ...emptySummary(), number: session.turns, status: "running", stopCode: null, iteration: 0 };
      clearTurnDetails();
    },
    observe(event) {
      if (turn.status !== "running") return;
      if (event.type === "execution_report") lastReport = structuredClone(event.report);
      else observeLoop(event);
    },
    finishTurn(outcome, stopCode) {
      if (turn.status !== "running") return;
      turn.status = outcome;
      turn.stopCode = outcome === "stopped" ? stopCode ?? turn.stopCode ?? "INTERNAL" : null;
      session[outcome]++;
      // Only Session.run resolving confirms that its history was actually committed.
      if (outcome === "answered") conversation.completedTurns++;
    },
    resetConversation(completedTurns = 0) {
      if (turn.status === "running") throw new Error("Cannot reset telemetry while a turn is running.");
      conversation.completedTurns = completedTurns;
      conversation.resets++;
      turn = { ...emptySummary(), number: session.turns, status: "idle", stopCode: null, iteration: 0 };
      clearTurnDetails();
    },
    snapshot() {
      const statuses = [...children.values()];
      return structuredClone({ session, turn, conversation, parentRequest, parentPromptTokens, lastReport,
        activeChildIds: turn.status === "running" ? [...children].filter(([, status]) => status === "running").map(([id]) => id) : [],
        children: { started: children.size, completed: statuses.filter((status) => status === "completed").length,
          stopped: statuses.filter((status) => status === "stopped").length } });
    },
  };
}
